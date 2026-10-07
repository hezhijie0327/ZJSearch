# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The OpenAI SDK factory -- ONE module for the whole family.

The factory binds deployment config + base_url into an :class:`OpenaiSdk`
whose surface covers everything the family can do: the two chat wire
shapes (``openai.chat_completions`` and ``openai.responses`` -- the bare
``openai`` sdk value points at the Responses shape), native structured
output in two tiers, and the embeddings API.  The wire internals port
from the former dialect modules unchanged -- only the binding moved.
"""

import queue
import typing as t

from .. import caching, usage
from ..config import dimensions, embedding_passthrough, extra_body, extra_headers, params, reasoning_passback
from . import clients
from .base import system_of

CHAT_KIND = "openai.chat_completions"
RESPONSES_KIND = "openai.responses"
JSON_TIERS = 2


def _chat_wire_messages(cfg: dict[str, t.Any], messages: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    """The canonical conversation in chat-completions wire shape: the dicts
    go over the wire verbatim EXCEPT the internal ``reasoning_blocks`` /
    ``thought_signature`` keys are stripped, and an assistant turn that
    reasoned echoes its ``reasoning_content`` back when the deployment
    asked for it (``zjsearch.ai.reasoning_passback: true``)."""
    passback = reasoning_passback(cfg)
    out: list[dict[str, t.Any]] = []
    for message in messages:
        wire = {k: v for k, v in message.items() if k not in ("reasoning_blocks", "thought_signature")}
        for tc in wire.get("tool_calls") or []:
            if isinstance(tc, dict):
                tc.pop("thought_signature", None)
        if wire.get("role") == "assistant" and message.get("encrypted_content"):
            # doubao's encrypted 思考原文: tool loops MUST echo it back
            # verbatim, and it takes priority over the summary text
            wire["encrypted_content"] = message["encrypted_content"]
        if passback and wire.get("role") == "assistant" and wire.get("tool_calls") and message.get("reasoning_blocks"):
            wire["reasoning_content"] = "\n\n".join(
                str(b.get("text") or "") for b in message["reasoning_blocks"] if b.get("text")
            )
        out.append(wire)
    return out


async def _chat_pump(  # pylint: disable=too-many-branches, too-many-locals
    sdk: "OpenaiSdk",
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool,
    tools: list[dict[str, t.Any]] | None,
) -> None:
    """The chat-completions wire shape: relay ``delta.content``, plus the
    deepseek-style ``reasoning_content`` / openrouter-style ``reasoning``
    extras as think events when ``relay_reasoning`` is set.  With tool
    specs, ``delta.tool_calls`` fragments (keyed by index) accumulate into
    one ``("tool_calls", calls)`` event that closes a clean turn.  The
    stream's ``finish_reason`` and the usage chunk land in one terminal
    ``("finish", meta)`` event.  The usage chunk rides ``stream_options``
    include_usage per the OpenAI contract -- whatever the endpoint reports
    (cache hits included) is rendered; one that rejects the parameter
    outright still streams -- one retry without it, stats simply absent."""
    from openai import BadRequestError, UnprocessableEntityError  # pylint: disable=import-outside-toplevel

    cfg = sdk.cfg
    client = clients.openai_client(cfg, sdk.base, family=sdk.family)
    extra = {"tools": [{"type": "function", "function": tool} for tool in tools]} if tools else {}
    kwargs: dict[str, t.Any] = {
        "model": str(cfg.get("model")),
        "messages": _chat_wire_messages(cfg, messages),
        "stream": True,
        "timeout": clients.sdk_timeout(),
        "extra_headers": extra_headers(cfg),
        "extra_body": caching.cache_body(cfg),
        **caching.model_kwargs(params(cfg), CHAT_KIND),
        **extra,
        "stream_options": {"include_usage": True},
    }
    try:
        stream = await client.chat.completions.create(**kwargs)
    except (BadRequestError, UnprocessableEntityError):
        kwargs.pop("stream_options", None)
        stream = await client.chat.completions.create(**kwargs)
    calls: dict[int, dict[str, str]] = {}
    finish: str | None = None
    usage_meta: dict[str, t.Any] | None = None
    model: str | None = None
    encrypted = ""
    try:
        async for chunk in stream:
            if model is None:
                # the API-REPORTED model id (riders on every chunk, the
                # usage chunk included) -- what the endpoint actually ran,
                # not what we asked for
                model = str(getattr(chunk, "model", "") or "") or None
            if getattr(chunk, "usage", None) is not None:
                usage_meta = usage.openai_usage(chunk.usage)
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            if choice.finish_reason:
                finish = str(choice.finish_reason)
            delta = choice.delta
            if delta is None:
                continue
            # doubao's 思考内容加密原文 (the encrypted reasoning that tool
            # loops MUST echo back verbatim) rides the reasoning deltas
            enc = getattr(delta, "encrypted_content", None)
            if enc:
                encrypted += str(enc)
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
        events.put(
            ("finish", {"finish": finish, "usage": usage_meta, "encrypted_content": encrypted or None, "model": model})
        )
    finally:
        await stream.close()


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
        items.append(_responses_message(message))
    return items


async def _responses_pump(  # pylint: disable=too-many-branches, too-many-locals
    sdk: "OpenaiSdk",
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool,
    tools: list[dict[str, t.Any]] | None,
) -> None:
    """The Responses-API wire shape: relay the output text deltas, the
    reasoning text / summary deltas as think events.  Function-call items
    stream as ``output_item.added`` + ``function_call_arguments.delta``
    fragments.  The terminal response event's status and usage land in one
    ``("finish", meta)`` event (``max_output_tokens`` maps to ``length``)."""
    cfg = sdk.cfg
    client = clients.openai_client(cfg, sdk.base, family=sdk.family)
    extra: dict[str, t.Any] = {"tools": [dict(tool, type="function") for tool in tools]} if tools else {}
    stream = await client.responses.create(
        model=str(cfg.get("model")),
        input=_responses_input(messages),
        instructions=system_of(messages) or None,
        stream=True,
        timeout=clients.sdk_timeout(),
        extra_headers=extra_headers(cfg),
        extra_body=caching.cache_body(cfg),
        **caching.model_kwargs(params(cfg), RESPONSES_KIND),
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


class OpenaiSdk:
    """The bound OpenAI family surface: one instance per (config, base)
    binding, all request methods carrying that binding."""

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
        if self.kind == RESPONSES_KIND:
            await _responses_pump(self, messages, events, relay_reasoning, tools)
        else:
            await _chat_pump(self, messages, events, relay_reasoning, tools)

    async def json_completion(
        self,
        messages: list[dict[str, t.Any]],
        name: str,
        schema: dict[str, t.Any],
        strict: bool,
    ) -> tuple[str, dict[str, t.Any] | None]:
        """One native structured-object completion; ``(text, usage)`` out --
        the usage rides back so the gates' token spend is accountable."""
        cfg = self.cfg
        client = clients.openai_client(cfg, self.base, family=self.family)
        usage_meta = None
        if self.kind == RESPONSES_KIND:
            text_format = (
                {"type": "json_schema", "name": name, "strict": True, "schema": schema}
                if strict
                else {"type": "json_object"}
            )
            response = await client.responses.create(
                model=str(cfg.get("model")),
                input=_responses_input(messages),
                instructions=system_of(messages) or None,
                text={"format": text_format},
                timeout=clients.sdk_timeout(),
                extra_headers=extra_headers(cfg),
                extra_body=extra_body(cfg),
                **caching.model_kwargs(params(cfg), RESPONSES_KIND),
            )
            if getattr(response, "usage", None) is not None:
                usage_meta = usage.openai_usage(response.usage)
            return str(getattr(response, "output_text", "") or ""), usage_meta
        response_format = (
            {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}}
            if strict
            else {"type": "json_object"}
        )
        # the deployment's params may carry their own ``response_format``
        # -- the gate's structured-output key wins (a duplicate kwarg is
        # a TypeError)
        gate_kwargs = caching.model_kwargs(params(cfg), CHAT_KIND)
        gate_kwargs.pop("response_format", None)
        response = await client.chat.completions.create(
            model=str(cfg.get("model")),
            messages=_chat_wire_messages(cfg, messages),
            response_format=response_format,
            timeout=clients.sdk_timeout(),
            extra_headers=extra_headers(cfg),
            extra_body=extra_body(cfg),
            **gate_kwargs,
        )
        if getattr(response, "usage", None) is not None:
            usage_meta = usage.openai_usage(response.usage)
        if response.choices and response.choices[0].message and response.choices[0].message.content:
            return str(response.choices[0].message.content), usage_meta
        return "", usage_meta

    async def embed(self, texts: list[str]) -> tuple[list[list[float]], dict[str, t.Any] | None]:
        """One embeddings-API batch in input order (the embedding column
        width rides the ``params.dimensions`` key -- infra.embed owns the
        width resolution).  The API's ``usage.prompt_tokens`` rides along
        when the upstream reports it (the embeddings用量 stats)."""
        cfg = self.cfg
        client = clients.openai_client(cfg, self.base, family=self.family)
        call: dict[str, t.Any] = {
            **embedding_passthrough(cfg),
            "model": str(cfg.get("model")),
            "input": [text[:8000] for text in texts],
            "dimensions": dimensions(cfg, "openai"),
            "extra_headers": cfg.get("extra_headers") or None,
            "extra_body": cfg.get("extra_body") or None,
        }
        response = await client.embeddings.create(**call)
        # the API returns data in input order, but sort by index to be sure
        ordered = sorted(response.data, key=lambda item: item.index)
        reported = getattr(response, "usage", None)
        meta = {"input": reported.prompt_tokens} if reported is not None and reported.prompt_tokens else None
        return [item.embedding for item in ordered], meta


def factory(cfg: dict[str, t.Any], base: str, kind: str, family: str = "openai") -> OpenaiSdk:
    """The OpenAI family factory: config + base_url + wire kind bound into
    one callable surface.  ``family`` separates the client cache
    namespaces (the chat transport and the embedding feature can share a
    base_url while carrying DIFFERENT keys)."""
    return OpenaiSdk(cfg, base, kind, family)
