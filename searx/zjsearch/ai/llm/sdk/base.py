# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The wire-dialect contract: one module per SDK, one interface.

Every module in this package drives ONE wire dialect (an official SDK
talking to one API family) and exposes EXACTLY this surface -- adding a
dialect means adding one module here plus one line in the package's
``resolve()`` registry:

- ``KIND: str`` -- the ``zjsearch.llm.sdk`` value it serves.
- ``JSON_TIERS: int`` -- how many native structured-output attempts
  :py:func:`llm.jsongate.json_completion` should try (the openai dialects
  speak two tiers -- strict ``json_schema``, then ``json_object``;
  single-tier dialects carry 1 and ignore the ``strict`` flag).
- ``pump(cfg, base, messages, events, relay_reasoning, tools) -> None``
  (async): drive the SDK stream and relay it into the ``events`` queue.
- ``json_completion(cfg, base, messages, name, schema, strict) -> str``
  (async): one native structured-object completion, raw text out.

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
specs (one or more), converted per dialect -- makes the pumps collect the
model's tool-call fragments into a single ``("tool_calls", calls)`` event
that closes a clean turn.  Without a spec no dialect can emit calls at
all, so single-turn consumers are unaffected.  A clean stream carries one
``("finish", meta)`` event right before ``end`` (see :py:mod:`..usage`).
"""

import typing as t
from searx.zjsearch.ai.core.text import raw_args


def system_of(messages: list[dict[str, t.Any]]) -> str:
    """The concatenated system prompt of a canonical message list (the
    dialects that carry it as a dedicated field all consume this)."""
    return "".join(str(m.get("content")) for m in messages if m.get("role") == "system")


def json_args_of(raw: t.Any) -> dict[str, t.Any]:
    """A tool-call ``arguments`` JSON string as a dict -- malformed or empty
    arguments degrade to ``{}`` (the endpoint re-validates required fields
    and answers a tool error the model can see).  The ONE lenient reader
    lives in ``core.text`` (llm -> core is a legal downward edge)."""
    return raw_args({"arguments": raw})
