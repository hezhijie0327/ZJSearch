# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Page reader configuration: the settings block, the budgets and the
shared error type.  The bottom of the browserless package -- fetch and
extract read their knobs from here."""

import os
import typing as t

from searx import settings

DEFAULT_MAX_CHARS = 12_000
"""Readable characters per page fed to the model; a long page truncates
with an honest marker (the model prefers a site:-search then)."""

GOTO_TIMEOUT_MS = 30_000
SETTLE_MS = 1_200
"""Wait for ``load`` plus a short settle -- late hydration gets a moment
without paying a fixed second per page."""

REJECT_RESOURCE_TYPES = ("image", "media", "font")
"""The reader only needs the DOM: media loads are the bulk of the wall
time and are rejected at the request level."""


class PageReadError(Exception):
    """A page could not be read -- the message travels to the model as the
    tool result (a dead end it is taught to move on from)."""


def _cfg() -> dict[str, t.Any]:
    """The ``zjsearch.ai.browserless`` settings block (absent unless the
    deployment defines it)."""
    ai = settings.get("zjsearch", {}).get("ai", {})
    cfg = ai.get("browserless") if isinstance(ai, dict) else None
    return cfg if isinstance(cfg, dict) else {}


def _key(cfg: dict[str, t.Any]) -> str:
    """The effective API key: the ``key`` setting first, then the
    ``ZJSEARCH_BROWSERLESS_KEY`` environment."""
    return str(cfg.get("key") or "") or os.environ.get("ZJSEARCH_BROWSERLESS_KEY", "")


def endpoint() -> str:
    """The Browserless v2 root (``zjsearch.ai.browserless.endpoint``), no
    trailing slash."""
    return str(_cfg().get("endpoint") or "").strip().rstrip("/")


def configured() -> bool:
    """True when ``endpoint`` and ``key`` are both present -- the gate for
    registering the ``web_crawler`` tool at all."""
    return bool(endpoint() and _key(_cfg()))


def normalize_url(url: str) -> str:
    """The dedup / cache key of a page: whitespace-stripped, fragment-free."""
    return str(url or "").strip().split("#", 1)[0]


def _max_chars() -> int:
    """``zjsearch.ai.browserless.max_chars``, clamped to sane bounds."""
    try:
        value = int(_cfg().get("max_chars"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_MAX_CHARS
    return max(2000, min(value, 100_000))
