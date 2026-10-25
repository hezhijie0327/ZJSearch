# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: modes, budgets and the ``zjsearch.feature.ai_search`` settings block.

The bottom layer of the package -- every other module reads its knobs
from here, and nothing below it imports back (the dependency direction
is config <- tools/prompts/gates <- executor/wire <- route).
"""

import typing as t

from searx.zjsearch.ai.llm import config as llm_config

SEARCH_MODES = ("speed", "balanced", "deep")

_MODE_BUDGETS: dict[str, dict[str, int]] = {
    # THE MODEL CONTROLS DEPTH AND BREADTH -- fixed round caps that
    # amputate good research are gone.  Modes differ in TOOLS and in what
    # the prompt asks (speed = a quick answer; balanced = the main facets
    # with a partial toolset; deep = every tool, a full research project
    # that ends when the LEDGER closes).  max_rounds is the RUNAWAY guard
    # only (the user's stop button is the real control), stall_rounds
    # ends unproductive streaks, and max_seconds stays at 0 -- no wall
    # clock.  Per-round call counts are the MODEL's call (uncapped).
    # round caps are GONE too: the model runs until the LEDGER closes or
    # the rounds go stale -- max_rounds is a very high runaway guard.
    # THE OVERVIEW TIER: the classic page's AI Overview -- the page's own
    # results ride in as the seeded source registry, so the tier's rounds
    # are at most a couple of source-page reads (no search tool at all)
    # before the write turn.  Not user-selectable: the overview flow is
    # this tier's only caller.
    "overview": {"max_rounds": 3, "stall_rounds": 1, "max_seconds": 0},
    "speed": {"max_rounds": 6, "stall_rounds": 1, "max_seconds": 0},
    "balanced": {"max_rounds": 60, "stall_rounds": 3, "max_seconds": 0},
    "deep": {"max_rounds": 120, "stall_rounds": 4, "max_seconds": 0},
}


def _cfg() -> dict[str, t.Any]:
    """The ``zjsearch.feature.ai_search`` settings block."""
    return llm_config.feature_cfg("ai_search")


def enabled() -> bool:
    """The search feature flag: ``zjsearch.feature.ai_search.enabled`` -- ``True``
    unless explicitly switched off."""
    return llm_config.feature_enabled("ai_search")


def overview_enabled() -> bool:
    """The AI Overview feature flag: zjsearch.feature.ai_overview.enabled --
    True unless explicitly switched off.  (Reads here since the retired
    runs/overview.py: the overview tier lives on the search route now,
    and this package is the settings layer.)"""
    return llm_config.feature_enabled("overview")


def overview_capability() -> dict[str, str] | None:
    """The page-data ai payload (token + model label); None when the
    overview feature is switched off or the transport is unconfigured --
    the client hides its AI Overview entry point then."""
    return llm_config.feature_capability("overview")


def budget(key: str, mode: str, default: int) -> int:
    """The mode's built-in budget (``max_rounds`` / ``stall_rounds`` /
    ``max_seconds``): ENGINEERING GUARDS calibrated to the mode design,
    deliberately NOT deployment knobs -- ``max_rounds`` is already
    personalized per question by the depth probe's ladder, and exposing
    the runaway/stall ceilings invites tuning that defeats them.
    ``default`` covers an unknown mode."""
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
