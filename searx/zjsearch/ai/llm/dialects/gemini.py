# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The google-genai Gemini dialect (``gemini``)."""

import base64
import json
import logging
import re
import queue
import typing as t

from .. import caching, clients, config, usage
from .base import json_args_of, system_of

KIND = "gemini"

logger = logging.getLogger(__name__)

JSON_TIERS = 1
"""one native tier: ``response_json_schema`` (the ``strict`` flag is
accepted and ignored)."""

_MAGIC_THOUGHT_SIGNATURE = b"skip_thought_signature_validator"
"""Gemini 2.5+/3 return ``thoughtSignature`` values on their parts and
VALIDATE that multi-turn conversations (and function-calling loops) echo
them back -- a replayed history without the signatures is rejected.  The
agent loop replays history every turn but does not store the realtime
signatures, so every part this dialect synthesizes carries LobeHub's
magic bypass literal instead (the value Vertex AI also accepts).
@see https://ai.google.dev/gemini-api/docs/thought-signatures"""

_THINKING_CAPABLE = re.compile(r"gemini-(\d+)(?:\.(\d+))?", re.IGNORECASE)
"""Gemini 2.5+ generation models return thought parts when
``thinkingConfig.includeThoughts`` is set; older generations either
ignore or reject the flag, so the native visibility injection is
version-gated (LobeHub's model-version sniff)."""


def _thinking_capable(model: str) -> bool:
    match = _THINKING_CAPABLE.search(model or "")
    if not match:
        return False
    major, minor = int(match.group(1)), int(match.group(2) or 0)
    return major > 2 or (major == 2 and minor >= 5)


def _content_config(
    cfg: dict[str, t.Any],
    system: str | None,
    *,
    native_thinking: bool,
    **extra: t.Any,
) -> t.Any:
    """The GenerateContentConfig of one request: the ``params``-derived
    kwargs plus the NATIVE progressive-thinking visibility -- Gemini does
    not return thought parts unless ``thinkingConfig.includeThoughts`` is
    set (the user's own budget passes through; the JSON gates opt out)."""
    from google.genai import types  # pylint: disable=import-outside-toplevel

    kwargs = caching.model_kwargs(config.params(cfg), KIND, with_native_thinking=native_thinking)
    if native_thinking and _thinking_capable(str(cfg.get("model") or "")):
        thinking = dict(kwargs.get("thinking_config") or {})
        thinking.setdefault("include_thoughts", True)
        kwargs["thinking_config"] = thinking
    return types.GenerateContentConfig(system_instruction=system, **kwargs, **extra)


def _messages(messages: list[dict[str, t.Any]]) -> tuple[t.Any, list[t.Any]]:
    """(system_instruction, contents) in google-genai shape: text parts pass
    through, inline base64 images become ``Part.from_bytes`` blocks -- the
    Gemini API takes no remote image references on this path.  Assistant
    tool calls become ``function_call`` parts (role ``model``), canonical
    ``tool`` results ``function_response`` parts (role ``user``).  Every
    part carries the magic ``thoughtSignature`` bypass -- replayed history
    without echoed signatures is rejected by the API."""
    from google.genai import types  # pylint: disable=import-outside-toplevel

    system = system_of(messages)
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
                            ),
                            thought_signature=_MAGIC_THOUGHT_SIGNATURE,
                        )
                    ],
                )
            )
            continue
        parts: list[t.Any] = []
        for tc in message.get("tool_calls") or []:
            fn = tc.get("function") or {}
            signature_b64 = tc.get("thought_signature")
            signature = base64.b64decode(signature_b64) if signature_b64 else _MAGIC_THOUGHT_SIGNATURE
            parts.append(
                types.Part(
                    function_call=types.FunctionCall(
                        name=str(fn.get("name") or ""), args=json_args_of(fn.get("arguments"))
                    ),
                    thought_signature=signature,
                )
            )
        content = message.get("content")
        if isinstance(content, list):
            for part in content:
                if part.get("type") == "text":
                    parts.append(types.Part(text=str(part.get("text")), thought_signature=_MAGIC_THOUGHT_SIGNATURE))
                elif part.get("type") == "image_url":
                    m = re.match(
                        r"^data:(image/[^;,]+);base64,(.*)$",
                        str((part.get("image_url") or {}).get("url") or ""),
                        re.DOTALL,
                    )
                    if m:
                        parts.append(
                            types.Part(
                                inline_data=types.Blob(data=base64.b64decode(m.group(2)), mime_type=m.group(1)),
                                thought_signature=_MAGIC_THOUGHT_SIGNATURE,
                            )
                        )
                    else:
                        logger.warning("zjsearch_ai: gemini dialect skips a non-inline image part")
        elif content:
            parts.append(types.Part(text=str(content), thought_signature=_MAGIC_THOUGHT_SIGNATURE))
        if parts:
            contents.append(types.Content(role="model" if role == "assistant" else "user", parts=parts))
    return system or None, contents


