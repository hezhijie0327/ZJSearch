# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The Alibaba Cloud DashScope SDK factory -- ONE module for the family.

Serves ``zjsearch.llm.sdk: dashscope`` (the native ``Generation`` API:
qwen chat with OpenAI-style messages, native thinking via
``reasoning_content``, function calling) AND -- through the same bound
surface -- the family's embeddings (``
TextEmbedding``: text-embedding-v3/v4 with the ``dimension`` width).
The transport is aiohttp-based and async-native (``AioGeneration``), so
the pump streams on the shared network loop like every other family.

Wire mapping notes:
- DashScope speaks OpenAI-ish messages (role/content/tool_calls/
  ``tool_call_id``) -- canonical text messages pass through verbatim; a
  canonical CONTENT-PARTS message (vision shape) has its text parts
  joined (Generation is text-only; the multimodal surface is a separate
  API for a later pass).
- ``incremental_output=True`` streams ``delta.content`` /
  ``delta.reasoning_content`` / ``delta.tool_calls`` fragments in
  OpenAI's accumulation shape -- the openai pump's accumulator reused.
- ``finish_reason`` speaks OpenAI's vocabulary already; the usage object
  reports ``input_tokens`` / ``output_tokens`` (+ cached-token details),
  mapped through the openai usage reader.
