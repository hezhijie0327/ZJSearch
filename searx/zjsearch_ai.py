# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: the whole-page AI Overview.

The results meta row hosts the entry (``POST /ai/answer``): the client
assembles a numbered source list from the page payload it already has and
the model streams a cited whole-page answer.  The LLM is only called on
click, so a result page loads with zero added latency and the no-JS / RSS
faces of the theme stay untouched.

Design contract:

- This is NOT a plugin (no pre/post_search) -- it registers the route
  itself.  ``install(app)`` is chained from ``zjsearch_stream.install(app)``,
  so webapp.py keeps its single theme hook.
- Stateless across requests: the gate is an HMAC token issued into the
  page-data ``globals`` (``capability()``), not a session; safe with
  multiple granian workers.
- The endpoint streams raw text (``text/plain``); errors before the first
  token answer as clean HTTP statuses (403 / 422 / 502) -- the 502 body
  carries a truncated upstream reason the client renders in the card.
- Transports are the official SDKs: ``AsyncOpenAI`` drives both OpenAI
  dialects (chat completions + Responses API), ``AsyncAnthropic`` the
  Messages API and ``google-genai`` the Gemini API -- all async, on the
  shared network event loop, behind the same queue bridge.  The packages
  (openai / anthropic / google-genai in requirements.txt) are imported
  lazily, so the feature also degrades cleanly when one is absent.
- Configuration lives in the ``zjsearch:`` top-level settings block
  (``zjsearch.ai.*``); everything ships disabled and a deployment opts in.
