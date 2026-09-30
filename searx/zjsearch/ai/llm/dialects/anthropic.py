# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The Anthropic Messages-API dialect (``anthropic``)."""

import re
import queue
import typing as t

from anthropic import BadRequestError, UnprocessableEntityError  # pylint: disable=import-outside-toplevel

from .. import caching, clients, config, usage
from .base import json_args_of, system_of

KIND = "anthropic"

JSON_TIERS = 1
"""one native tier: ``output_config.format`` speaks strict json_schema and
has no weaker native mode (the ``strict`` flag is accepted and ignored)."""


def _image(part: dict[str, t.Any]) -> dict[str, t.Any]:
    """OpenAI ``image_url`` content part -> Anthropic ``image`` block: the
    Messages API takes inline base64 / a URL source instead of a data URL."""
    url = str((part.get("image_url") or {}).get("url") or "")
    m = re.match(r"^data:(image/[^;,]+);base64,(.*)$", url, re.DOTALL)
    if m:
        return {"type": "image", "source": {"type": "base64", "media_type": m.group(1), "data": m.group(2)}}
    return {"type": "image", "source": {"type": "url", "url": url}}


def _message(message: dict[str, t.Any], thinking_on: bool) -> dict[str, t.Any]:
    """One chat message in Anthropic shape: text parts already match, image
    parts convert, and a canonical assistant tool-call message becomes
    ``tool_use`` content blocks."""
    calls = message.get("tool_calls")
    if calls:
        content: list[dict[str, t.Any]] = []
        if thinking_on:
            # a tool-use turn that reasoned REPLAYS its thinking blocks
            # (text + signature) ahead of everything else -- the API
            # validates the echo and rejects the request without it
            for block in message.get("reasoning_blocks") or []:
                if block.get("text") and block.get("signature"):
                    content.append(
                        {
                            "type": "thinking",
                            "thinking": str(block["text"]),
                            "signature": str(block["signature"]),
                        }
                    )
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
                    "input": json_args_of(fn.get("arguments")),
                }
            )
        return {"role": "assistant", "content": content}
    content = message.get("content")
    if not isinstance(content, list):
        return message
    parts = [_image(p) if p.get("type") == "image_url" else p for p in content]
    return {**message, "content": parts}


def _messages(messages: list[dict[str, t.Any]], thinking_on: bool) -> list[dict[str, t.Any]]:
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
            out.append(_message(message, thinking_on))
    flush()
    return out


