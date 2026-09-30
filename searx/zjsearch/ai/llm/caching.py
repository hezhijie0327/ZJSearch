# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Per-dialect request shaping: SDK create kwargs and prompt-cache strategy.

The ``params`` block translates to each API's own kwarg names, and the
prompt-cache design rides here -- OpenAI's ``prompt_cache_key`` routing
bucket and the Anthropic ``cache_control`` breakpoints.  The dialect
modules apply these before issuing their requests.
"""

import typing as t

from . import config

_ANTHROPIC_DEFAULT_MAX_TOKENS = 4096
"""The Messages API has no default for ``max_tokens`` -- fills in when
``params.max_tokens`` is unset (reasoning models can burn it on thinking;
raise it there or override via extra_body)."""


def model_kwargs(params: dict[str, t.Any], kind: str) -> dict[str, t.Any]:
    """The ``params`` entries as SDK create kwargs: ``max_tokens`` translates
    to each API's own key (and fills the Anthropic mandatory default), the
    rest pass through under their SDK names -- including the thinking knobs
    (``reasoning_effort`` / ``reasoning`` / ``thinking`` /
    ``thinking_config``, whichever the chosen SDK speaks)."""
    max_tokens = params.get("max_tokens")
    kwargs = {name: value for name, value in params.items() if name != "max_tokens" and value is not None}
    if kind == "anthropic":
        kwargs["max_tokens"] = int(max_tokens) if max_tokens else _ANTHROPIC_DEFAULT_MAX_TOKENS
    elif kind in ("openai_responses", "gemini"):
        if max_tokens:
            kwargs["max_output_tokens"] = int(max_tokens)
    elif max_tokens:
        kwargs["max_tokens"] = int(max_tokens)
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
