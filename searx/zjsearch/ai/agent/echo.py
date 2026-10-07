# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Canonical-message construction with the cross-dialect reasoning echo.

A turn's assistant message must carry its tool calls AND the reasoning
payloads its dialect validates on replay: anthropic checks the thinking
blocks + signatures on tool-use turns, the kimi/glm/deepseek chat
families want ``reasoning_content`` (gated by the deployment's
``reasoning_passback``), the openai family carries doubao's
``encrypted_content`` and the Responses API's ``reasoning_items``.  The
canonical message is the superset; every dialect's wire conversion
strips or converts what it does not need.
"""

import typing as t


def echo_blocks(thinking_blocks: list[dict[str, t.Any]], turn_reasoning: str) -> list[dict[str, t.Any]]:
    """The reasoning echo payload of one assistant turn: the dialect's
    thinking blocks when the pump captured them (anthropic: text +
    signature), else the plain reasoning text when the turn reasoned at
    all.  Empty = nothing to echo."""
    blocks = [
        {"text": str(b.get("text") or ""), "signature": str(b.get("signature") or "")}
        for b in thinking_blocks
        if isinstance(b, dict) and (b.get("text") or b.get("signature"))
    ]
    if not blocks and turn_reasoning:
        blocks = [{"text": turn_reasoning, "signature": ""}]
    return blocks


def assistant_tool_calls_message(
    text: str,
    calls: list[dict[str, t.Any]],
    reasoning_blocks: list[dict[str, t.Any]] | None = None,
    encrypted_content: str = "",
    reasoning_items: list[dict[str, t.Any]] | None = None,
) -> dict[str, t.Any]:
    """Canonical assistant message carrying the turn's prose + tool calls
    (the pumps emit flat ``{"id", "name", "arguments"}`` calls; the
    canonical message nests them under ``"function"``)."""
    msg: dict[str, t.Any] = {
        "role": "assistant",
        "content": text,
        "tool_calls": [
            {
                "id": str(call.get("id") or ""),
                "type": "function",
                "function": {"name": str(call.get("name") or ""), "arguments": str(call.get("arguments") or "{}")},
                # the gemini dialect's REAL thought signature (b64) -- other
                # dialects strip it from their wire shape
                **({"thought_signature": str(call["thought_signature"])} if call.get("thought_signature") else {}),
            }
            for call in calls
        ],
    }
    if reasoning_blocks:
        msg["reasoning_blocks"] = reasoning_blocks
    if encrypted_content:
        msg["encrypted_content"] = encrypted_content
    if reasoning_items:
        msg["reasoning_items"] = reasoning_items
    return msg


def tool_result_message(call: dict[str, t.Any], text: str) -> dict[str, t.Any]:
    """Canonical ``tool`` result for one call (``name`` rides along: the
    gemini dialect needs it for the function_response part)."""
    return {
        "role": "tool",
        "tool_call_id": str(call.get("id") or ""),
        "name": str(call.get("name") or "tool"),
        "content": text,
    }