async def pump(  # pylint: disable=too-many-branches, too-many-locals, too-many-statements
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
    fragments, collected per block index.  The message's ``stop_reason``
    and usage land in one terminal ``("finish", meta)`` event."""
    client = clients.anthropic_client(cfg, base)
    tool_specs: list[dict[str, t.Any]] = (
        [
            {"name": tool["name"], "description": tool["description"], "input_schema": tool["parameters"]}
            for tool in tools
        ]
        if tools
        else []
    )
    system_text = system_of(messages)
    system: t.Any = system_text or None
    wire_kwargs = caching.model_kwargs(config.params(cfg), KIND)
    thinking_on = (
        isinstance(wire_kwargs.get("thinking"), dict) and str(wire_kwargs["thinking"].get("type")) == "enabled"
    )
    msgs = _messages(messages, thinking_on)
    if caching.anthropic_cache_on(cfg):
        # explicit prompt caching, LobeChat's THREE anchors (system, last
        # tool, last message -- 3 of Anthropic's 4 breakpoints, no
        # bookkeeping): the tools spec is the run's biggest byte-stable
        # prefix and the last-tool marker anchors it ahead of the system
        # block; the tail breakpoint makes every researcher turn a
        # prefix-hit plus a small tail write
        if system_text:
            system = caching.anthropic_cache_system(system_text)
        if tool_specs:
            tool_specs[-1] = {**tool_specs[-1], "cache_control": {"type": "ephemeral"}}
        caching.anthropic_cache_tail(msgs)
    extra: dict[str, t.Any] = {"tools": tool_specs} if tool_specs else {}
    kwargs: dict[str, t.Any] = {
        "model": str(cfg.get("model")),
        "system": system,
        "messages": msgs,
        "stream": True,
        "timeout": clients.sdk_timeout(),
        "extra_headers": config.extra_headers(cfg),
        "extra_body": config.extra_body(cfg),
        **wire_kwargs,
        **extra,
    }
    try:
        stream = await client.messages.create(**kwargs)
    except (BadRequestError, UnprocessableEntityError):
        # an endpoint that rejects the NATIVE thinking default (gateways to
        # non-Anthropic backends mostly) still streams -- retry once without
        # it AND without the reasoning echo (the echo is only valid when the
        # request enables thinking).  A user-SET thinking param that errors
        # lands here too: their configuration is simply not supported by
        # the endpoint.
        kwargs.pop("thinking", None)
        kwargs["messages"] = _messages(messages, False)
        stream = await client.messages.create(**kwargs)
    calls: dict[int, dict[str, str]] = {}
    finish: str | None = None
    input_tokens = 0
    output_tokens = 0
    cached_tokens = 0
    cache_write_tokens = 0
    model: str | None = None
    thinking_blocks: list[dict[str, str]] = []
    current_thinking: dict[str, str] | None = None
    try:
        async for event in stream:
            if event.type == "message_start":
                usage_meta = getattr(event.message, "usage", None)
                # the API-REPORTED model id (what the endpoint actually ran)
                model = str(getattr(event.message, "model", "") or "") or None
                if usage_meta is not None:
                    input_tokens = int(getattr(usage_meta, "input_tokens", 0) or 0)
                    # the cache counters ride message_start (reads at 0.1x,
                    # writes at 1.25x -- the incremental agent-loop pattern's
                    # whole point is a fat read number here)
                    cached_tokens = int(getattr(usage_meta, "cache_read_input_tokens", 0) or 0)
                    cache_write_tokens = int(getattr(usage_meta, "cache_creation_input_tokens", 0) or 0)
                continue
            if event.type == "message_delta":
                usage_meta = getattr(event, "usage", None)
                if usage_meta is not None and getattr(usage_meta, "output_tokens", None):
                    output_tokens = int(usage_meta.output_tokens or 0)
                stop_reason = getattr(event.delta, "stop_reason", None)
                if stop_reason:
                    finish = usage.ANTHROPIC_STOP_REASONS.get(str(stop_reason), str(stop_reason))
                continue
            if event.type == "content_block_start":
                block = event.content_block
                if getattr(block, "type", "") == "tool_use":
                    calls[event.index] = {"id": str(block.id or ""), "name": str(block.name or ""), "arguments": ""}
                elif getattr(block, "type", "") == "thinking":
                    # capture the thinking BLOCK (text + signature): the
                    # Messages API validates that a tool-use turn replays its
                    # thinking blocks on the next request
                    current_thinking = {"text": "", "signature": ""}
                continue
            if event.type == "content_block_stop":
                if current_thinking is not None:
                    thinking_blocks.append(current_thinking)
                    current_thinking = None
                continue
            if event.type != "content_block_delta":
                continue
            delta = event.delta
            # delta is a discriminated union (text_delta / thinking_delta /
            # signature_delta / input_json_delta / citations_delta) -- only
            # the first two carry prose; bare attribute access on the others
            # killed the whole stream (SignatureDelta has no .text)
            if delta.type == "thinking_delta":
                if current_thinking is not None:
                    current_thinking["text"] += str(delta.thinking or "")
                if relay_reasoning and delta.thinking:
                    events.put(("think", str(delta.thinking)))
            elif delta.type == "signature_delta":
                if current_thinking is not None and delta.signature:
                    current_thinking["signature"] += str(delta.signature)
            elif delta.type == "text_delta" and delta.text:
                events.put(("delta", str(delta.text)))
            elif delta.type == "input_json_delta":
                slot = calls.get(event.index)
                if slot is not None and delta.partial_json:
                    slot["arguments"] += str(delta.partial_json)
        if calls:
            events.put(("tool_calls", [calls[index] for index in sorted(calls)]))
        usage_meta = (
            {
                "input": input_tokens,
                "output": output_tokens,
                "thoughts": None,
                "cached": cached_tokens,
                "cache_write": cache_write_tokens,
                # the thinking blocks ride the finish meta so the agent loop
                # can echo them back on the next request (signature included)
                "thinking_blocks": thinking_blocks,
            }
            if (input_tokens or output_tokens)
            else None
        )
        events.put(("finish", {"finish": finish, "usage": usage_meta, "model": model}))
    finally:
        await stream.close()


async def json_completion(  # pylint: disable=unused-argument
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    name: str,
    schema: dict[str, t.Any],
    strict: bool,
) -> str:
    client = clients.anthropic_client(cfg, base)
    response = await client.messages.create(
        model=str(cfg.get("model")),
        system=system_of(messages) or None,
        messages=_messages(messages, False),
        output_config={"format": {"type": "json_schema", "schema": schema}},
        timeout=clients.sdk_timeout(),
        extra_headers=config.extra_headers(cfg),
        extra_body=config.extra_body(cfg),
        **caching.model_kwargs(config.params(cfg), KIND, with_native_thinking=False),
    )
    return "".join(str(block.text) for block in response.content or [] if getattr(block, "type", "") == "text")
