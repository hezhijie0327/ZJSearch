# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The canonical finish/usage meta contract every dialect reports.

Each dialect pump closes a clean stream with ONE
``("finish", {"finish": <str|None>, "usage": <dict|None>})`` queue
event.  ``finish`` speaks the OpenAI vocabulary -- ``stop`` / ``length``
/ ``tool_calls`` / ``content_filter`` / ``refusal`` (per-dialect reasons
map onto it, unknown values pass through verbatim -- the client renders
every case).  ``usage`` is the canonical dict below; fields an endpoint
does not break out stay 0 / ``None``.  The agent loop sums usage across
a run's turns and keeps the LAST turn's finish reason (the writer's, on
a researcher/writer split).
"""

import typing as t

ANTHROPIC_STOP_REASONS = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "tool_use": "tool_calls",
    "refusal": "refusal",
}
"""Messages-API ``stop_reason`` -> the canonical finish vocabulary."""

GEMINI_FINISH_REASONS = {
    "STOP": "stop",
    "MAX_TOKENS": "length",
    "SAFETY": "content_filter",
    "PROHIBITED_CONTENT": "content_filter",
    "BLOCKLIST": "content_filter",
    "SPII": "content_filter",
}
"""Gemini ``finishReason`` enum names -> the canonical finish vocabulary."""


def openai_usage(usage: t.Any) -> dict[str, t.Any]:
    """One openai-family usage object in the canonical shape: the reasoning
    token count rides ``completion_tokens_details`` / ``output_tokens_details``,
    the prompt-cache hit rides ``prompt_tokens_details.cached_tokens`` /
    ``input_tokens_details.cached_tokens`` (DeepSeek's flat
    ``prompt_cache_hit_tokens`` covered too) -- fields an endpoint does not
    break out simply stay 0."""
    details = getattr(usage, "completion_tokens_details", None) or getattr(usage, "output_tokens_details", None)
    thoughts = getattr(details, "reasoning_tokens", None) if details else None
    prompt_details = getattr(usage, "prompt_tokens_details", None) or getattr(usage, "input_tokens_details", None)
    cached = getattr(prompt_details, "cached_tokens", None) if prompt_details else None
    if cached is None:
        cached = getattr(usage, "prompt_cache_hit_tokens", None)
    # some openai-compatible gateways forward anthropic-style cache-write
    # counters -- read them when they ride along
    cache_write = int(getattr(usage, "cache_creation_input_tokens", 0) or 0)
    return {
        "input": int(getattr(usage, "prompt_tokens", 0) or getattr(usage, "input_tokens", 0) or 0),
        "output": int(getattr(usage, "completion_tokens", 0) or getattr(usage, "output_tokens", 0) or 0),
        "thoughts": int(thoughts) if thoughts else None,
        "cached": int(cached) if cached else 0,
        "cache_write": cache_write,
    }
