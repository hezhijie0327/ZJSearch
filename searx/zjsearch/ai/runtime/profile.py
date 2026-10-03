# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: modes, budgets and the ``zjsearch.feature.ai_search`` settings block.

The bottom layer of the package -- every other module reads its knobs
from here, and nothing below it imports back (the dependency direction
is config <- tools/prompts/gates <- executor/wire <- route).
"""

import typing as t

from searx.zjsearch.ai.infra import config as llm_config

SEARCH_MODES = ("speed", "balanced", "deep", "goal")

_MODE_BUDGETS: dict[str, dict[str, int]] = {
    # speed: ONE focused round (Morphic's quick discipline); balanced: main
    # facets plus a gap-filler pass; deep: THE ~10-minute research --
    # breadth (8 subtasks) and depth (real page reads) under a ledger that
    # must CLOSE, not a model that got bored; goal: THE LOOP MODE -- the
    # question is a target
    # and the run iterates through its tools until the evidence ledger
    # closes.  "Infinite" means the loop ends on COMPLETION, not on a
    # small count: max_rounds is the runaway guard (the client-visible
    # contract is "researches until the goal is met"), the REAL plan is
    # PROGRESS -- a round that adds no new information (only repeats or
    # empty results) is stalled, and stall_rounds consecutive stalled
    # rounds end the research.  Per-round call counts are the MODEL's call
    # (uncapped); every engine request carries its own per-request timeout.
    "speed": {"max_rounds": 1, "stall_rounds": 1},
    "balanced": {"max_rounds": 6, "stall_rounds": 3},
    "deep": {"max_rounds": 18, "stall_rounds": 4},
    "goal": {"max_rounds": 32, "stall_rounds": 3},
}

CLARIFY_MODES = ("deep", "goal")

PLAN_MODES = ("deep", "goal")
"""The tiers whose structured \"##\"-section answers are worth a planning
turn: the plan tool is registered only here (speed's one dense paragraph
and balanced's short prose never need it)."""


def _cfg() -> dict[str, t.Any]:
    """The ``zjsearch.feature.ai_search`` settings block."""
    return llm_config.feature_cfg("ai_search")


def enabled() -> bool:
    """The search feature flag: ``zjsearch.feature.ai_search.enabled`` -- ``True``
    unless explicitly switched off."""
    return llm_config.feature_enabled("ai_search")


def budget(key: str, mode: str, default: int) -> int:
    """Budget for one run: an explicit ``zjsearch.feature.ai_search.<key>`` setting
    wins, otherwise the mode's default, otherwise ``default``."""
    value = _cfg().get(key)
    if value is not None:
        try:
            return int(value)
        except (TypeError, ValueError):
            pass
    return _MODE_BUDGETS.get(mode, {}).get(key, default)


HISTORY_MODES = ("hybrid", "keyword", "semantic")
"""The history drawer's search modes: hybrid = keyword + semantic fused
through weighted RRF; keyword = BM25 only (free/offline); semantic =
pgvector cosine only (needs zjsearch.embedding)."""
DEFAULT_HISTORY_MODE = "hybrid"


def history_search_mode() -> str:
    """The configured default history-search mode
    (``zjsearch.feature.ai_search.history_search``) -- validated against
    HISTORY_MODES, unknown values fall back to hybrid."""
    value = str(_cfg().get("history_search") or DEFAULT_HISTORY_MODE)
    return value if value in HISTORY_MODES else DEFAULT_HISTORY_MODE


def capability() -> dict[str, str] | None:
    """The page-data ``ai_search`` payload (the shared token + model label
    + the configured default history-search mode); ``None`` when AI search
    is off or the transport is unconfigured -- the client hides its
    ``[classic|AI]`` mode switch then."""
    payload = llm_config.feature_capability("ai_search")
    if payload is None:
        return None
    return {**payload, "history_mode": history_search_mode()}