"""

import asyncio
import base64
import datetime
import functools
import hashlib
import hmac
import importlib.util
import ipaddress
import logging
import os
import queue
import re
import time
import typing as t
from urllib.parse import parse_qs, urljoin, urlsplit

import flask

from searx import settings
from searx.extended_types import sxng_request
from searx.network.client import get_loop
from searx.network.network import Network
from searx.utils import gen_useragent

logger = logging.getLogger("searx.zjsearch_ai")

# ----------------------------------------------------------------- constants

TOKEN_TTL = 3600.0
"""Lifetime of a page-data token: an hour, like the reference design."""

_SECRET = hashlib.sha256(f"zjsearch_ai_{settings.get('server', {}).get('secret_key', '')}".encode()).hexdigest()
"""HMAC key derived once from ``server.secret_key`` at import time."""

FIRST_EVENT_TIMEOUT = 135.0
"""Budget for connect + first token: above the transport's connect=10 /
read=120 guards, so the gate never gives up on a healthy slow model first."""

IDLE_TIMEOUT = 125.0
"""Per-event queue budget while streaming (above the transport's stall
guard, so a silent upstream trips its own timeout first)."""

_SDK_CONNECT_TIMEOUT = 10.0
_SDK_READ_TIMEOUT = 120.0
"""Per-request SDK timeouts (``httpx2.Timeout(120, connect=10)``): on a
streaming request the read value is a stall guard between chunks, not a
total-duration cap."""

_ANTHROPIC_DEFAULT_MAX_TOKENS = 4096
"""The Messages API has no default for ``max_tokens`` -- fills in when
``params.max_tokens`` is unset (reasoning models can burn it on thinking;
raise it there or override via extra_body)."""

_CONTEXT_MAX_CHARS = 16000
"""Hard cap on the client-assembled context (deep 5 + shallow 15 + infobox
lands around 7k; the cap only guards abuse)."""

_IMAGE_MAX_BYTES = 2 * 1024 * 1024
_IMAGE_FETCH_TIMEOUT = 8.0
_MAX_IMAGES = 4

# -------------------------------------------------------------- configuration


def _ai_cfg() -> dict[str, t.Any]:
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

_ENDPOINT_KINDS = ("openai_chat_completions", "anthropic", "openai_responses", "gemini")
"""The ``zjsearch.ai.sdk`` values -- one official SDK per family: AsyncOpenAI
drives both OpenAI dialects, AsyncAnthropic the Messages API, google-genai
the Gemini API."""


def _endpoint(cfg: dict[str, t.Any]) -> tuple[str, str]:
    """The wire dialect (``zjsearch.ai.sdk``) and the ``base_url`` exactly as
    configured -- no rewriting.  Each SDK appends its own method paths to
    the base, so the value is per dialect (see the README): the openai
    dialects take ``https://api.openai.com/v1``, anthropic the bare origin
    (``https://api.anthropic.com``), gemini the origin or a gateway prefix
    that already includes the API name (``https://gw.example.com/gemini``)."""
    kind = str(cfg.get("sdk") or "openai_chat_completions")
    if kind not in _ENDPOINT_KINDS:
        kind = "openai_chat_completions"
    return kind, str(cfg.get("base_url") or "")


def _endpoint_is_local(url: str) -> bool:
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
            api_key=_chat_key(cfg) or ("none" if _endpoint_is_local(base) else ""),
            max_retries=0,
            http_client=_httpx_client(not _endpoint_is_local(base)),
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
            api_key=_chat_key(cfg) or ("none" if _endpoint_is_local(base) else ""),
            max_retries=0,
            http_client=_httpx_client(not _endpoint_is_local(base)),
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
        remote = not _endpoint_is_local(base or "https://generativelanguage.googleapis.com")
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


@functools.lru_cache(maxsize=1)
def _image_network() -> Network:
    """Dedicated curl network for the server-side image fetches.  The default
    network is https-only (``enable_http`` False -- an engine-hardening
    choice); this one keeps the ``outgoing`` proxies / verify / Tor for
    remote endpoints and goes direct for loopback ones."""
    out = settings.get("outgoing", {})
    remote = not _endpoint_is_local(str(_ai_cfg().get("base_url") or ""))
    return Network(
        enable_http=True,
        verify=out.get("verify", True),
        enable_http2=out.get("enable_http2", True),
        max_connections=out.get("pool_connections", 10),
        proxies=out.get("proxies") if remote else None,
        using_tor_proxy=bool(out.get("using_tor_proxy", False)) and remote,
        max_redirects=out.get("max_redirects", 30),
        retries=0,
        logger_name="zjsearch_ai",
    )


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


def _configured(cfg: dict[str, t.Any]) -> bool:
    """True when the feature is on and its transport is fully specified: a
    model and a dialect -- the base_url may stay empty only for the gemini
    dialect (the google-genai default endpoint)."""
    if not cfg.get("enabled") or not cfg.get("model"):
        return False
    kind, base = _endpoint(cfg)
    return bool(base) or kind == "gemini"


def capability() -> dict[str, str] | None:
    """The ``ai`` payload of the page-data globals (token + model label);
    ``None`` when the feature is off or not fully configured."""
    cfg = _ai_cfg()
    if not _configured(cfg):
        return None
    return {"tk": issue_token(), "model": str(cfg.get("model"))}


# -------------------------------------------------------------- image results


def _absolute_url(url: str) -> str:
    """Same-origin relative links (``/image_proxy?url=...`` from the
    page-data) resolve against the instance; everything absolute passes
    through, non-http(s) results are dropped."""
    if url.startswith(("http://", "https://")):
        return url
    joined = urljoin(sxng_request.host_url, url)
    return joined if joined.startswith(("http://", "https://")) else ""


def _proxied_original(url: str) -> str | None:
    """The original image URL embedded in an ``/image_proxy`` link -- fetch
    it directly (the image network applies the outgoing proxies) instead of
    hopping through the instance's own proxy view."""
    parsed = urlsplit(url)
    if not parsed.path.endswith("/image_proxy"):
        return None
    return parse_qs(parsed.query).get("url", [None])[0]


def _check_url(url: str) -> bool:
    """Literal-level gate for server-fetched URLs: http(s) only, no
    loopback / mDNS / internal host names, no IP literals from the
    non-routable ranges.  Same-origin ``/image_proxy`` links are resolved
    by the caller before this gate and stay allowed (the proxy applies
    searx's own upstream validation)."""
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not host:
        return False
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return True  # a regular host name that passed the suffix gate
    return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast)


async def _fetch_image(url: str) -> str:
    """One image as a ``data:`` URL -- ``""`` when the fetch fails, the body
    is too large or the content is not an image.  Runs on the network loop
    (see :py:func:`_fetch_images_b64`)."""
    try:
        resp = await _image_network().request(
            "GET", url, timeout=_IMAGE_FETCH_TIMEOUT, headers={"User-Agent": gen_useragent()}
        )
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_ai: image fetch failed for %r: %r", url, exc)
        return ""
    content = resp.content
    if not content or len(content) > _IMAGE_MAX_BYTES:
        return ""
    mime = str(resp.headers.get("content-type") or "image/jpeg").split(";", maxsplit=1)[0].strip()
    if not mime.startswith("image/"):
        return ""
    return f"data:{mime};base64,{base64.b64encode(content).decode()}"


def _fetch_images_b64(urls: list[str]) -> list[str]:
    """The images as ``data:`` URLs, fetched in parallel -- one round-trip to
    the network loop instead of one per picture (the fetches used to run
    sequentially: up to ``_MAX_IMAGES`` timeouts serialised before the LLM
    call could even start).  Failed slots come back ``""``; each fetch
    carries its own timeout, so the gather never hangs past it."""
    if not urls:
        return []

    async def fetch_all() -> list[str]:
        return list(await asyncio.gather(*(_fetch_image(url) for url in urls)))

    future = asyncio.run_coroutine_threadsafe(fetch_all(), get_loop())
    try:
        return future.result(_IMAGE_FETCH_TIMEOUT * 2)
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_ai: image fetch round failed: %r", exc)
        return [""] * len(urls)


def _image_fetch_candidate(url: str, absolute: str) -> str | None:
    """The server-fetch URL for one client image reference -- ``None`` drops
    it (a rejection is logged).  Same-origin ``/image_proxy`` links carry
    the original URL as their target: fetch it directly through the image
    network (the outgoing proxies apply) instead of hopping through the
    instance's own proxy view; other same-origin references fetch the
    instance itself, no gate."""
    original = _proxied_original(absolute) if url.startswith("/") else None
    if original is not None:
        if _check_url(original):
            return original
        logger.warning("zjsearch_ai: image URL rejected by the SSRF gate: %r", original)
        return None
    if url.startswith("/") or _check_url(absolute):
        return absolute
    logger.warning("zjsearch_ai: image URL rejected by the SSRF gate: %r", absolute)
    return None


def _attached_images(payload: dict[str, t.Any], cfg: dict[str, t.Any]) -> list[dict[str, t.Any]]:
    """OpenAI-shaped ``image_url`` content parts for the attached image
    results -- every dialect pump converts them to its own block shape.  The
    ``images`` setting picks the transport: ``base64`` (the default) fetches
    each picture server-side and inlines it, ``url`` hands the reference to
    the endpoint, anything else disables attachments."""
    mode = str(cfg.get("images", "base64")).lower()
    if mode not in ("base64", "url"):
        return []
    refs = payload.get("images")
    if not isinstance(refs, list):
        return []
    parts: list[dict[str, t.Any]] = []
    fetch_urls: list[str] = []
    for ref in refs:
        if len(parts) + len(fetch_urls) >= _MAX_IMAGES:
            break
        url = str(ref or "").strip()
        absolute = _absolute_url(url)
        if not absolute:
            continue
        if mode == "url":
            parts.append({"type": "image_url", "image_url": {"url": absolute}})
            continue
        candidate = _image_fetch_candidate(url, absolute)
        if candidate is not None:
            fetch_urls.append(candidate)
    if not fetch_urls:
        return parts
    # result lists repeat a host's images -- dedupe, order preserved
    for data in _fetch_images_b64(list(dict.fromkeys(fetch_urls))):
        if data:
            parts.append({"type": "image_url", "image_url": {"url": data}})
    return parts


# ----------------------------------------------------------- dialect streams


def _system_of(messages: list[dict[str, t.Any]]) -> str:
    return "".join(str(m.get("content")) for m in messages if m.get("role") == "system")


def _anthropic_image(part: dict[str, t.Any]) -> dict[str, t.Any]:
    """OpenAI ``image_url`` content part -> Anthropic ``image`` block: the
    Messages API takes inline base64 / a URL source instead of a data URL."""
    url = str((part.get("image_url") or {}).get("url") or "")
    m = re.match(r"^data:(image/[^;,]+);base64,(.*)$", url, re.DOTALL)
    if m:
        return {"type": "image", "source": {"type": "base64", "media_type": m.group(1), "data": m.group(2)}}
    return {"type": "image", "source": {"type": "url", "url": url}}


def _anthropic_message(message: dict[str, t.Any]) -> dict[str, t.Any]:
    """One chat message in Anthropic shape -- text parts already match, only
    image parts need the conversion."""
    content = message.get("content")
    if not isinstance(content, list):
        return message
    parts = [_anthropic_image(p) if p.get("type") == "image_url" else p for p in content]
    return {**message, "content": parts}


def _responses_message(message: dict[str, t.Any]) -> dict[str, t.Any]:
    """One chat message in Responses-API input shape (``input_text`` /
    ``input_image`` content parts); string content passes through."""
    content = message.get("content")
    if not isinstance(content, list):
        return message
    parts: list[dict[str, t.Any]] = []
    for part in content:
        if part.get("type") == "text":
            parts.append({"type": "input_text", "text": part.get("text")})
        elif part.get("type") == "image_url":
            parts.append({"type": "input_image", "image_url": (part.get("image_url") or {}).get("url")})
        else:
            parts.append(part)
    return {**message, "content": parts}


def _gemini_messages(messages: list[dict[str, t.Any]]) -> tuple[t.Any, list[t.Any]]:
    """(system_instruction, contents) in google-genai shape: text parts pass
    through, inline base64 images become ``Part.from_bytes`` blocks -- the
    Gemini API takes no remote image references on this path."""
    from google.genai import types  # pylint: disable=import-outside-toplevel

    system = _system_of(messages)
    contents: list[t.Any] = []
    for message in messages:
        if message.get("role") == "system":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            contents.append(types.Content(role="user", parts=[types.Part(text=str(content))]))
            continue
        parts = []
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
        if parts:
            contents.append(types.Content(role="user", parts=parts))
    return system or None, contents


async def _pump_openai_chat(
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, str | None]]",
    relay_reasoning: bool,
) -> None:
    """The chat-completions dialect: relay ``delta.content``, plus the
    deepseek-style ``reasoning_content`` / openrouter-style ``reasoning``
    extras as think events when ``relay_reasoning`` is set."""
    client = _openai_client(cfg, base)
    stream = await client.chat.completions.create(
        model=str(cfg.get("model")),
        messages=messages,
        stream=True,
        timeout=_sdk_timeout(),
        extra_headers=_extra_headers(cfg),
        extra_body=_extra_body(cfg),
        **_model_kwargs(_params(cfg), "openai_chat_completions"),
    )
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
    finally:
        await stream.close()


