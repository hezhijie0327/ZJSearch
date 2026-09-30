# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The openai Responses-API dialect (``openai_responses``)."""

import queue
import typing as t

from .. import caching, clients, config, usage
from .base import system_of

KIND = "openai_responses"

JSON_TIERS = 2
"""strict ``json_schema`` first, the weaker ``json_object`` mode second."""


def _message(message: dict[str, t.Any]) -> dict[str, t.Any]:
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


def _input(messages: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    """The whole conversation as Responses-API input items: canonical
    assistant tool calls become ``function_call`` items, ``tool`` results
    become ``function_call_output`` items.  A reasoning turn's captured
    reasoning items (encrypted content included) are echoed back VERBATIM
    ahead of the function calls -- the API enforces the pairing."""
    items: list[dict[str, t.Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            continue
        calls = message.get("tool_calls")
        if calls:
            for reasoning_item in message.get("reasoning_items") or []:
                if isinstance(reasoning_item, dict) and reasoning_item.get("type") == "reasoning":
                    items.append(reasoning_item)
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
        items.append(_message(message))
    return items


async def pump(  # pylint: disable=too-many-branches, too-many-locals
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool,
    tools: list[dict[str, t.Any]] | None = None,
) -> None:
    """The Responses-API dialect: relay the output text deltas, the reasoning
    text / summary deltas as think events.  Function-call items stream as
    ``output_item.added`` + ``function_call_arguments.delta`` fragments.
    The terminal response event's status and usage land in one
    ``("finish", meta)`` event (``max_output_tokens`` maps to ``length``)."""
    client = clients.openai_client(cfg, base)
    extra: dict[str, t.Any] = {"tools": [dict(tool, type="function") for tool in tools]} if tools else {}
    stream = await client.responses.create(
        model=str(cfg.get("model")),
        input=_input(messages),
        instructions=system_of(messages) or None,
        stream=True,
        timeout=clients.sdk_timeout(),
        extra_headers=config.extra_headers(cfg),
        extra_body=caching.cache_body(cfg),
        **caching.model_kwargs(config.params(cfg), KIND),
        **extra,
    )
    calls: dict[str, dict[str, str]] = {}
    order: list[str] = []
    finish: str | None = None
    usage_meta: dict[str, t.Any] | None = None
    model: str | None = None
    reasoning_items: list[dict[str, t.Any]] = []
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
            elif event_type in ("response.completed", "response.incomplete"):
                response = getattr(event, "response", None)
                if response is not None:
                    # the API-REPORTED model id (what the endpoint actually ran)
                    model = str(getattr(response, "model", "") or "") or None
                    if getattr(response, "usage", None) is not None:
                        usage_meta = usage.openai_usage(response.usage)
                    # the REASONING output items ride the terminal response --
                    # function-calling turns must ECHO them back on the next
                    # request (the API enforces the pairing), so capture them
                    # verbatim for the canonical history
                    for output in getattr(response, "output", None) or []:
                        if str(getattr(output, "type", "") or "") == "reasoning":
                            try:
                                reasoning_items.append(output.model_dump(exclude_none=True))
                            except Exception:  # pylint: disable=broad-except
                                pass
                    incomplete = getattr(response, "incomplete_details", None)
                    reason = str(getattr(incomplete, "reason", "") or "") if incomplete else ""
                    finish = "length" if reason == "max_output_tokens" else (reason or "stop")
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
        events.put(
            (
                "finish",
                {"finish": finish, "usage": usage_meta, "reasoning_items": reasoning_items or None, "model": model},
            )
        )
    finally:
        await stream.close()


async def json_completion(
    cfg: dict[str, t.Any],
    base: str,
    messages: list[dict[str, t.Any]],
    name: str,
    schema: dict[str, t.Any],
    strict: bool,
) -> str:
    client = clients.openai_client(cfg, base)
    text_format = (
        {"type": "json_schema", "name": name, "strict": True, "schema": schema} if strict else {"type": "json_object"}
    )
    response = await client.responses.create(
        model=str(cfg.get("model")),
        input=_input(messages),
        instructions=system_of(messages) or None,
        text={"format": text_format},
        timeout=clients.sdk_timeout(),
        extra_headers=config.extra_headers(cfg),
        extra_body=config.extra_body(cfg),
        **caching.model_kwargs(config.params(cfg), KIND),
    )
    return str(getattr(response, "output_text", "") or "")
