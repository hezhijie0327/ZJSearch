# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The Alibaba Cloud DashScope SDK factory -- ONE module for the family.

Serves ``zjsearch.llm.sdk: dashscope`` (the native ``Generation`` API:
qwen chat with OpenAI-style messages, native thinking via
``reasoning_content``, function calling) AND -- through the same bound
surface -- the family's embeddings (``TextEmbedding``: text-embedding-v3/v4
with the ``dimension`` width).  The transport is aiohttp-based and
async-native (``AioGeneration``), so the pump streams on the shared
network loop like every other family.

The surface is the native text-generation endpoint unless a message
carries an IMAGE part or the deployment sets ``surface: multimodal`` --
then MultiModalConversation, whose native parts are ``{"text": ...}`` /
``{"image": <url>}`` and whose stream chunks carry ``content`` as a parts
list.  The qwen3.8/3.7 plus/flash models are MULTIMODAL-NATIVE: even
text-only turns must ride the mm endpoint (the text-generation path
answers them with a 400 ``url error``).

Wire mapping notes:
- DashScope speaks OpenAI-ish messages (role/content/tool_calls/
  ``tool_call_id``) -- canonical text messages pass through verbatim; a
  canonical CONTENT-PARTS message has its text parts joined (Generation
  is a text-only surface; image parts or ``surface: multimodal`` route
  the call through MultiModalConversation instead).
- ``incremental_output=True`` streams OpenAI's accumulation shape, but
  the fragments ride ``choices[0].MESSAGE`` (role/content/
  ``reasoning_content``/``tool_calls`` -- first fragment carries id+name,
  later ones the ``arguments`` increment plus ``index``), never a
  ``delta``; the pump reads both carriers so openai-shaped gateways keep
  working too.
- ``finish_reason`` speaks OpenAI's vocabulary already (idle chunks say
  the STRING ``"null"``); the usage object reports ``input_tokens`` /
  ``output_tokens`` with the cache hit under
  ``prompt_tokens_details.cached_tokens`` and the thinking spend under
  ``output_tokens_details.reasoning_tokens``.
"""

import asyncio
import queue
import typing as t

from ..config import (
    chat_key,
    dimensions,
    embedding_passthrough,
    extra_body,
    extra_headers,
    params,
    reasoning_passback,
)

JSON_TIERS = 2
"""Two native structured-output attempts: the strict ``json_schema``
constraint first (native Generation speaks it -- name/schema/strict),
the weaker ``json_object`` second (wider model support, the prompt must
name JSON); the gate's brace-scan repair carries the rest."""