async def _pump_openai_responses(
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, str | None]]",
    relay_reasoning: bool,
) -> None:
    """The Responses-API dialect: relay the output text deltas, the reasoning
    text / summary deltas as think events."""
    client = _openai_client(cfg, base)
    stream = await client.responses.create(
        model=str(cfg.get("model")),
        input=[_responses_message(m) for m in messages if m.get("role") != "system"],
        instructions=_system_of(messages) or None,
        stream=True,
        timeout=_sdk_timeout(),
        extra_headers=_extra_headers(cfg),
        extra_body=_extra_body(cfg),
        **_model_kwargs(_params(cfg), "openai_responses"),
    )
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
    finally:
        await stream.close()


async def _pump_anthropic(
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, str | None]]",
    relay_reasoning: bool,
) -> None:
    """The Messages-API dialect: relay ``text_delta`` and -- when
    ``relay_reasoning`` is set -- ``thinking_delta`` events."""
    client = _anthropic_client(cfg, base)
    stream = await client.messages.create(
        model=str(cfg.get("model")),
        system=_system_of(messages) or None,
        messages=[_anthropic_message(m) for m in messages if m.get("role") != "system"],
        stream=True,
        timeout=_sdk_timeout(),
        extra_headers=_extra_headers(cfg),
        extra_body=_extra_body(cfg),
        **_model_kwargs(_params(cfg), "anthropic"),
    )
    try:
        async for event in stream:
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
    finally:
        await stream.close()


