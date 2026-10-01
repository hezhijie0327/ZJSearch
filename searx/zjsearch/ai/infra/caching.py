# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Per-dialect request shaping: SDK create kwargs and prompt-cache strategy.

The ``params`` block passes through under its SDK names (no translation),
and the prompt-cache design rides here -- OpenAI's ``prompt_cache_key``
routing bucket and the Anthropic ``cache_control`` breakpoints.  The
dialect modules apply these before issuing their requests.
"""

import typing as t

from . import config

_ANTHROPIC_DEFAULT_MAX_TOKENS = 4096
"""The Messages API has no default for ``max_tokens`` -- filled in when
``params`` does not carry one (reasoning models can burn it on thinking;
raise ``max_tokens`` there)."""

_ANTHROPIC_THINKING_BUDGET = 2048
"""The native progressive-thinking default for the Anthropic dialect:
extended thinking ON with a 2048-token budget.  ``params.thinking`` wins
when set (an explicit ``false`` opts out entirely)."""


def model_kwargs(params: dict[str, t.Any], kind: str, with_native_thinking: bool = True) -> dict[str, t.Any]:
    """The ``params`` entries as SDK create kwargs, VERBATIM under their SDK
    names -- the block mirrors the chosen SDK's own ``create()`` signature
    and nothing is translated (name the output cap ``max_tokens`` on the
    anthropic dialect, ``max_output_tokens`` on the openai / gemini dialects).
    Two transport-level necessities remain: the Anthropic Messages API has
    NO default for ``max_tokens`` (filled when ``params`` omits it), and
    the native progressive-thinking default -- ``with_native_thinking``
    lets callers that do not benefit from a reasoning phase (the JSON
    gates) opt out of it."""
    kwargs = {name: value for name, value in params.items() if value is not None}
    if kind == "anthropic":
        thinking = params.get("thinking")
        if thinking is None and with_native_thinking and "temperature" not in params:
            thinking = {"type": "enabled", "budget_tokens": _ANTHROPIC_THINKING_BUDGET}
        if thinking is not None:
            kwargs["thinking"] = thinking
        kwargs.setdefault("max_tokens", _ANTHROPIC_DEFAULT_MAX_TOKENS)
    return kwargs


def cache_body(cfg: dict[str, t.Any]) -> dict[str, t.Any]:
    """The extra_body with OpenAI's prompt-cache routing key folded in,
    UNCONDITIONALLY: ``prompt_cache_key`` improves the automatic prefix
    cache on the real API and is silently ignored by OpenAI-compatible
    servers that do not know it (LM Studio, vLLM, aggregators) -- the
    prompts here are byte-stable per mode+language by design, which is
    what makes prefix caching applicable anywhere.  The key buckets per
    model (LobeChat's user+model shape, minus the user dimension this
    server does not have).  Rides extra_body so no SDK signature is
    assumed."""
    body = dict(config.extra_body(cfg) or {})
    body.setdefault("prompt_cache_key", f"zjsearch-ai/{cfg.get('model')}")
    return body


def anthropic_cache_on(cfg: dict[str, t.Any]) -> bool:
    """Whether to mark Anthropic prompt-cache breakpoints: ON for every
    Anthropic-dialect endpoint by DEFAULT (LobeChat's stance -- the
    markers are part of the official block shape and gateways that forward
    blocks verbatim usually just work; the incremental breakpoints are
    what make the researcher loop cheap -- each turn re-reads the cached
    prefix at 0.1x), forced ON/OFF for any endpoint via the
    ``zjsearch.ai.cache_control`` setting (a gateway that validates
    strictly needs the off switch)."""
    flag = cfg.get("cache_control")
    if isinstance(flag, bool):
        return flag
    return True


def anthropic_cache_system(system_text: str) -> list[dict[str, t.Any]]:
    """The system prompt as one cache-marked block: the breakpoint pins the
    byte-stable contract (role/identity/citations/markdown/voice -- the
    writer's ~3k tokens) plus the tools spec as the cached prefix."""
    return [{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}]


def anthropic_cache_tail(messages: list[dict[str, t.Any]]) -> None:
    """Mark the LAST content block of the final message as a cache
    breakpoint (Anthropic's incremental agent-loop pattern): the request
    before it is a prefix-cache hit, the new tail is written.  Anthropic
    allows 4 breakpoints; this design uses 2 (system + tail).  Mutates
    the pump's throwaway message list in place."""
    if not messages:
        return
    content = messages[-1].get("content")
    if isinstance(content, str):
        messages[-1]["content"] = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]
    elif isinstance(content, list) and content:
        content[-1] = {**content[-1], "cache_control": {"type": "ephemeral"}}