def _wire_messages(cfg: dict[str, t.Any], messages: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    """The canonical conversation in DashScope shape: dicts pass through
    verbatim except the internal echo keys are stripped, an assistant turn
    that reasoned echoes its ``reasoning_content`` back when the
    deployment asked for it (``zjsearch.llm.reasoning_passback: true`` --
    qwen3.8's ``preserve_thinking`` defaults true and REQUIRES the full
    echo, GLM's preserved thinking the same; the native wire takes it as
    the message's own field, never folded into content), and a canonical
    CONTENT-PARTS message has its text parts joined (Generation is a text
    surface; the multimodal API is a separate SDK class)."""
    passback = reasoning_passback(cfg)
    out: list[dict[str, t.Any]] = []
    for message in messages:
        wire = {
            k: v
            for k, v in message.items()
            if k not in ("reasoning_blocks", "thought_signature", "encrypted_content", "reasoning_items")
        }
        content = wire.get("content")
        if isinstance(content, list):
            wire["content"] = "\n".join(str(part.get("text") or "") for part in content if part.get("type") == "text")
        if passback and wire.get("role") == "assistant" and message.get("reasoning_blocks"):
            wire["reasoning_content"] = "\n\n".join(
                str(b.get("text") or "") for b in message["reasoning_blocks"] if b.get("text")
            )
        out.append(wire)
    return out


def _field(obj: t.Any, key: str, default: t.Any = None) -> t.Any:
    """One field off a DashScope response: the SDK hands back DICT-shaped
    payloads for some families and attribute objects for others -- both
    read through here."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        value = obj.get(key, default)
        return default if value is None else value
    value = getattr(obj, key, default)
    return default if value is None else value


def _usage_of(response: t.Any) -> dict[str, t.Any] | None:
    """One DashScope usage object in the canonical shape: the totals ride
    ``input_tokens`` / ``output_tokens``, the cache hit lives under
    ``prompt_tokens_details.cached_tokens`` (``input_tokens_details`` only
    breaks input down by modality -- text/image/video, never cache), and
    a reasoning model's thinking spend under
    ``output_tokens_details.reasoning_tokens``."""
    raw = _field(response, "usage")
    if not raw:
        return None
    prompt_details = _field(raw, "prompt_tokens_details") or _field(raw, "input_tokens_details")
    cached = _field(prompt_details, "cached_tokens") if prompt_details else None
    output_details = _field(raw, "output_tokens_details")
    thoughts = _field(output_details, "reasoning_tokens") if output_details else None
    return {
        "input": int(_field(raw, "input_tokens", 0) or 0),
        "output": int(_field(raw, "output_tokens", 0) or 0),
        "thoughts": int(thoughts) if thoughts else None,
        "cached": int(cached) if cached else 0,
        "cache_write": 0,
    }


def _needs_multimodal(cfg: dict[str, t.Any], messages: list[dict[str, t.Any]]) -> bool:
    """True when the run must ride the MultiModalConversation API: any
    message carries an IMAGE part, or the deployment forced the mm
    surface (``zjsearch.llm.surface: multimodal`` -- the qwen3.8/3.7
    plus/flash models are MULTIMODAL-NATIVE: even text-only turns serve
    on the mm endpoint and the text-generation path answers them with a
    400 ``url error``)."""
    if str(cfg.get("surface") or "").strip().lower() == "multimodal":
        return True
    for message in messages:
        content = message.get("content")
        if isinstance(content, list) and any(part.get("type") == "image_url" for part in content):
            return True
    return False


def _mm_messages(cfg: dict[str, t.Any], messages: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    """The canonical conversation in MultiModalConversation shape: content
    parts become the NATIVE dashscope parts -- ``{"text": ...}`` and
    ``{"image": <url>}`` (no ``type`` discriminator; the openai-style
    ``{"type": "image_url", ...}`` part is the COMPATIBLE API's shape and
    the native endpoint rejects it) -- and string content becomes a
    one-part text list.  The reasoning echo rides the same
    ``reasoning_passback`` rule as the text surface (qwen3.8's
    ``preserve_thinking``)."""
    passback = reasoning_passback(cfg)
    out: list[dict[str, t.Any]] = []
    for message in messages:
        wire = {
            k: v
            for k, v in message.items()
            if k not in ("reasoning_blocks", "thought_signature", "encrypted_content", "reasoning_items")
        }
        content = wire.get("content")
        if isinstance(content, str):
            wire["content"] = [{"text": content}]
        elif isinstance(content, list):
            parts: list[dict[str, t.Any]] = []
            for part in content:
                if part.get("type") == "text":
                    parts.append({"text": str(part.get("text") or "")})
                elif part.get("type") == "image_url":
                    image = part.get("image_url")
                    url = image.get("url") if isinstance(image, dict) else image
                    if url:
                        parts.append({"image": str(url)})
            wire["content"] = parts or [{"text": ""}]
        if passback and wire.get("role") == "assistant" and message.get("reasoning_blocks"):
            wire["reasoning_content"] = "\n\n".join(
                str(b.get("text") or "") for b in message["reasoning_blocks"] if b.get("text")
            )
        out.append(wire)
    return out


def _content_text(content: t.Any) -> str:
    """One message content as text: a string passes through; a parts list
    (the mm surface's chunks carry ``content: [{"text": ...}]``) joins its
    text parts."""
    if isinstance(content, list):
        return "".join(str(part.get("text") or "") for part in content if isinstance(part, dict) and part.get("text"))
    return str(content) if content else ""


def _call_extras(cfg: dict[str, t.Any]) -> tuple[dict[str, str], dict[str, t.Any]]:
    """The deployment's escape hatches for one call: ``extra_headers``
    ride the ``headers`` kwarg (the SDK pops it onto the HTTP request),
    ``extra_body`` entries merge into the API parameters -- both verbatim,
    the other families' pattern."""
    return extra_headers(cfg) or {}, extra_body(cfg) or {}


def _tool_fragments(delta: t.Any, message: t.Any) -> list[t.Any]:
    """One chunk's tool_call fragments: the native Generation stream
    accumulates on ``message.tool_calls`` (plain DICT items -- nested wire
    values never become SDK objects), openai-shaped gateways on
    ``delta.tool_calls``.  Both carriers merged; a chunk carries one or
    the other, never both."""
    fragments = list(getattr(delta, "tool_calls", None) or [])
    fragments += list(getattr(message, "tool_calls", None) or [])
    return fragments


def _tc_get(fragment: t.Any, key: str) -> t.Any:
    """One tool_call fragment field, dict- or object-shaped."""
    if isinstance(fragment, dict):
        return fragment.get(key)
    return getattr(fragment, key, None)


def _tc_function(fragment: t.Any) -> tuple[t.Any, t.Any]:
    """A fragment's ``(name, arguments)`` -- the function object may be a
    nested dict (native) or an SDK object."""
    fn = _tc_get(fragment, "function") or {}
    if isinstance(fn, dict):
        return fn.get("name"), fn.get("arguments")
    return getattr(fn, "name", None), getattr(fn, "arguments", None)


async def _pump(  # pylint: disable=too-many-locals, too-many-branches, too-many-statements
    sdk: "DashscopeSdk",
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool,
    tools: list[dict[str, t.Any]] | None,
) -> None:
    """The native stream (``stream=True`` + ``incremental_output=True``):
    relay the message content, the qwen ``reasoning_content`` as think
    events, and the ``tool_calls`` fragments into the openai-shaped
    accumulator (fragments ride the streamed ``message`` on the native
    wire, a ``delta`` on openai-shaped gateways).  The surface is the
    native Generation API unless the messages carry an image part or the
    deployment forced the mm surface -- then MultiModalConversation (its
    chunks carry ``content`` as a parts list).  The terminal chunk's
    finish_reason and usage land in one ``("finish", meta)`` event."""
    cfg = sdk.cfg
    multimodal = _needs_multimodal(cfg, messages)
    if multimodal:
        from dashscope import AioMultiModalConversation  # pylint: disable=import-outside-toplevel

        driver = AioMultiModalConversation
    else:
        from dashscope import AioGeneration  # pylint: disable=import-outside-toplevel

        driver = AioGeneration

    call: dict[str, t.Any] = {
        "api_key": chat_key(cfg),
        "model": str(cfg.get("model")),
        "messages": _mm_messages(cfg, messages) if multimodal else _wire_messages(cfg, messages),
        "stream": True,
        "incremental_output": True,
        "result_format": "message",
        **params(cfg),
    }
    headers, body_extras = _call_extras(cfg)
    if body_extras:
        call.update(body_extras)
    if headers:
        call["headers"] = headers
    if tools:
        call["tools"] = [{"type": "function", "function": tool} for tool in tools]
    # NOTE: the native family has no clean per-call custom-header hook (the
    # other families' extra_headers escape hatch does not map onto the
    # dashscope SDK's request layer) -- a gateway in front of the endpoint
    # owns header shaping here.
    responses = await driver.call(**call)
    calls: dict[int, dict[str, str]] = {}
    finish: str | None = None
    usage_meta: dict[str, t.Any] | None = None
    model: str | None = None
    try:
        async for response in responses:
            # an ERROR rides the stream as a chunk (a gateway that does not
            # proxy the native path answers "url error" with status 400):
            # surface it LOUDLY -- a silent empty stream reads as a model
            # outage and starves the loop's own fail-opens
            status = getattr(response, "status_code", 200)
            if status != 200:
                raise RuntimeError(
                    f"dashscope stream error {status}: {_field(response, 'code', '?')} "
                    f"{str(_field(response, 'message', ''))[:200]}"
                )
            if getattr(response, "usage", None) is not None:
                usage_meta = _usage_of(response)
            reported = str(getattr(response, "model", "") or "") or None
            if reported:
                model = reported
            output = _field(response, "output")
            choices = (
                _field(output, "choices") if isinstance(output, dict) else getattr(output, "choices", None)
            ) or []
            if not choices:
                continue
            choice = choices[0]
            if getattr(choice, "finish_reason", None):
                finish = str(choice.finish_reason)
            delta = getattr(choice, "delta", None)
            message = getattr(choice, "message", None)
            piece = _content_text(getattr(delta, "content", None) if delta is not None else None) or _content_text(
                getattr(message, "content", None) if message is not None else None
            )
            if piece:
                events.put(("delta", piece))
            reasoning = getattr(delta, "reasoning_content", None) if delta is not None else None
            if reasoning is None and message is not None:
                reasoning = getattr(message, "reasoning_content", None)
            if relay_reasoning and reasoning:
                events.put(("think", str(reasoning)))
            for tc in _tool_fragments(delta, message):
                index = _tc_get(tc, "index")
                slot = calls.setdefault(index if index is not None else 0, {"id": "", "name": "", "arguments": ""})
                tc_id = _tc_get(tc, "id")
                if tc_id:
                    slot["id"] = str(tc_id)
                name, arguments = _tc_function(tc)
                if name:
                    slot["name"] = str(name)
                if arguments:
                    slot["arguments"] += str(arguments)
        if calls:
            events.put(("tool_calls", [calls[index] for index in sorted(calls)]))
        events.put(("finish", {"finish": finish, "usage": usage_meta, "model": model}))
    finally:
        close = getattr(responses, "close", None)
        if close is not None:
            result = close()
            if hasattr(result, "__await__"):
                await result


class DashscopeSdk:
    """The bound DashScope family surface: one instance per (config, base)
    binding, covering the native Generation chat/thinking/tools surface
    and the TextEmbedding API."""

    json_tiers = JSON_TIERS
    embeds = True

    def __init__(self, cfg: dict[str, t.Any], base: str, kind: str, family: str):
        self.cfg = cfg
        self.base = base
        self.kind = kind
        self.family = family

    async def pump(
        self,
        messages: list[dict[str, t.Any]],
        events: "queue.Queue[tuple[str, t.Any]]",
        relay_reasoning: bool = False,
        tools: list[dict[str, t.Any]] | None = None,
    ) -> None:
        await _pump(self, messages, events, relay_reasoning, tools)

    async def json_completion(
        self,
        messages: list[dict[str, t.Any]],
        name: str,
        schema: dict[str, t.Any],
        strict: bool,
    ) -> tuple[str, dict[str, t.Any] | None]:
        """One non-streaming completion.  ``strict`` requests the native
        ``json_schema`` constraint (name + schema verbatim -- the gate's
        tier 0); the weaker tier answers plain ``json_object`` and the
        brace-scan repair carries the shape.  A model that rejects
        ``json_schema`` 400s and the gate remembers the tier.  An mm-surfaced
        run (``surface: multimodal`` or an image in the context) rides
        MultiModalConversation, whose message content comes back as a
        parts list."""
        cfg = self.cfg
        headers, body_extras = _call_extras(cfg)
        response_format: dict[str, t.Any] = (
            {"type": "json_schema", "json_schema": {"name": name, "schema": schema, "strict": True}}
            if strict
            else {"type": "json_object"}
        )
        multimodal = _needs_multimodal(cfg, messages)

        def _call() -> t.Any:
            if multimodal:
                from dashscope import MultiModalConversation  # pylint: disable=import-outside-toplevel

                return MultiModalConversation.call(
                    api_key=chat_key(cfg),
                    model=str(cfg.get("model")),
                    messages=_mm_messages(cfg, messages),
                    result_format="message",
                    response_format=response_format,
                    headers=headers or None,
                    **body_extras,
                )
            from dashscope import Generation  # pylint: disable=import-outside-toplevel

            return Generation.call(
                api_key=chat_key(cfg),
                model=str(cfg.get("model")),
                messages=_wire_messages(cfg, messages),
                result_format="message",
                response_format=response_format,
                headers=headers or None,
                **body_extras,
            )

        # the sync SDK call must not occupy the shared network loop (every
        # engine request rides it) -- the round trip goes to a thread
        response = await asyncio.to_thread(_call)
        usage_meta = _usage_of(response)
        choices = getattr(getattr(response, "output", None), "choices", None) or []
        for choice in choices:
            message = getattr(choice, "message", None)
            if message is not None:
                text = _content_text(getattr(message, "content", None))
                if text:
                    return text, usage_meta
        return "", usage_meta

    def rerank(self, query: str, docs: list[str]) -> tuple[list[int] | None, int]:
        """One TextReRank call: ``docs`` re-scored against ``query``.
        ``(order, tokens)`` out -- the order is the model's ranking (a
        full permutation of the incoming indices), the tokens the billed
        total; ``(None, 0)`` on any failure (the caller's fail-open)."""
        from dashscope import TextReRank  # pylint: disable=import-outside-toplevel

        headers, body_extras = _call_extras(self.cfg)
        response = TextReRank.call(
            api_key=str(self.cfg.get("api_key") or ""),
            model=str(self.cfg.get("model")),
            query=query,
            documents=docs,
            top_n=len(docs),
            return_documents=False,
            headers=headers or None,
            **body_extras,
        )
        output = _field(response, "output")
        results = _field(output, "results") if isinstance(output, dict) else getattr(output, "results", None)
        results = results or []
        order: list[int] = []
        for item in results:
            index = _field(item, "index", -1)
            try:
                index = int(index)
            except (TypeError, ValueError):
                continue
            if 0 <= index < len(docs) and index not in order:
                order.append(index)
        if not order:
            return None, 0
        order += [i for i in range(len(docs)) if i not in set(order)]
        usage = _field(response, "usage")
        tokens = int(_field(usage, "total_tokens", 0) or 0) if usage else 0
        return order, tokens

    async def embed(self, texts: list[str]) -> tuple[list[list[float]], dict[str, t.Any] | None]:
        """One embedding batch in input order (the width rides
        ``params.dimension``, DashScope's own name for it; the passthrough
        block carries ``text_type`` / ``output_type`` / ``instruct`` when a
        model wants them).  The usage ``total_tokens`` rides along (the
        embeddings用量 stats).  ``surface: multimodal`` routes through
        MultiModalEmbedding instead -- its input items are
        ``{"text": ...}`` parts and its results key on ``index`` (the text
        class keys on ``text_index``); there the dimension kwarg goes out
        ONLY when the params set one (several mm models fix their width
        and reject the parameter)."""
        cfg = self.cfg
        multimodal = str(cfg.get("surface") or "").strip().lower() == "multimodal"

        def _call() -> t.Any:
            if multimodal:
                from dashscope import MultiModalEmbedding  # pylint: disable=import-outside-toplevel

                headers, body_extras = _call_extras(cfg)
                call: dict[str, t.Any] = {
                    **embedding_passthrough(cfg),
                    **body_extras,
                    "api_key": str(cfg.get("api_key") or ""),
                    "model": str(cfg.get("model")),
                    "input": [{"text": text[:8000]} for text in texts],
                }
                block_params = cfg.get("params") if isinstance(cfg.get("params"), dict) else {}
                width = block_params.get("dimension")
                if width is not None:
                    call["dimension"] = int(width)
                if headers:
                    call["headers"] = headers
                return MultiModalEmbedding.call(**call)

            from dashscope import TextEmbedding  # pylint: disable=import-outside-toplevel

            headers, body_extras = _call_extras(cfg)
            call = {
                **embedding_passthrough(cfg),
                **body_extras,
                "api_key": str(cfg.get("api_key") or ""),
                "model": str(cfg.get("model")),
                "input": [text[:8000] for text in texts],
                "dimension": dimensions(cfg, "dashscope"),
            }
            if headers:
                call["headers"] = headers
            return TextEmbedding.call(**call)

        # the sync SDK call must not occupy the shared network loop (every
        # engine request rides it) -- the round trip goes to a thread
        response = await asyncio.to_thread(_call)
        output = getattr(response, "output", None) or {}
        embeddings = output.get("embeddings") if isinstance(output, dict) else None
        if not isinstance(embeddings, list):
            embeddings = []
        ordered = sorted(
            embeddings,
            key=lambda item: (
                int((item.get("text_index") if item.get("text_index") is not None else item.get("index")) or 0)
                if isinstance(item, dict)
                else 0
            ),
        )
        vectors = [
            list(item.get("embedding") or []) if isinstance(item, dict) else list(item or []) for item in ordered
        ]
        reported = getattr(response, "usage", None)
        total = int(_field(reported, "total_tokens", 0) or 0) if reported else 0
        meta = {"input": total} if total else None
        return vectors, meta


def factory(cfg: dict[str, t.Any], base: str, kind: str, family: str = "dashscope") -> DashscopeSdk:
    """The DashScope family factory: config + base bound into one callable
    surface.  ``base`` (``zjsearch.llm.base_url``) overrides the SDK's
    default DashScope endpoint when set -- the SDK's global
    ``base_http_api_url`` is process-wide, so it is set HERE (idempotent
    per identical base) instead of per call.  VERBATIM, like every other
    family's base_url: a DashScope base includes its own ``/api/v1``
    (the intl endpoint ``https://dashscope-intl.aliyuncs.com/api/v1``
    being the second official value)."""
    if base:
        import dashscope  # pylint: disable=import-outside-toplevel

        dashscope.base_http_api_url = base.rstrip("/")
    return DashscopeSdk(cfg, base, kind, family)