async def _pump_gemini(
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, str | None]]",
    relay_reasoning: bool,
) -> None:
    """The Gemini dialect: relay chunk text; thought parts (Gemini 2.5
    thinking) become think events."""
    from google.genai import types  # pylint: disable=import-outside-toplevel

    client = _gemini_client(cfg, base)
    system, contents = _gemini_messages(messages)
    config = types.GenerateContentConfig(system_instruction=system, **_model_kwargs(_params(cfg), "gemini"))
    stream = await client.aio.models.generate_content_stream(
        model=str(cfg.get("model")), contents=contents, config=config
    )
    async for chunk in stream:
        candidates = chunk.candidates or []
        parts = candidates[0].content.parts if candidates and candidates[0].content else []
        for part in parts or []:
            if not part.text:
                continue
            if part.thought:
                if relay_reasoning:
                    events.put(("think", str(part.text)))
            else:
                events.put(("delta", str(part.text)))


async def _llm_pump(
    cfg: dict[str, t.Any],
    kind: str,
    base: str,
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, str | None]]",
    relay_reasoning: bool = False,
) -> None:
    """Drive the dialect's SDK stream and relay it into ``events``; runs on
    the shared network event loop (see :py:class:`_LlmStream`).  SDK client
    construction and request errors land as ("error", ...) events; the pump
    always ends with ("end", None)."""
    try:
        if kind == "anthropic":
            await _pump_anthropic(cfg, base, messages, events, relay_reasoning)
        elif kind == "openai_responses":
            await _pump_openai_responses(cfg, base, messages, events, relay_reasoning)
        elif kind == "gemini":
            await _pump_gemini(cfg, base, messages, events, relay_reasoning)
        else:
            await _pump_openai_chat(cfg, base, messages, events, relay_reasoning)
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_ai: LLM stream error: %s: %s", type(exc).__name__, str(exc)[:300])
        events.put(("error", f"{type(exc).__name__}: {exc}"))
    finally:
        events.put(("end", None))