"""

import queue
import typing as t

from ..config import dimensions, embedding_passthrough, params

JSON_TIERS = 1
"""DashScope speaks the weaker native ``json_object`` constraint on the
qwen-plus tiers and nothing on the rest -- one attempt, the gate's
brace-scan repair carries the strict cases."""


def _wire_messages(messages: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    """The canonical conversation in DashScope shape: dicts pass through
    verbatim except the internal echo keys are stripped and a canonical
    CONTENT-PARTS message has its text parts joined (Generation is a text
    surface; the multimodal API is a separate SDK class for a later pass)."""
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
    """One DashScope usage object in the canonical shape (the field names
    are input_tokens/output_tokens; cached tokens ride
    input_tokens_details.cached_tokens when the model breaks them out)."""
    raw = _field(response, "usage")
    if not raw:
        return None
    details = _field(raw, "input_tokens_details")
    cached = _field(details, "cached_tokens") if details else None
    return {
        "input": int(_field(raw, "input_tokens", 0) or 0),
        "output": int(_field(raw, "output_tokens", 0) or 0),
        "thoughts": None,
        "cached": int(cached) if cached else 0,
        "cache_write": 0,
    }


def _needs_multimodal(messages: list[dict[str, t.Any]]) -> bool:
    """True when any message carries an IMAGE part -- Generation is a text
    surface; image turns route through the MultiModalConversation API."""
    for message in messages:
        content = message.get("content")
        if isinstance(content, list) and any(part.get("type") == "image_url" for part in content):
            return True
    return False


def _mm_messages(messages: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    """The canonical conversation in MultiModalConversation shape: content
    parts become dashscope mm parts (text stays, the image_url part's url
    flattens one level), string content becomes a one-part text list."""
    out: list[dict[str, t.Any]] = []
    for message in messages:
        wire = {
            k: v
            for k, v in message.items()
            if k not in ("reasoning_blocks", "thought_signature", "encrypted_content", "reasoning_items")
        }
        content = wire.get("content")
        if isinstance(content, str):
            wire["content"] = [{"type": "text", "text": content}]
        elif isinstance(content, list):
            parts: list[dict[str, t.Any]] = []
            for part in content:
                if part.get("type") == "text":
                    parts.append({"type": "text", "text": str(part.get("text") or "")})
                elif part.get("type") == "image_url":
                    image = part.get("image_url")
                    url = image.get("url") if isinstance(image, dict) else image
                    if url:
                        parts.append({"type": "image_url", "image_url": str(url)})
            wire["content"] = parts or [{"type": "text", "text": ""}]
        out.append(wire)
    return out


async def _pump(  # pylint: disable=too-many-locals, too-many-branches, too-many-statements
    sdk: "DashscopeSdk",
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool,
    tools: list[dict[str, t.Any]] | None,
) -> None:
    """The native Generation stream (``stream=True`` +
    ``incremental_output=True``): relay ``delta.content``, the qwen
    ``delta.reasoning_content`` as think events, and ``delta.tool_calls``
    fragments into the openai-shaped accumulator.  The terminal chunk's
    finish_reason and usage land in one ``("finish", meta)`` event."""
    cfg = sdk.cfg
    multimodal = _needs_multimodal(messages)
    if multimodal:
        from dashscope import AioMultiModalConversation  # pylint: disable=import-outside-toplevel

        driver = AioMultiModalConversation
    else:
        from dashscope import AioGeneration  # pylint: disable=import-outside-toplevel

        driver = AioGeneration

    call: dict[str, t.Any] = {
        "api_key": str(cfg.get("api_key") or ""),
        "model": str(cfg.get("model")),
        "messages": _mm_messages(messages) if multimodal else _wire_messages(messages),
        "stream": True,
        "incremental_output": True,
        "result_format": "message",
        **params(cfg),
    }
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
            piece = (getattr(delta, "content", None) if delta is not None else None) or (
                getattr(message, "content", None) if message is not None else None
            )
            if piece:
                events.put(("delta", str(piece)))
            reasoning = getattr(delta, "reasoning_content", None) if delta is not None else None
            if reasoning is None and message is not None:
                reasoning = getattr(message, "reasoning_content", None)
            if relay_reasoning and reasoning:
                events.put(("think", str(reasoning)))
            for tc in (getattr(delta, "tool_calls", None) if delta is not None else None) or []:
                slot = calls.setdefault(
                    tc.index if tc.index is not None else 0, {"id": "", "name": "", "arguments": ""}
                )
                if tc.id:
                    slot["id"] = str(tc.id)
                fn = getattr(tc, "function", None)
                if fn is not None and fn.name:
                    slot["name"] = str(fn.name)
                if fn is not None and fn.arguments:
                    slot["arguments"] += str(fn.arguments)
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
        name: str,  # pylint: disable=unused-argument
        schema: dict[str, t.Any],  # pylint: disable=unused-argument
        strict: bool,  # pylint: disable=unused-argument
    ) -> tuple[str, dict[str, t.Any] | None]:
        """One non-streaming Generation completion.  DashScope's native
        constraint tops out at ``json_object`` (``json_schema`` is not part
        of the Generation API) -- the strict tier degrades to it and the
        gate's brace-scan repair carries the shape."""
        cfg = self.cfg
        from dashscope import Generation  # pylint: disable=import-outside-toplevel

        response = Generation.call(
            api_key=str(cfg.get("api_key") or ""),
            model=str(cfg.get("model")),
            messages=_wire_messages(messages),
            result_format="message",
            response_format={"type": "json_object"},
        )
        usage_meta = _usage_of(response)
        choices = getattr(getattr(response, "output", None), "choices", None) or []
        for choice in choices:
            message = getattr(choice, "message", None)
            if message is not None and getattr(message, "content", None):
                return str(message.content), usage_meta
        return "", usage_meta

    def rerank(self, query: str, docs: list[str]) -> tuple[list[int] | None, int]:
        """One TextReRank call: ``docs`` re-scored against ``query``.
        ``(order, tokens)`` out -- the order is the model's ranking (a
        full permutation of the incoming indices), the tokens the billed
        total; ``(None, 0)`` on any failure (the caller's fail-open)."""
        from dashscope import TextReRank  # pylint: disable=import-outside-toplevel

        response = TextReRank.call(
            api_key=str(self.cfg.get("api_key") or ""),
            model=str(self.cfg.get("model")),
            query=query,
            documents=docs,
            top_n=len(docs),
            return_documents=False,
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
        """One TextEmbedding batch in input order (the width rides
        ``params.dimension``, DashScope's own name for it; the passthrough
        block carries ``text_type`` / ``instruct`` when a model wants
        them).  The API's ``usage.total_tokens`` rides along (the
        embeddings用量 stats)."""
        cfg = self.cfg
        from dashscope import TextEmbedding  # pylint: disable=import-outside-toplevel

        call: dict[str, t.Any] = {
            **embedding_passthrough(cfg),
            "api_key": str(cfg.get("api_key") or ""),
            "model": str(cfg.get("model")),
            "input": [text[:8000] for text in texts],
            "dimension": dimensions(cfg, "dashscope"),
        }
        response = TextEmbedding.call(**call)
        output = getattr(response, "output", None) or {}
        embeddings = output.get("embeddings") if isinstance(output, dict) else None
        if not isinstance(embeddings, list):
            embeddings = []
        ordered = sorted(embeddings, key=lambda item: int(item.get("text_index") or 0) if isinstance(item, dict) else 0)
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
