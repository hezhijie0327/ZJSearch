# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The openai chat-completions dialect (``openai_chat_completions``)."""

import queue
import typing as t

from .. import caching, clients, config, usage

KIND = "openai_chat_completions"

JSON_TIERS = 2
"""strict ``json_schema`` first, the weaker ``json_object`` mode second
(DeepSeek and friends support the latter where the full schema is
unavailable)."""


def wire_messages(cfg: dict[str, t.Any], messages: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    """The canonical conversation in chat-completions wire shape: the dicts
    go over the wire verbatim EXCEPT the internal ``reasoning_blocks`` /
    ``thought_signature`` keys are stripped, and an assistant turn that
    reasoned echoes its ``reasoning_content`` back when the deployment
    asked for it (``zjsearch.ai.reasoning_passback`` -- a keyword list
    matched on the model id, or ``true`` for every model)."""
    passback = config.reasoning_passback(cfg)
    echo = passback is True or any(k in str(cfg.get("model") or "").lower() for k in passback)
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
        if echo and wire.get("role") == "assistant" and wire.get("tool_calls") and message.get("reasoning_blocks"):
            wire["reasoning_content"] = "\n\n".join(
                str(b.get("text") or "") for b in message["reasoning_blocks"] if b.get("text")
            )
        out.append(wire)
    return out


async def pump(  # pylint: disable=too-many-branches, too-many-locals
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
    one ``("tool_calls", calls)`` event that closes a clean turn.  The
    stream's ``finish_reason`` and the usage chunk land in one terminal
    ``("finish", meta)`` event.  The usage chunk rides ``stream_options``
    include_usage per the OpenAI contract -- whatever the endpoint reports
    (cache hits included) is rendered; one that rejects the parameter
    outright still streams -- one retry without it, stats simply absent."""
    from openai import BadRequestError, UnprocessableEntityError  # pylint: disable=import-outside-toplevel

    client = clients.openai_client(cfg, base)
    extra = {"tools": [{"type": "function", "function": tool} for tool in tools]} if tools else {}
    kwargs: dict[str, t.Any] = {
        "model": str(cfg.get("model")),
        "messages": wire_messages(cfg, messages),
        "stream": True,
        "timeout": clients.sdk_timeout(),
        "extra_headers": config.extra_headers(cfg),
        "extra_body": caching.cache_body(cfg),
        **caching.model_kwargs(config.params(cfg), KIND),
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
    encrypted = ""
    try:
        async for chunk in stream:
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
        events.put(("finish", {"finish": finish, "usage": usage_meta, "encrypted_content": encrypted or None}))
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
        messages=wire_messages(cfg, messages),
        response_format=response_format,
        timeout=clients.sdk_timeout(),
        extra_headers=config.extra_headers(cfg),
        extra_body=config.extra_body(cfg),
        **caching.model_kwargs(config.params(cfg), KIND),
    )
    if response.choices and response.choices[0].message and response.choices[0].message.content:
        return str(response.choices[0].message.content)
    return ""