class _LlmStream:
    """Queue bridge from the shared network event loop to the WSGI thread:
    the pump coroutine pushes events, :py:meth:`next_event` pulls them
    synchronously.  Abandoned streams (client disconnect, idle timeout) are
    cancelled towards the loop, so no request outlives its consumer."""

    def __init__(
        self,
        cfg: dict[str, t.Any],
        messages: list[dict[str, t.Any]],
        relay_reasoning: bool = False,
    ):
        self.events: "queue.Queue[tuple[str, str | None]]" = queue.Queue()
        self.loop = get_loop()
        kind, base = _endpoint(cfg)
        self.task = asyncio.run_coroutine_threadsafe(
            _llm_pump(cfg, kind, base, messages, self.events, relay_reasoning), self.loop
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


# -------------------------------------------------------------- answer view

_ANSWER_SYSTEM_PROMPT = """\
You are the "AI Overview" feature of a search engine: answer the user's
question directly, grounded in the numbered sources provided.
Today is {today}.
Rules:
- Write the answer in {lang}.
- Cite sources right after the statements they support: [1] for one source,
  [1,3] for several. Use [*] only for common knowledge that no source covers.
- Format freely in GitHub-flavored markdown -- the renderer supports all of
  it: "## " section headings, bullet / numbered lists (task lists "- [x]"
  for step checklists), **bold**, ~~strikethrough~~, tables for
  comparisons, > blockquotes for short source quotes, `inline code` and
  fenced code blocks, --- horizontal rules, definition lists ("Term" on
  one line, ": definition" below), emoji shortcodes like :tada: used
  sparingly, and links when a source URL genuinely helps.
- When a diagram clarifies structure or flow better than prose, emit a
  ```mermaid fenced block (flowchart, sequence, state, ER, gantt, pie,
  mindmap, timeline).  Keep diagrams small -- around 15 nodes at most --
  and quote every node label that contains punctuation or parentheses:
  A["降水(雨/雪)"] -- not A[降水(雨/雪)].
- Math typesets as real equations -- write LaTeX: inline $E=mc^2$ or
  display $$\\int_0^1 f(x)\\,dx$$ blocks.  Each formula appears ONCE, in
  LaTeX only -- never repeat it as plain text beside the equation.  No raw
  HTML and no markdown images (![alt](url)) -- visual evidence arrives as
  attachments instead.
- If the sources do not answer the question, say so in one short line and
  answer from common knowledge marked with [*].
- Get to the point in the first sentence. No preamble, no closing remark."""

_ANSWER_USER_PROMPT = "<q>{q}</q>\n<sources>\n{context}\n</sources>"


def _build_answer_messages(
    query: str, context: str, lang: str, image_parts: list[dict[str, t.Any]]
) -> list[dict[str, t.Any]]:
    system = _ANSWER_SYSTEM_PROMPT.format(today=datetime.date.today().isoformat(), lang=lang)
    if image_parts:
        system += (
            "\n- Images are attached after this text; they come from the numbered "
            "sources and may carry relevant visual information."
        )
    user_text = _ANSWER_USER_PROMPT.format(q=query, context=context)
    user: dict[str, t.Any] = (
        {"role": "user", "content": [{"type": "text", "text": user_text}, *image_parts]}
        if image_parts
        else {"role": "user", "content": user_text}
    )
    return [{"role": "system", "content": system}, user]


def _reason_of(payload: str | None) -> str:
    """A one-line, truncated upstream error for the 502 body: the client
    shows it under the answer card's failed label so a broken transport is
    readable in the UI (the full detail stays in the server log).  Tags are
    stripped -- gateways and proxies love answering with HTML error pages,
    and the raw markup would bury the actual message (the <title> text)."""
    text = re.sub(r"<[^>]+>", " ", str(payload or ""))
    text = " ".join(text.split())
    return text[:240] or "upstream returned an empty stream"


def _upstream_error_response(first_kind: str, first: str | None) -> flask.Response:
    """The 502 response for a stream that died before its first token: a
    plain-text body carrying the truncated upstream reason -- the client's
    fetchStream surfaces it under the card's failed label (the full detail
    is already in the server log)."""
    if first_kind == "end":
        logger.warning(
            "zjsearch_ai: upstream produced no answer content -- reasoning-style models can spend very "
            "long on their thinking; disable thinking via zjsearch.ai.extra_body "
            "(e.g. chat_template_kwargs: {'enable_thinking': False}) or set params.max_tokens"
        )
    reason = _reason_of(first) if first_kind == "error" else _reason_of(None)
    resp = flask.Response(f"AI upstream error: {reason}", status=502, mimetype="text/plain")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


def _answer() -> flask.Response:
    """AI Overview: the client assembles the numbered source context from the
    page payload it already has, this view streams the answer.  Reasoning
    deltas are relayed wrapped in ``<think>...</think>`` so the client can
    fold them away."""
    cfg = _ai_cfg()
    if not _configured(cfg):
        flask.abort(404)
    payload = sxng_request.get_json(silent=True) or {}
    if not check_token(str(payload.get("tk") or "")):
        flask.abort(403)
    q = str(payload.get("q") or "").strip()
    context = str(payload.get("context") or "")[:_CONTEXT_MAX_CHARS]
    if not q or not context.strip():
        flask.abort(422)
    lang = str(payload.get("lang") or "").strip()
    if lang in ("", "all", "auto"):
        lang = "en"

    image_parts = _attached_images(payload, cfg)

    def open_stream(with_images: bool) -> _LlmStream:
        return _LlmStream(
            cfg,
            _build_answer_messages(q, context, lang, image_parts if with_images else []),
            relay_reasoning=True,
        )

    stream = open_stream(bool(image_parts))
    first_kind, first = stream.next_event(FIRST_EVENT_TIMEOUT)
    if first_kind == "error" and image_parts:
        # the endpoint rejected the multimodal request (no vision support,
        # or memory pressure) -- degrade to a text-only answer
        logger.warning("zjsearch_ai: image request rejected, retrying text-only")
        stream = open_stream(False)
        first_kind, first = stream.next_event(FIRST_EVENT_TIMEOUT)
    if first_kind not in ("delta", "think") or not first:
        return _upstream_error_response(first_kind, first)

    def generate():
        try:
            started_think = first_kind == "think"
            closed_think = not started_think
            if started_think:
                yield "<think>"
            yield first
            while True:
                kind, text = stream.next_event(IDLE_TIMEOUT)
                if kind not in ("delta", "think"):
                    if started_think and not closed_think:
                        yield "</think>"
                    return
                if kind == "think":
                    if closed_think:
                        continue  # stray reasoning after content: drop it
                    if not started_think:
                        started_think = True
                        yield "<think>"
                else:
                    if not closed_think:
                        closed_think = True
                        yield "</think>"
                yield text or ""
        finally:
            stream.cancel()

    resp = flask.Response(generate(), mimetype="text/plain")
    resp.headers["X-Accel-Buffering"] = "no"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


# -------------------------------------------------------------------- install

_SDK_PACKAGES = {
    "openai_chat_completions": "openai",
    "openai_responses": "openai",
    "anthropic": "anthropic",
    "gemini": "google.genai",
}


def install(app: flask.Flask) -> None:
    """Register the answer route; chained from ``zjsearch_stream.install``
    so webapp.py keeps its one theme entry point.  An enabled-but-incomplete
    configuration or a missing SDK package logs a warning and the feature
    stays off."""
    cfg = _ai_cfg()
    if not cfg.get("enabled"):
        return
    if not _configured(cfg):
        logger.warning("zjsearch.ai is enabled but model/base_url are missing -- AI answers stay off")
        return
    kind = _endpoint(cfg)[0]
    if str(cfg.get("sdk") or "") and cfg.get("sdk") not in _ENDPOINT_KINDS:
        logger.warning("zjsearch.ai: unknown sdk %r -- treating it as openai_chat_completions", cfg.get("sdk"))
    package = _SDK_PACKAGES[kind]
    if importlib.util.find_spec(package) is None:
        logger.warning(
            "zjsearch.ai: the %r transport needs the %r package (see requirements.txt) -- AI answers stay off",
            kind,
            package,
        )
        return
    if settings.get("server", {}).get("secret_key") == "ultrasecretkey":
        logger.warning("zjsearch.ai runs with the default server.secret_key -- answer tokens are forgeable")
    app.add_url_rule("/ai/answer", "zjsearch_ai_answer", _answer, methods=["POST"])
