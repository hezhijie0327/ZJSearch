# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: the shared LLM transport layer of the AI endpoints.

Everything the theme's AI features (``ai/overview.py``, ``ai/search.py``)
need to talk to the configured model: the ``zjsearch.ai`` settings block,
the HMAC page-data token gate, the cached SDK clients for the four wire
dialects (openai chat/responses, anthropic, gemini), the per-dialect
stream pumps and the queue bridge from the shared network event loop to
the WSGI thread.  Every non-underscore name here is the cross-module
surface; the underscored ones are implementation.

Canonical message shape (a chat-completions superset -- features build
messages once, every pump converts to its own wire shape):

- ``{"role": "system"|"user"|"assistant", "content": str | [parts]}``;
  parts are ``{"type": "text", "text": ...}`` or ``{"type": "image_url",
  "image_url": {"url": data-or-remote}}`` -- multimodal is first-class:
  inline ``data:`` URLs are inlined per dialect, remote references pass
  through where the dialect allows them.
- assistant tool calls: ``"tool_calls": [{"id", "type": "function",
  "function": {"name", "arguments"(<json str>)}}]``
- tool results: ``{"role": "tool", "tool_call_id", "name", "content"}``

A turn streams as ``("think"|"delta"|"tool_calls"|"error"|"end", payload)``
queue events.  ``tools`` -- ``{"name", "description", "parameters"}``
specs (one or more), converted per dialect -- makes the pumps collect the model's
tool-call fragments into a single ``("tool_calls", calls)`` event that
closes a clean turn.  Without a spec no dialect can emit calls at all,
so single-turn consumers are unaffected.
"""

import asyncio
import base64
import functools
import hashlib
import importlib.util
import hmac
import ipaddress
import json
import logging
import os
import queue
import re
import time
import typing as t
from urllib.parse import urlsplit

from searx import settings
from searx.network.client import get_loop

logger = logging.getLogger(__name__)

# ----------------------------------------------------------------- constants

TOKEN_TTL = 3600.0
"""Lifetime of a page-data token: an hour, like the reference design."""

_SECRET = hashlib.sha256(f"zjsearch_ai_{settings.get('server', {}).get('secret_key', '')}".encode()).hexdigest()
"""HMAC key derived once from ``server.secret_key`` at import time."""

_SDK_CONNECT_TIMEOUT = 10.0
_SDK_READ_TIMEOUT = 120.0
"""Per-request SDK timeouts (``httpx2.Timeout(120, connect=10)``): on a
streaming request the read value is a stall guard between chunks, not a
total-duration cap."""

_ANTHROPIC_DEFAULT_MAX_TOKENS = 4096
"""The Messages API has no default for ``max_tokens`` -- fills in when
``params.max_tokens`` is unset (reasoning models can burn it on thinking;
raise it there or override via extra_body)."""

# -------------------------------------------------------------- configuration


def ai_cfg() -> dict[str, t.Any]:
    """The ``zjsearch.ai`` settings block.  Read defensively (plain dict
    access): the block is absent unless the deployment defines it."""
    cfg = settings.get("zjsearch", {}).get("ai", {})
    return cfg if isinstance(cfg, dict) else {}


def _chat_key(cfg: dict[str, t.Any]) -> str:
    """The effective API key: the ``api_key`` setting first, then the
    ``ZJSEARCH_AI_KEY`` environment."""
    return str(cfg.get("api_key") or "") or os.environ.get("ZJSEARCH_AI_KEY", "")


def _extra_headers(cfg: dict[str, t.Any]) -> dict[str, str] | None:
    extra = cfg.get("extra_headers")
    return {str(name): str(value) for name, value in extra.items()} if isinstance(extra, dict) else None


def _extra_body(cfg: dict[str, t.Any]) -> dict[str, t.Any] | None:
    return cfg.get("extra_body") if isinstance(cfg.get("extra_body"), dict) else None


def _params(cfg: dict[str, t.Any]) -> dict[str, t.Any]:
    params = cfg.get("params")
    return params if isinstance(params, dict) else {}


def _model_kwargs(params: dict[str, t.Any], kind: str) -> dict[str, t.Any]:
    """The ``params`` entries as SDK create kwargs: ``max_tokens`` translates
    to each API's own key (and fills the Anthropic mandatory default), the
    rest pass through under their SDK names -- including the thinking knobs
    (``reasoning_effort`` / ``reasoning`` / ``thinking`` /
    ``thinking_config``, whichever the chosen SDK speaks)."""
    max_tokens = params.get("max_tokens")
    kwargs = {name: value for name, value in params.items() if name != "max_tokens" and value is not None}
    if kind == "anthropic":
        kwargs["max_tokens"] = int(max_tokens) if max_tokens else _ANTHROPIC_DEFAULT_MAX_TOKENS
    elif kind in ("openai_responses", "gemini"):
        if max_tokens:
            kwargs["max_output_tokens"] = int(max_tokens)
    elif max_tokens:
        kwargs["max_tokens"] = int(max_tokens)
    return kwargs


# ------------------------------------------------------------ SDK transports

ENDPOINT_KINDS = ("openai_chat_completions", "anthropic", "openai_responses", "gemini")
"""The ``zjsearch.ai.sdk`` values -- one official SDK per family: AsyncOpenAI
drives both OpenAI dialects, AsyncAnthropic the Messages API, google-genai
the Gemini API."""


def endpoint(cfg: dict[str, t.Any]) -> tuple[str, str]:
    """The wire dialect (``zjsearch.ai.sdk``) and the ``base_url`` exactly as
    configured -- no rewriting.  Each SDK appends its own method paths to
    the base, so the value is per dialect (see the README): the openai
    dialects take ``https://api.openai.com/v1``, anthropic the bare origin
    (``https://api.anthropic.com``), gemini the origin or a gateway prefix
    that already includes the API name (``https://gw.example.com/gemini``)."""
    kind = str(cfg.get("sdk") or "openai_chat_completions")
    if kind not in ENDPOINT_KINDS:
        kind = "openai_chat_completions"
    return kind, str(cfg.get("base_url") or "")


def endpoint_is_local(url: str) -> bool:
    """True for loopback / internal LLM endpoints (LM Studio, ollama, a
    self-hosted gateway on an ``.internal`` name): those must not go
    through the outgoing proxy / Tor."""
    host = (urlsplit(url).hostname or "").lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


_sdk_http_clients: dict[bool, t.Any] = {}
"""Shared httpx2 clients for the SDK transports, one per remote-ness.  The
openai / anthropic SDKs speak the httpx2 dialect of httpx; the client is
created (and cached) on the shared network loop where the pumps run.
``using_tor_proxy`` is a curl_cffi mechanism -- SDK transports rely on
``outgoing.proxies`` for proxying."""


def _httpx_client(remote: bool) -> t.Any:
    import httpx2  # pylint: disable=import-outside-toplevel

    client = _sdk_http_clients.get(remote)
    if client is None:
        out = settings.get("outgoing", {})
        mounts = {}
        if remote:
            # searx outgoing.proxies values are proxy URLs or LISTS of
            # fallback URLs (the curl engines round-robin the list);
            # httpx2 mounts want one transport per pattern -- the first
            # URL of a list serves
            for pattern, value in dict(out.get("proxies") or {}).items():
                urls = [str(u) for u in (value if isinstance(value, list) else [value]) if u]
                if urls:
                    mounts[str(pattern)] = httpx2.AsyncHTTPTransport(proxy=httpx2.Proxy(urls[0]))
        client = httpx2.AsyncClient(mounts=mounts or None, verify=out.get("verify", True))
        _sdk_http_clients[remote] = client
    return client


@functools.lru_cache(maxsize=1)
def _sdk_timeout() -> t.Any:
    import httpx2  # pylint: disable=import-outside-toplevel

    return httpx2.Timeout(_SDK_READ_TIMEOUT, connect=_SDK_CONNECT_TIMEOUT)


_sdk_clients: dict[tuple[str, str], t.Any] = {}
"""SDK clients cached per family + base -- constructed on the shared network
loop (httpx2 / anyio bind lazily) and reused across requests for the pool."""


def _openai_client(cfg: dict[str, t.Any], base: str) -> t.Any:
    from openai import AsyncOpenAI  # pylint: disable=import-outside-toplevel

    key = ("openai", base)
    client = _sdk_clients.get(key)
    if client is None:
        client = AsyncOpenAI(
            base_url=base or None,
            # the SDKs refuse an empty key at construction -- auth-free local
            # servers (ollama, LM Studio without auth) get a placeholder
            api_key=_chat_key(cfg) or ("none" if endpoint_is_local(base) else ""),
            max_retries=0,
            http_client=_httpx_client(not endpoint_is_local(base)),
        )
        _sdk_clients[key] = client
    return client


def _anthropic_client(cfg: dict[str, t.Any], base: str) -> t.Any:
    from anthropic import AsyncAnthropic  # pylint: disable=import-outside-toplevel

    key = ("anthropic", base)
    client = _sdk_clients.get(key)
    if client is None:
        client = AsyncAnthropic(
            base_url=base or None,
            api_key=_chat_key(cfg) or ("none" if endpoint_is_local(base) else ""),
            max_retries=0,
            http_client=_httpx_client(not endpoint_is_local(base)),
        )
        _sdk_clients[key] = client
    return client


def _gemini_client(cfg: dict[str, t.Any], base: str) -> t.Any:
    from google.genai import types  # pylint: disable=import-outside-toplevel
    from google import genai  # pylint: disable=import-outside-toplevel

    key = ("gemini", base)
    client = _sdk_clients.get(key)
    if client is None:
        api_key = _chat_key(cfg)
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
        out = settings.get("outgoing", {})
        remote = not endpoint_is_local(base or "https://generativelanguage.googleapis.com")
        proxies = dict(out.get("proxies") or {}) if remote and out.get("proxies") else None
        client = genai.Client(
            api_key=api_key or None,
            http_options=types.HttpOptions(
                base_url=base or None,
                headers=headers,
                extra_body=_extra_body(cfg),
                async_client_args={"verify": out.get("verify", True), "mounts": proxies},
            ),
        )
        _sdk_clients[key] = client
    return client


# ------------------------------------------------------------------- the gate


def issue_token() -> str:
    """Stateless ``ts.signature`` token; the page-data payload carries one per
    render and the answer endpoint checks it before doing any work."""
    ts = str(int(time.time()))
    sig = hmac.new(_SECRET.encode(), ts.encode(), hashlib.sha256).hexdigest()
    return f"{ts}.{sig}"


def check_token(token: str) -> bool:
    try:
        ts, sig = token.split(".", 1)
        if time.time() - float(ts) > TOKEN_TTL:
            return False
    except (ValueError, OverflowError):
        return False
    expected = hmac.new(_SECRET.encode(), ts.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


def configured(cfg: dict[str, t.Any]) -> bool:
    """True when the feature is on and its transport is fully specified: a
    model and a dialect -- the base_url may stay empty only for the gemini
    dialect (the google-genai default endpoint)."""
    if not cfg.get("enabled") or not cfg.get("model"):
        return False
    kind, base = endpoint(cfg)
    return bool(base) or kind == "gemini"


def capability() -> dict[str, str] | None:
    """The ``ai`` payload of the page-data globals (token + model label);
    ``None`` when the feature is off or not fully configured."""
    cfg = ai_cfg()
    if not configured(cfg):
        return None
    return {"tk": issue_token(), "model": str(cfg.get("model"))}


def feature_cfg(feature: str) -> dict[str, t.Any]:
    """The ``zjsearch.ai.<feature>`` settings block (absent unless the
    deployment defines it)."""
    cfg = ai_cfg().get(feature)
    return cfg if isinstance(cfg, dict) else {}


def feature_enabled(feature: str) -> bool:
    """The per-feature flag: ``zjsearch.ai.<feature>.enabled`` -- ``True``
    unless explicitly switched off."""
    return bool(feature_cfg(feature).get("enabled", True))


def feature_capability(feature: str) -> dict[str, str] | None:
    """The page-data capability payload for ONE feature (token + model
    label); ``None`` when the feature flag is off or the transport is
    unconfigured -- the client hides the feature's entry point then."""
    if not feature_enabled(feature) or not configured(ai_cfg()):
        return None
    return capability()


def sdk_missing(cfg: dict[str, t.Any]) -> str | None:
    """The missing transport SDK package for the configured dialect, or
    ``None`` when it imports -- the install gate the feature routes
    share (each logs its own wording)."""
    kind = endpoint(cfg)[0]
    package = SDK_PACKAGES[kind]
    if importlib.util.find_spec(package) is None:
        return package
    return None


SDK_PACKAGES = {
    "openai_chat_completions": "openai",
    "openai_responses": "openai",
    "anthropic": "anthropic",
    "gemini": "google.genai",
}


# ----------------------------------------------------------- dialect streams


def _system_of(messages: list[dict[str, t.Any]]) -> str:
    return "".join(str(m.get("content")) for m in messages if m.get("role") == "system")


def _json_object(raw: t.Any) -> dict[str, t.Any]:
    """A tool-call ``arguments`` JSON string as a dict -- malformed or empty
    arguments degrade to ``{}`` (the endpoint re-validates required fields
    and answers a tool error the model can see)."""
    try:
        value = json.loads(str(raw or "") or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _anthropic_image(part: dict[str, t.Any]) -> dict[str, t.Any]:
    """OpenAI ``image_url`` content part -> Anthropic ``image`` block: the
    Messages API takes inline base64 / a URL source instead of a data URL."""
    url = str((part.get("image_url") or {}).get("url") or "")
    m = re.match(r"^data:(image/[^;,]+);base64,(.*)$", url, re.DOTALL)
    if m:
        return {"type": "image", "source": {"type": "base64", "media_type": m.group(1), "data": m.group(2)}}
    return {"type": "image", "source": {"type": "url", "url": url}}


def _anthropic_message(message: dict[str, t.Any]) -> dict[str, t.Any]:
    """One chat message in Anthropic shape: text parts already match, image
    parts convert, and a canonical assistant tool-call message becomes
    ``tool_use`` content blocks."""
    calls = message.get("tool_calls")
    if calls:
        content: list[dict[str, t.Any]] = []
        text = message.get("content")
        if text:
            content.append({"type": "text", "text": str(text)})
        for tc in calls:
            fn = tc.get("function") or {}
            content.append(
                {
                    "type": "tool_use",
                    "id": str(tc.get("id") or ""),
                    "name": str(fn.get("name") or ""),
                    "input": _json_object(fn.get("arguments")),
                }
            )
        return {"role": "assistant", "content": content}
    content = message.get("content")
    if not isinstance(content, list):
        return message
    parts = [_anthropic_image(p) if p.get("type") == "image_url" else p for p in content]
    return {**message, "content": parts}


def _anthropic_messages(messages: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    """The whole conversation in Messages-API shape.  Consecutive canonical
    ``tool`` results fold into ONE user message of ``tool_result`` blocks
    (the API wants every ``tool_use`` answered from the user side)."""
    out: list[dict[str, t.Any]] = []
    tool_blocks: list[dict[str, t.Any]] = []

    def flush() -> None:
        if tool_blocks:
            out.append({"role": "user", "content": list(tool_blocks)})
            tool_blocks.clear()

    for message in messages:
        if message.get("role") == "tool":
            tool_blocks.append(
                {
                    "type": "tool_result",
                    "tool_use_id": str(message.get("tool_call_id") or ""),
                    "content": str(message.get("content") or ""),
                }
            )
            continue
        flush()
        if message.get("role") != "system":
            out.append(_anthropic_message(message))
    flush()
    return out


def _responses_message(message: dict[str, t.Any]) -> dict[str, t.Any]:
    """One chat message in Responses-API input shape (``input_text`` /
    ``input_image`` content parts); string content passes through."""
    content = message.get("content")
    if not isinstance(content, list):
        return message
    parts: list[t.Any] = []
    for part in content:
        if part.get("type") == "text":
            parts.append({"type": "input_text", "text": part.get("text")})
        elif part.get("type") == "image_url":
            parts.append({"type": "input_image", "image_url": (part.get("image_url") or {}).get("url")})
        else:
            parts.append(part)
    return {**message, "content": parts}


def _responses_input(messages: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    """The whole conversation as Responses-API input items: canonical
    assistant tool calls become ``function_call`` items, ``tool`` results
    become ``function_call_output`` items."""
    items: list[dict[str, t.Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            continue
        calls = message.get("tool_calls")
        if calls:
            text = message.get("content")
            if text:
                items.append({"role": "assistant", "content": [{"type": "output_text", "text": str(text)}]})
            for tc in calls:
                fn = tc.get("function") or {}
                items.append(
                    {
                        "type": "function_call",
                        "call_id": str(tc.get("id") or ""),
                        "name": str(fn.get("name") or ""),
                        "arguments": str(fn.get("arguments") or "{}"),
                    }
                )
            continue
        if role == "tool":
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": str(message.get("tool_call_id") or ""),
                    "output": str(message.get("content") or ""),
                }
            )
            continue
        items.append(_responses_message(message))
    return items


def _gemini_messages(messages: list[dict[str, t.Any]]) -> tuple[t.Any, list[t.Any]]:
    """(system_instruction, contents) in google-genai shape: text parts pass
    through, inline base64 images become ``Part.from_bytes`` blocks -- the
    Gemini API takes no remote image references on this path.  Assistant
    tool calls become ``function_call`` parts (role ``model``), canonical
    ``tool`` results ``function_response`` parts (role ``user``)."""
    from google.genai import types  # pylint: disable=import-outside-toplevel

    system = _system_of(messages)
    contents: list[t.Any] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            continue
        if role == "tool":
            contents.append(
                types.Content(
                    role="user",
                    parts=[
                        types.Part(
                            function_response=types.FunctionResponse(
                                name=str(message.get("name") or "tool"),
                                response={"result": str(message.get("content") or "")},
                            )
                        )
                    ],
                )
            )
            continue
        parts: list[t.Any] = []
        for tc in message.get("tool_calls") or []:
            fn = tc.get("function") or {}
            parts.append(
                types.Part(
                    function_call=types.FunctionCall(
                        name=str(fn.get("name") or ""), args=_json_object(fn.get("arguments"))
                    )
                )
            )
        content = message.get("content")
        if isinstance(content, list):
            for part in content:
                if part.get("type") == "text":
                    parts.append(types.Part(text=str(part.get("text"))))
                elif part.get("type") == "image_url":
                    m = re.match(
                        r"^data:(image/[^;,]+);base64,(.*)$",
                        str((part.get("image_url") or {}).get("url") or ""),
                        re.DOTALL,
                    )
                    if m:
                        parts.append(types.Part.from_bytes(data=base64.b64decode(m.group(2)), mime_type=m.group(1)))
                    else:
                        logger.warning("zjsearch_ai: gemini dialect skips a non-inline image part")
        elif content:
            parts.append(types.Part(text=str(content)))
        if parts:
            contents.append(types.Content(role="model" if role == "assistant" else "user", parts=parts))
    return system or None, contents


def _cache_body(cfg: dict[str, t.Any]) -> dict[str, t.Any]:
    """The extra_body with OpenAI's prompt-cache routing key folded in,
    UNCONDITIONALLY: ``prompt_cache_key`` improves the automatic prefix
    cache on the real API and is silently ignored by OpenAI-compatible
    servers that do not know it (LM Studio, vLLM, aggregators) -- the
    prompts here are byte-stable per mode+language by design, which is
    what makes prefix caching applicable anywhere.  Rides extra_body so
    no SDK signature is assumed."""
    body = dict(_extra_body(cfg) or {})
    body.setdefault("prompt_cache_key", "zjsearch-ai")
    return body


def _anthropic_cache_on(cfg: dict[str, t.Any], base: str) -> bool:
    """Whether to mark Anthropic prompt-cache breakpoints: ON for the real
    Anthropic API (``cache_control`` is part of the official block shape;
    the incremental breakpoints are what make the researcher loop cheap --
    each turn re-reads the cached prefix at 0.1x), forced ON/OFF for ANY
    endpoint via the ``zjsearch.ai.cache_control`` setting (an
    Anthropic-format gateway that forwards blocks verbatim usually just
    works; one that validates strictly needs the off switch)."""
    flag = cfg.get("cache_control")
    if isinstance(flag, bool):
        return flag
    return "api.anthropic.com" in (base or "")


def _anthropic_cache_system(system_text: str) -> list[dict[str, t.Any]]:
    """The system prompt as one cache-marked block: the breakpoint pins the
    byte-stable contract (role/identity/citations/markdown/voice -- the
    writer's ~3k tokens) plus the tools spec as the cached prefix."""
    return [{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}]


def _anthropic_cache_tail(messages: list[dict[str, t.Any]]) -> None:
    """Mark the LAST content block of the final message as a cache
    breakpoint (Anthropic's incremental agent-loop pattern): the request
    before it is a prefix-cache hit, the new tail is written.  Anthropic
    allows 4 breakpoints; this design uses 2 (system + tail).  Mutates
    the pump's throwaway message list in place."""
    if not messages:
        return
    content = messages[-1].get("content")
    if isinstance(content, str):
        messages[-1]["content"] = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]
    elif isinstance(content, list) and content:
        content[-1] = {**content[-1], "cache_control": {"type": "ephemeral"}}


async def _pump_openai_chat(
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool,
    tools: list[dict[str, t.Any]] | None = None,
) -> None:
    """The chat-completions dialect: relay ``delta.content``, plus the
    deepseek-style ``reasoning_content`` / openrouter-style ``reasoning``
    extras as think events when ``relay_reasoning`` is set.  With tool
    specs, ``delta.tool_calls`` fragments (keyed by index) accumulate into
    one ``("tool_calls", calls)`` event that closes a clean turn."""
    client = _openai_client(cfg, base)
    extra = {"tools": [{"type": "function", "function": tool} for tool in tools]} if tools else {}
    stream = await client.chat.completions.create(
        model=str(cfg.get("model")),
        messages=messages,
        stream=True,
        timeout=_sdk_timeout(),
        extra_headers=_extra_headers(cfg),
        extra_body=_cache_body(cfg),
        **_model_kwargs(_params(cfg), "openai_chat_completions"),
        **extra,
    )
    calls: dict[int, dict[str, str]] = {}
    try:
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta is None:
                continue
            if relay_reasoning:
                reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                if reasoning:
                    events.put(("think", str(reasoning)))
            if delta.content:
                events.put(("delta", str(delta.content)))
            for tc in delta.tool_calls or []:
                slot = calls.setdefault(
                    tc.index if tc.index is not None else 0, {"id": "", "name": "", "arguments": ""}
                )
                if tc.id:
                    slot["id"] = tc.id
                if tc.function and tc.function.name:
                    slot["name"] = tc.function.name
                if tc.function and tc.function.arguments:
                    slot["arguments"] += tc.function.arguments
        if calls:
            events.put(("tool_calls", [calls[index] for index in sorted(calls)]))
    finally:
        await stream.close()


async def _pump_openai_responses(
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool,
    tools: list[dict[str, t.Any]] | None = None,
) -> None:
    """The Responses-API dialect: relay the output text deltas, the reasoning
    text / summary deltas as think events.  Function-call items stream as
    ``output_item.added`` + ``function_call_arguments.delta`` fragments."""
    client = _openai_client(cfg, base)
    extra: dict[str, t.Any] = {"tools": [dict(tool, type="function") for tool in tools]} if tools else {}
    stream = await client.responses.create(
        model=str(cfg.get("model")),
        input=_responses_input(messages),
        instructions=_system_of(messages) or None,
        stream=True,
        timeout=_sdk_timeout(),
        extra_headers=_extra_headers(cfg),
        extra_body=_cache_body(cfg),
        **_model_kwargs(_params(cfg), "openai_responses"),
        **extra,
    )
    calls: dict[str, dict[str, str]] = {}
    order: list[str] = []
    try:
        async for event in stream:
            event_type = getattr(event, "type", "")
            if event_type == "response.output_text.delta":
                if event.delta:
                    events.put(("delta", str(event.delta)))
            elif relay_reasoning and event_type in (
                "response.reasoning_text.delta",
                "response.reasoning_summary_text.delta",
            ):
                if event.delta:
                    events.put(("think", str(event.delta)))
            elif event_type == "response.output_item.added":
                item = getattr(event, "item", None)
                if item is not None and getattr(item, "type", "") == "function_call":
                    item_id = str(item.id)
                    calls[item_id] = {
                        "id": str(getattr(item, "call_id", "") or item_id),
                        "name": str(item.name or ""),
                        "arguments": "",
                    }
                    order.append(item_id)
            elif event_type == "response.function_call_arguments.delta":
                slot = calls.get(str(getattr(event, "item_id", "")))
                if slot is not None and event.delta:
                    slot["arguments"] += str(event.delta)
        if calls:
            events.put(("tool_calls", [calls[item_id] for item_id in order]))
    finally:
        await stream.close()


async def _pump_anthropic(
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool,
    tools: list[dict[str, t.Any]] | None = None,
) -> None:
    """The Messages-API dialect: relay ``text_delta`` and -- when
    ``relay_reasoning`` is set -- ``thinking_delta`` events.  ``tool_use``
    blocks stream as ``content_block_start`` + ``input_json_delta``
    fragments, collected per block index."""
    client = _anthropic_client(cfg, base)
    extra: dict[str, t.Any] = (
        {
            "tools": [
                {"name": tool["name"], "description": tool["description"], "input_schema": tool["parameters"]}
                for tool in tools
            ]
        }
        if tools
        else {}
    )
    system_text = _system_of(messages)
    system: t.Any = system_text or None
    msgs = _anthropic_messages(messages)
    if _anthropic_cache_on(cfg, base):
        # explicit prompt caching: a breakpoint on the system block pins the
        # byte-stable contract + tools as the cached prefix, one on the last
        # message makes every researcher turn a prefix-hit plus a small tail
        # write (Anthropic's incremental agent-loop pattern; reads 0.1x)
        if system_text:
            system = _anthropic_cache_system(system_text)
        _anthropic_cache_tail(msgs)
    stream = await client.messages.create(
        model=str(cfg.get("model")),
        system=system,
        messages=msgs,
        stream=True,
        timeout=_sdk_timeout(),
        extra_headers=_extra_headers(cfg),
        extra_body=_extra_body(cfg),
        **_model_kwargs(_params(cfg), "anthropic"),
        **extra,
    )
    calls: dict[int, dict[str, str]] = {}
    try:
        async for event in stream:
            if event.type == "content_block_start":
                block = event.content_block
                if getattr(block, "type", "") == "tool_use":
                    calls[event.index] = {"id": str(block.id or ""), "name": str(block.name or ""), "arguments": ""}
                continue
            if event.type != "content_block_delta":
                continue
            delta = event.delta
            # delta is a discriminated union (text_delta / thinking_delta /
            # signature_delta / input_json_delta / citations_delta) -- only
            # the first two carry prose; bare attribute access on the others
            # killed the whole stream (SignatureDelta has no .text)
            if delta.type == "thinking_delta":
                if relay_reasoning and delta.thinking:
                    events.put(("think", str(delta.thinking)))
            elif delta.type == "text_delta" and delta.text:
                events.put(("delta", str(delta.text)))
            elif delta.type == "input_json_delta":
                slot = calls.get(event.index)
                if slot is not None and delta.partial_json:
                    slot["arguments"] += str(delta.partial_json)
        if calls:
            events.put(("tool_calls", [calls[index] for index in sorted(calls)]))
    finally:
        await stream.close()


async def _pump_gemini(
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool,
    tools: list[dict[str, t.Any]] | None = None,
) -> None:
    """The Gemini dialect: relay chunk text; thought parts (Gemini 2.5
    thinking) become think events.  ``functionCall`` parts arrive fully
    formed (no fragment assembly) and collect into one tool_calls event;
    the API has no call ids, so stable synthetic ones are assigned."""
    from google.genai import types  # pylint: disable=import-outside-toplevel

    client = _gemini_client(cfg, base)
    system, contents = _gemini_messages(messages)
    config = types.GenerateContentConfig(system_instruction=system, **_model_kwargs(_params(cfg), "gemini"))
    if tools:
        # the declarations take an OpenAPI-schema dict; lowercase JSON-schema
        # type names are accepted by the v1beta API
        config.tools = [types.Tool(function_declarations=[types.FunctionDeclaration(**tool) for tool in tools])]
    stream = await client.aio.models.generate_content_stream(
        model=str(cfg.get("model")), contents=contents, config=config
    )
    calls: list[dict[str, str]] = []
    try:
        async for chunk in stream:
            candidates = chunk.candidates or []
            parts = candidates[0].content.parts if candidates and candidates[0].content else []
            for part in parts or []:
                fc = getattr(part, "function_call", None)
                if fc is not None and getattr(fc, "name", None):
                    calls.append(
                        {"id": f"call_{len(calls)}", "name": str(fc.name), "arguments": json.dumps(dict(fc.args or {}))}
                    )
                    continue
                if not part.text:
                    continue
                if part.thought:
                    if relay_reasoning:
                        events.put(("think", str(part.text)))
                else:
                    events.put(("delta", str(part.text)))
    finally:
        # a cancelled pump (idle timeout, client disconnect, budget) must
        # not abandon the SDK generator with its HTTP connection open --
        # every sibling pump closes in a finally
        await stream.close()
    if calls:
        events.put(("tool_calls", calls))


async def _llm_pump(
    cfg: dict[str, t.Any],
    kind: str,
    base: str,
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool = False,
    tools: list[dict[str, t.Any]] | None = None,
) -> None:
    """Drive the dialect's SDK stream and relay it into ``events``; runs on
    the shared network event loop (see :py:class:`LlmStream`).  SDK client
    construction and request errors land as ("error", ...) events; the pump
    always ends with ("end", None)."""
    try:
        if kind == "anthropic":
            await _pump_anthropic(cfg, base, messages, events, relay_reasoning, tools)
        elif kind == "openai_responses":
            await _pump_openai_responses(cfg, base, messages, events, relay_reasoning, tools)
        elif kind == "gemini":
            await _pump_gemini(cfg, base, messages, events, relay_reasoning, tools)
        else:
            await _pump_openai_chat(cfg, base, messages, events, relay_reasoning, tools)
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_ai: LLM stream error: %s: %s", type(exc).__name__, str(exc)[:300])
        events.put(("error", f"{type(exc).__name__}: {exc}"))
    finally:
        events.put(("end", None))


class LlmStream:
    """Queue bridge from the shared network event loop to the WSGI thread:
    the pump coroutine pushes events, :py:meth:`next_event` pulls them
    synchronously.  Abandoned streams (client disconnect, idle timeout) are
    cancelled towards the loop, so no request outlives its consumer."""

    def __init__(
        self,
        cfg: dict[str, t.Any],
        messages: list[dict[str, t.Any]],
        relay_reasoning: bool = False,
        tools: list[dict[str, t.Any]] | None = None,
    ):
        self.events: "queue.Queue[tuple[str, t.Any]]" = queue.Queue()
        self.loop = get_loop()
        kind, base = endpoint(cfg)
        self.task = asyncio.run_coroutine_threadsafe(
            _llm_pump(cfg, kind, base, messages, self.events, relay_reasoning, tools), self.loop
        )

    def next_event(self, timeout: float) -> tuple[str, str | None]:
        try:
            kind, payload = self.events.get(timeout=timeout)
        except queue.Empty:
            logger.warning("zjsearch_ai: LLM stream idle timeout")
            return ("error", "LLM stream idle timeout")
        if kind == "error":
            logger.warning("zjsearch_ai: LLM stream error: %s", payload)
        if kind not in ("delta", "think"):
            self.cancel()
        return (kind, payload)

    def cancel(self) -> None:
        if not self.task.done():
            self.loop.call_soon_threadsafe(self.task.cancel)


# ------------------------------------------------------------------- helpers


def reason_of(payload: str | None) -> str:
    """A one-line, truncated upstream error for the 502 body: the client
    shows it under the answer card's failed label so a broken transport is
    readable in the UI (the full detail stays in the server log).  Tags are
    stripped -- gateways and proxies love answering with HTML error pages,
    and the raw markup would bury the actual message (the <title> text)."""
    text = re.sub(r"<[^>]+>", " ", str(payload or ""))
    text = " ".join(text.split())
    return text[:240] or "upstream returned an empty stream"


# ------------------------------------------------- structured-object gates


_JSON_COMPLETION_TIMEOUT = 90.0
"""Wall clock for one native structured-object call (the gates): a
reasoning model may think for a while before emitting its single JSON
payload."""


def json_object_of(text: str) -> dict[str, t.Any] | None:
    """The first JSON object in a completion's text -- the lenient repair pass of
    the belt-and-braces: OpenAI-compatible gateways (LM Studio, vLLM,
    proxies) silently ignore ``response_format``/``output_config``, so the
    payload may arrive fenced or prose-wrapped even under native mode."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        value = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


async def _openai_chat_json(
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    name: str,
    schema: dict[str, t.Any],
    strict: bool,
) -> str:
    client = _openai_client(cfg, base)
    # strict json_schema when the endpoint speaks it; the weaker
    # json_object mode is the second native tier (DeepSeek and friends
    # support it where the full schema is unavailable)
    response_format = (
        {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}}
        if strict
        else {"type": "json_object"}
    )
    response = await client.chat.completions.create(
        model=str(cfg.get("model")),
        messages=messages,
        response_format=response_format,
        timeout=_sdk_timeout(),
        extra_headers=_extra_headers(cfg),
        extra_body=_extra_body(cfg),
        **_model_kwargs(_params(cfg), "openai_chat_completions"),
    )
    if response.choices and response.choices[0].message and response.choices[0].message.content:
        return str(response.choices[0].message.content)
    return ""


async def _openai_responses_json(
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    name: str,
    schema: dict[str, t.Any],
    strict: bool,
) -> str:
    client = _openai_client(cfg, base)
    text_format = (
        {"type": "json_schema", "name": name, "strict": True, "schema": schema} if strict else {"type": "json_object"}
    )
    response = await client.responses.create(
        model=str(cfg.get("model")),
        input=_responses_input(messages),
        instructions=_system_of(messages) or None,
        text={"format": text_format},
        timeout=_sdk_timeout(),
        extra_headers=_extra_headers(cfg),
        extra_body=_extra_body(cfg),
        **_model_kwargs(_params(cfg), "openai_responses"),
    )
    return str(getattr(response, "output_text", "") or "")


async def _anthropic_json(
    cfg: dict[str, t.Any], base: str, messages: list[dict[str, t.Any]], schema: dict[str, t.Any]
) -> str:
    client = _anthropic_client(cfg, base)
    response = await client.messages.create(
        model=str(cfg.get("model")),
        system=_system_of(messages) or None,
        messages=_anthropic_messages(messages),
        output_config={"format": {"type": "json_schema", "schema": schema}},
        timeout=_sdk_timeout(),
        extra_headers=_extra_headers(cfg),
        extra_body=_extra_body(cfg),
        **_model_kwargs(_params(cfg), "anthropic"),
    )
    return "".join(str(block.text) for block in response.content or [] if getattr(block, "type", "") == "text")


async def _gemini_json(
    cfg: dict[str, t.Any], base: str, messages: list[dict[str, t.Any]], schema: dict[str, t.Any]
) -> str:
    from google.genai import types  # pylint: disable=import-outside-toplevel

    client = _gemini_client(cfg, base)
    system, contents = _gemini_messages(messages)
    # response_json_schema takes a RAW JSON Schema dict (response_schema
    # wants genai's OpenAPI dialect -- the SDK docs redirect standard
    # JSON Schema there); response_mime_type is required alongside
    config = types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json",
        response_json_schema=schema,
        **_model_kwargs(_params(cfg), "gemini"),
    )
    response = await client.aio.models.generate_content(model=str(cfg.get("model")), contents=contents, config=config)
    return str(getattr(response, "text", "") or "")


def _stream_plain_text(cfg: dict[str, t.Any], messages: list[dict[str, t.Any]]) -> str:
    """The plain streaming fallback every dialect already speaks (the
    reasoning-aware shape: the relay keeps the queue alive through a
    think phase; only content deltas are collected)."""
    stream = LlmStream(cfg, messages, relay_reasoning=True)
    text = ""
    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        kind, payload = stream.next_event(45.0)
        if kind == "delta":
            text += str(payload or "")
        elif kind in ("error", "end"):
            break
    stream.cancel()
    return text


_json_tier_cache: dict[tuple[str, str], int] = {}
"""``(kind, base)`` -> the native tier a gate should START from (0 =
strict schema, ... , len(attempts) = none of them worked): endpoints
answer capability questions the same way every time, so a rejected
constraint is remembered per endpoint instead of re-paid with a 400 on
every gate call."""


def json_completion(
    cfg: dict[str, t.Any],
    messages: list[dict[str, t.Any]],
    name: str,
    schema: dict[str, t.Any],
) -> dict[str, t.Any] | None:
    """One small structured-object completion (the gates -- clarify, related
    questions, follow-up rewrite): NATIVE structured output per dialect
    with a tiered fallback.  openai chat / responses speak strict
    ``json_schema`` first and the weaker ``json_object`` mode second
    (DeepSeek and friends support the latter where the full schema is
    unavailable); anthropic speaks ``output_config.format``; gemini
    ``response_json_schema``.  Vane's belt-and-braces on top: the payload
    still goes through a lenient brace-scan repair (gateways ignore
    output constraints), and any native failure falls back to the plain
    streaming completion every dialect speaks.  Returns the parsed
    object, or ``None`` (callers fail open)."""
    kind, base = endpoint(cfg)
    if kind == "openai_chat_completions":
        attempts: list[t.Callable[[], t.Any]] = [
            lambda: _openai_chat_json(cfg, base, messages, name, schema, True),
            lambda: _openai_chat_json(cfg, base, messages, name, schema, False),
        ]
    elif kind == "openai_responses":
        attempts = [
            lambda: _openai_responses_json(cfg, base, messages, name, schema, True),
            lambda: _openai_responses_json(cfg, base, messages, name, schema, False),
        ]
    elif kind == "anthropic":
        attempts = [lambda: _anthropic_json(cfg, base, messages, schema)]
    elif kind == "gemini":
        attempts = [lambda: _gemini_json(cfg, base, messages, schema)]
    else:
        attempts = []
    cache_key = (kind, base)
    start = _json_tier_cache.get(cache_key, 0)
    for offset, make in enumerate(attempts[start:], start):
        try:
            text = asyncio.run_coroutine_threadsafe(make(), get_loop()).result(_JSON_COMPLETION_TIMEOUT)
        except Exception as exc:  # pylint: disable=broad-except
            # an endpoint that rejects this constraint (or lacks it) lands
            # here -- the next tier, then the plain fallback, still answer.
            # A 400-class rejection is remembered: capabilities do not
            # flip between calls, so later gates skip straight to the
            # tier that works (transient errors are NOT remembered)
            if getattr(exc, "status_code", None) == 400:
                _json_tier_cache[cache_key] = offset + 1
            logger.warning(
                "zjsearch_ai: native structured output failed (%s: %.140s) -- next tier",
                type(exc).__name__,
                str(exc),
            )
            continue
        value = json_object_of(text) if text else None
        if value is not None:
            _json_tier_cache[cache_key] = offset
            return value
    text = _stream_plain_text(cfg, messages)
    return json_object_of(text) if text else None
