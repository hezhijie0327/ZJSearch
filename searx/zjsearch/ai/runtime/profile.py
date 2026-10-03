# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: modes, budgets and the ``zjsearch.feature.ai_search`` settings block.

The bottom layer of the package -- every other module reads its knobs
from here, and nothing below it imports back (the dependency direction
is config <- tools/prompts/gates <- executor/wire <- route).
"""

import typing as t

from searx.zjsearch.ai.infra import config as llm_config

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