async def pump(  # pylint: disable=too-many-locals, too-many-branches
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
    the API has no call ids, so stable synthetic ones are assigned.  The
    candidates' ``finishReason`` and ``usageMetadata`` land in one
    terminal ``("finish", meta)`` event."""
    from google.genai import types  # pylint: disable=import-outside-toplevel

    client = clients.gemini_client(cfg, base)
    system, contents = _messages(messages)
    genai_config = _content_config(cfg, system, native_thinking=True)
    if tools:
        # the declarations take an OpenAPI-schema dict; lowercase JSON-schema
        # type names are accepted by the v1beta API
        genai_config.tools = [types.Tool(function_declarations=[types.FunctionDeclaration(**tool) for tool in tools])]
    stream = await client.aio.models.generate_content_stream(
        model=str(cfg.get("model")), contents=contents, config=genai_config
    )
    calls: list[dict[str, str]] = []
    finish: str | None = None
    usage_meta: dict[str, t.Any] | None = None
    try:
        async for chunk in stream:
            meta = getattr(chunk, "usage_metadata", None)
            if meta is not None:
                thoughts = getattr(meta, "thoughts_token_count", None)
                cached = getattr(meta, "cached_content_token_count", None)
                usage_meta = {
                    "input": int(getattr(meta, "prompt_token_count", 0) or 0),
                    "output": int(getattr(meta, "candidates_token_count", 0) or 0),
                    "thoughts": int(thoughts) if thoughts else None,
                    "cached": int(cached) if cached else 0,
                    "cache_write": 0,
                }
            candidates = chunk.candidates or []
            if candidates:
                reason = getattr(candidates[0], "finish_reason", None)
                if reason:
                    name = getattr(reason, "name", None) or str(reason)
                    finish = usage.GEMINI_FINISH_REASONS.get(name, name.lower())
            parts = candidates[0].content.parts if candidates and candidates[0].content else []
            for part in parts or []:
                fc = getattr(part, "function_call", None)
                if fc is not None and getattr(fc, "name", None):
                    call: dict[str, str] = {
                        "id": f"call_{len(calls)}",
                        "name": str(fc.name),
                        "arguments": json.dumps(dict(fc.args or {})),
                    }
                    # Gemini 3 validates that function calls carry their
                    # thought signature back on the next request -- capture
                    # the REAL one (b64 str) for the canonical history
                    signature = getattr(part, "thought_signature", None)
                    if signature:
                        call["thought_signature"] = base64.b64encode(signature).decode()
                    calls.append(call)
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
    events.put(("finish", {"finish": finish, "usage": usage_meta}))


async def json_completion(  # pylint: disable=unused-argument
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    name: str,
    schema: dict[str, t.Any],
    strict: bool,
) -> str:
    client = clients.gemini_client(cfg, base)
    system, contents = _messages(messages)
    # response_json_schema takes a RAW JSON Schema dict (response_schema
    # wants genai's OpenAPI dialect -- the SDK docs redirect standard
    # JSON Schema there); response_mime_type is required alongside
    genai_config = _content_config(
        cfg,
        system,
        native_thinking=False,
        response_mime_type="application/json",
        response_json_schema=schema,
    )
    response = await client.aio.models.generate_content(
        model=str(cfg.get("model")), contents=contents, config=genai_config
    )
    return str(getattr(response, "text", "") or "")
