# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Context compaction for the research loop (the ``engine.run`` rounds).

Three tiers, cheapest first -- the port of ZCode's compact system onto
the canonical message list:

- **microcompact** (:func:`microcompact`): a pure-local pass that clears
  the BODIES of old ``web_reader``/``web_browser`` tool results (the
  fail-open page reads are the list's bulk), keeping the citation head
  of each so ``[n]`` identity survives.  No model call.
- **auto-compact** (:class:`Compactor.maybe_compact`): when the token
  estimate crosses the threshold, everything before the last round is
  summarized by ONE text-only completion and re-injected as a user
  message beside a MECHANICALLY rendered state block (the caller's
  ``compact_state`` callback -- findings ledger, task card, the source
  table) and the preserved last round.  The prefix (system + history +
  opener) is never touched: it is the cache-stable zone.
- **reactive** (:func:`looks_like_overflow`): a provider context-overflow
  rejection triggers one forced compaction and a turn retry.

Token counting prefers the PROVIDER's own number -- the last turn's
``usage.input`` IS the prompt size that turn actually billed -- and
falls back to a chars/3 estimate.  Config rides the ``zjsearch.compact``
settings block; the same reader runs inside every nested loop, so
subagent children inherit the policy automatically.  The compacted list
is just messages: ``ctx`` checkpoints, ``parse_resume`` and every dialect
projection need no changes.
"""

import logging
import threading
import time
import typing as t

from searx.zjsearch.ai.core.config import zj_block
from searx.zjsearch.ai.llm.streaming import LlmStream

logger = logging.getLogger(__name__)

MICROCOMPACT_TOOLS = frozenset({"web_reader", "web_browser"})
"""Tool results whose BODIES are clearable (the fail-open page reads --
the conversation's bulk).  ``web_search`` blocks stay: they are small
and carry the ``[n]`` identity lines."""

MICRO_KEEP_ROUNDS = 5
"""Round groups whose tool results stay verbatim (the most recent)."""

MICRO_MIN_BODY = 1_200
"""Tool results shorter than this never get cleared (not worth it)."""

MICRO_HEAD = 240
"""Chars of the citation head kept in a cleared result."""

AUTO_KEEP_ROUNDS = 1
"""The last assistant-started rounds preserved verbatim across an
auto-compact (the fresh reads the model is actively working from)."""

MIN_ROUNDS = 3
"""Summarizable rounds required before auto-compact fires (below this
there is nothing worth a summary call)."""

DEFAULT_CONTEXT_WINDOW = 200_000
"""The compaction window when the deployment does not name one."""

OUTPUT_RESERVE_TOKENS = 21_000
"""Reserved for the model's NEXT completion (input/output share the
provider window; compaction can only free the input side)."""

BUFFER_TOKENS = 13_000
"""Hysteresis below the effective window."""

CHARS_PER_TOKEN = 3
"""The cold-start estimator (provider usage is preferred whenever a
turn has completed)."""

MIN_SAVINGS_TOKENS = 256
"""A microcompact pass that saves less is not committed."""

MAX_CONSECUTIVE_FAILURES = 3
"""The summary circuit breaker: after this many failed summary calls the
compactor stops trying (a broken gateway must not burn rounds)."""

SUMMARY_MAX_OUTPUT_TOKENS = 4_000
SUMMARY_FIRST_EVENT_TIMEOUT = 45.0
SUMMARY_TOTAL_TIMEOUT = 120.0

SENTINEL = (
    "\n[... the rest of this older page text was cleared to keep the"
    " research context small; its key facts belong in your findings"
    " ledger and the source stays citable as above ...]"
)

COMPACTION_PROMPT = (
    "Summarize the research conversation above for continuation.  Respond"
    " with TEXT ONLY -- do NOT call any tool.\n"
    "Produce exactly these sections:\n"
    "1. <direction> the research question, the confirmed scope, and every"
    " user steering/clarification quoted VERBATIM.\n"
    "2. <facts> every established fact with its numbers/dates and its [n]"
    " citations copied EXACTLY -- a fact or figure not listed here is"
    " lost for good.\n"
    "3. <sources> one line per cited source: [n] title -- host.\n"
    "4. <searched> the queries and angles already tried, so they are not"
    " repeated.\n"
    "5. <gaps> the open questions the sources could not settle.\n"
    "6. <state> what was being worked on right before this point and the"
    " immediate next step.\n"
    "Keep it under 1200 words.  Never invent facts or [n] numbers."
)

LENGTH_RESUME_NOTE = (
    "Your previous reply hit the output token limit and was cut off"
    " mid-thought.  Resume DIRECTLY from where it stopped -- no apology,"
    " no recap, no re-statement of what you already wrote.  If much"
    " remains, break the remaining work into smaller pieces."
)

__all__ = [
    "Compactor",
    "LENGTH_RESUME_NOTE",
    "config_of",
    "estimate_messages",
    "looks_like_overflow",
    "microcompact",
    "split_rounds",
]

_OVERFLOW_PATTERNS = (
    "context length",
    "context_length",
    "context window",
    "context window exceeded",
    "prompt is too long",
    "prompt too long",
    "too many tokens",
    "maximum context",
    "max_input_tokens",
    "request too large",
    "exceeds the context",
    "exceeds the model",
    "input length exceeds",
    "reduce the length",
    "413",
)


def config_of(cfg: dict[str, t.Any] | None) -> dict[str, t.Any] | None:
    """The normalized compaction policy out of the ``zjsearch.compact``
    settings block (read directly -- ``cfg`` here is the ``llm`` block).
    ``None`` when disabled."""
    raw = zj_block("compact")

    def _int(key: str, default: int) -> int:
        try:
            value = int(raw.get(key, default))
        except (TypeError, ValueError):
            return default
        return value if value > 0 else default

    enabled = raw.get("enabled")
    if enabled is None:
        enabled = True
    if not enabled:
        return None
    return {
        "context_window": _int("context_window", DEFAULT_CONTEXT_WINDOW),
        "buffer_tokens": _int("buffer_tokens", BUFFER_TOKENS),
        "keep_rounds": max(1, _int("keep_rounds", AUTO_KEEP_ROUNDS)),
        "micro_keep_rounds": max(1, _int("micro_keep_rounds", MICRO_KEEP_ROUNDS)),
        "min_savings_tokens": _int("min_savings_tokens", MIN_SAVINGS_TOKENS),
    }


def estimate_tokens(text: str) -> int:
    return len(text) // CHARS_PER_TOKEN


def estimate_messages(messages: list[dict[str, t.Any]]) -> int:
    """The cold-start estimate: visible content + tool-call arguments, all
    at chars/3 (reasoning echoes included -- they ride the prompt too)."""
    total = 0
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            total += len(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict):
                    total += len(str(part.get("text") or ""))
        for call in message.get("tool_calls") or []:
            args = call.get("function") or {}
            total += len(str(args.get("arguments") or ""))
        for block in message.get("reasoning_blocks") or []:
            total += len(str((block or {}).get("text") or ""))
    return total // CHARS_PER_TOKEN


def split_rounds(
    messages: list[dict[str, t.Any]],
) -> tuple[list[dict[str, t.Any]], list[list[dict[str, t.Any]]]]:
    """The conversation as (prefix, round groups): a group starts at an
    assistant message that carries tool_calls (plain assistant turns --
    history echoes, the length-continuation stub -- belong to the flow
    they sit in); everything before the first one is the prefix."""
    first = None
    for index, message in enumerate(messages):
        if message.get("role") == "assistant" and message.get("tool_calls"):
            first = index
            break
    if first is None:
        return list(messages), []
    prefix = list(messages[:first])
    groups: list[list[dict[str, t.Any]]] = []
    for message in messages[first:]:
        if message.get("role") == "assistant" and message.get("tool_calls"):
            groups.append([message])
        elif groups:
            groups[-1].append(message)
    return prefix, groups


def microcompact(
    messages: list[dict[str, t.Any]],
    *,
    keep_rounds: int = MICRO_KEEP_ROUNDS,
    min_savings_tokens: int = MIN_SAVINGS_TOKENS,
) -> list[dict[str, t.Any]] | None:
    """The local clearing pass -- returns a NEW list when the savings are
    worth it, else ``None`` (copy-on-write; the input list is never
    mutated).  Idempotent via the sentinel marker."""
    prefix, groups = split_rounds(messages)
    if len(groups) <= keep_rounds:
        return None
    old_count = len(groups) - keep_rounds
    changed = False
    savings = 0
    rebuilt: list[dict[str, t.Any]] = list(prefix)
    for index, group in enumerate(groups):
        if index >= old_count:
            rebuilt.extend(group)
            continue
        for message in group:
            content = message.get("content")
            if (
                message.get("role") == "tool"
                and str(message.get("name") or "") in MICROCOMPACT_TOOLS
                and isinstance(content, str)
                and len(content) > MICRO_MIN_BODY
                and SENTINEL not in content
            ):
                head = content[:MICRO_HEAD]
                cut = head.rfind("\n")
                if cut > 80:
                    head = head[:cut]
                savings += len(content) - len(head) - len(SENTINEL)
                rebuilt.append({**message, "content": head + SENTINEL})
                changed = True
            else:
                rebuilt.append(message)
    if not changed or savings // CHARS_PER_TOKEN < min_savings_tokens:
        return None
    return rebuilt


def looks_like_overflow(error_text: str) -> bool:
    """Whether a provider failure reads as a context-overflow rejection
    (the reactive compact's trigger)."""
    lowered = str(error_text or "").lower()
    return bool(lowered) and any(pattern in lowered for pattern in _OVERFLOW_PATTERNS)


class Compactor:
    """One loop's compaction state machine: observes each turn's provider
    usage, and at the round boundary decides micro / auto / (forced)
    compaction.  ``compact_state`` renders the AUTHORITATIVE state block
    (findings ledger, task card, source table) that rides every summary
    injection -- the summary model's prose is support, never the record.
    ``tally`` folds the summary call's spend into the run's account."""

    def __init__(
        self,
        cfg: dict[str, t.Any],
        compact_state: t.Callable[[], str] | None = None,
        tally: t.Any = None,
    ) -> None:
        self.cfg = cfg or {}
        self.state_block = compact_state
        self.tally = tally
        policy = config_of(cfg)
        self.enabled = policy is not None
        self.context_window = (policy or {}).get("context_window", DEFAULT_CONTEXT_WINDOW)
        self.buffer_tokens = (policy or {}).get("buffer_tokens", BUFFER_TOKENS)
        self.keep_rounds = (policy or {}).get("keep_rounds", AUTO_KEEP_ROUNDS)
        self.micro_keep_rounds = (policy or {}).get("micro_keep_rounds", MICRO_KEEP_ROUNDS)
        self.min_savings_tokens = (policy or {}).get("min_savings_tokens", MIN_SAVINGS_TOKENS)
        self.threshold = max(
            0,
            self.context_window - min(OUTPUT_RESERVE_TOKENS, self.context_window) - self.buffer_tokens,
        )
        self.last_input_tokens = 0
        self.consecutive_failures = 0
        self.reactive_used = False
        self.summary_lock = threading.Lock()

    # -- observation -------------------------------------------------

    def observe(self, meta: dict[str, t.Any] | None) -> None:
        """Record the turn's provider prompt size (the exact number the
        provider billed for THIS conversation as of that request)."""
        usage = (meta or {}).get("usage") or {}
        try:
            self.last_input_tokens = max(self.last_input_tokens, int(usage.get("input") or 0))
        except (TypeError, ValueError):
            pass

    def _size_estimate(self, messages: list[dict[str, t.Any]]) -> int:
        return max(self.last_input_tokens, estimate_messages(messages))

    # -- the round-boundary hook ---------------------------------------

    def maybe_compact(
        self,
        messages: list[dict[str, t.Any]],
        *,
        next_round: int = 0,
        force: bool = False,
    ) -> t.Iterator[dict[str, t.Any]]:
        """The loop's top-of-round yield: microcompact first (free), then
        the auto summary when the size still sits at/above the threshold
        (``force`` skips the threshold -- the reactive path).  MUTATES
        ``messages`` in place on a committed compaction; yields ``compact``
        wire events."""
        if not self.enabled or self.consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
            return
        # microcompact: the free first line of defense
        cleared = microcompact(
            messages,
            keep_rounds=self.micro_keep_rounds,
            min_savings_tokens=self.min_savings_tokens,
        )
        if cleared is not None:
            pre = self._size_estimate(messages)
            messages[:] = cleared
            post = self._size_estimate(messages)
            logger.info(
                "zjsearch compact: microcompact cleared old page reads (%s -> %s est. tokens)",
                pre,
                post,
            )
            yield {
                "e": "compact",
                "round": next_round,
                "trigger": "micro",
                "pre": pre,
                "post": post,
                "summarized": 0,
                "kept": 0,
            }
        # auto-compact: the summary pass
        size = self._size_estimate(messages)
        if not force and size < self.threshold:
            return
        summary = self._run_summary(messages, force=force)
        if summary is None:
            return
        prefix, groups = split_rounds(messages)
        if len(groups) < (2 if force else MIN_ROUNDS):
            return
        kept = groups[-self.keep_rounds :]
        summarized_count = len(groups) - self.keep_rounds
        pre = size
        messages[:] = [*prefix, self._summary_message(summary), *[m for group in kept for m in group]]
        self.last_input_tokens = estimate_messages(messages)
        logger.info(
            "zjsearch compact: auto-compact %s -> %s est. tokens (%s rounds summarized, %s kept)",
            pre,
            self.last_input_tokens,
            summarized_count,
            len(kept),
        )
        yield {
            "e": "compact",
            "round": next_round,
            "trigger": "reactive" if force else "auto",
            "pre": pre,
            "post": self.last_input_tokens,
            "summarized": summarized_count,
            "kept": len(kept),
        }

    # -- the summary call ----------------------------------------------

    def _summary_message(self, summary_text: str) -> dict[str, t.Any]:
        parts = [
            "<compacted_context>",
            "The research conversation was compacted: earlier rounds were"
            " summarized below to keep the context small.  Everything after"
            " this message is recent, verbatim history.",
            "<summary>",
            summary_text.strip()[:12_000],
            "</summary>",
        ]
        if self.state_block is not None:
            try:
                block = self.state_block()
            except Exception as exc:  # pylint: disable=broad-except
                logger.warning("zjsearch compact: state block failed: %s", exc)
                block = ""
            if block:
                parts.append(block)
        parts.append(
            "Continue the research from where it left off -- do NOT re-run"
            " searches or page reads whose results the summary already"
            " records; their [n] citations stay valid."
        )
        parts.append("</compacted_context>")
        return {"role": "user", "content": "\n".join(parts)}

    def _run_summary(self, messages: list[dict[str, t.Any]], *, force: bool = False) -> str | None:
        """One text-only completion over the to-be-summarized span.
        Returns the summary text or ``None`` on any failure (the breaker
        counts it; the loop just continues on the un-compacted list).
        The reactive ``force`` relaxes the minimum-rounds gate -- a dying
        run summarizes what exists."""
        with self.summary_lock:
            prefix, groups = split_rounds(messages)
            if len(groups) < (2 if force else MIN_ROUNDS):
                return None
            span = prefix + [m for group in groups for m in group]
            request = [*span, {"role": "user", "content": COMPACTION_PROMPT}]
            summary_cfg = dict(self.cfg)
            params = dict(summary_cfg.get("params") or {})
            params["max_tokens"] = SUMMARY_MAX_OUTPUT_TOKENS
            summary_cfg["params"] = params
            try:
                summary = _complete_text(
                    summary_cfg,
                    request,
                    tally=self.tally,
                )
            except Exception as exc:  # pylint: disable=broad-except
                self.consecutive_failures += 1
                logger.warning(
                    "zjsearch compact: summary call failed (%s/%s): %s",
                    self.consecutive_failures,
                    MAX_CONSECUTIVE_FAILURES,
                    exc,
                )
                return None
            if not summary or not summary.strip():
                self.consecutive_failures += 1
                return None
            self.consecutive_failures = 0
            return summary


def _complete_text(
    cfg: dict[str, t.Any],
    messages: list[dict[str, t.Any]],
    *,
    tally: t.Any = None,
) -> str:
    """One bounded plain-text completion on the shared loop (no tools, no
    reasoning relay).  Raises on transport failure / timeout."""
    stream = LlmStream(
        cfg,
        messages,
        relay_reasoning=False,
        tools=None,
    )
    chunks: list[str] = []
    deadline = time.monotonic() + SUMMARY_TOTAL_TIMEOUT
    first = True
    try:
        while True:
            budget = min(SUMMARY_FIRST_EVENT_TIMEOUT if first else 30.0, max(0.5, deadline - time.monotonic()))
            kind, payload = stream.wait_event(budget)
            first = False
            if kind == "timeout":
                if time.monotonic() >= deadline:
                    stream.cancel()
                    raise TimeoutError("compaction summary timed out")
                continue
            if kind == "delta":
                chunks.append(str(payload or ""))
            elif kind == "finish":
                if tally is not None:
                    try:
                        tally.absorb(payload)
                    except Exception:  # pylint: disable=broad-except
                        pass
                break
            elif kind in ("error", "end"):
                if kind == "error":
                    raise RuntimeError(str(payload or "summary stream failed"))
                break
    finally:
        stream.cancel()
    return "".join(chunks)


__all__ = [
    "Compactor",
    "config_of",
    "estimate_messages",
    "looks_like_overflow",
    "microcompact",
    "split_rounds",
]
