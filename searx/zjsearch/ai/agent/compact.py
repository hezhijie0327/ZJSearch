# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Context compaction for the research loop (the ``engine.run`` rounds).

Three tiers, cheapest first -- the port of ZCode's compact system onto
the canonical message list:

- **microcompact** (:func:`microcompact`): a pure-local pass that clears
  the BODIES of ``web_browser`` tool results (the
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

MICROCOMPACT_TOOLS = frozenset({"web_browser"})
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
    "config_of",
    "estimate_messages",
    "looks_like_overflow",
    "microcompact",
    "split_rounds",
]
