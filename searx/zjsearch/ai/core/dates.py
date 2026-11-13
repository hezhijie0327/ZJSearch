# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Shared calendar primitives for the AI stack -- the ONE home of the
weekday table and the IANA zone resolution.  Leaf, zero AI semantics:
``prompts`` (the ``<today>``/``<now>`` blocks) and ``tools.clock`` (the
composite time/date tool) both build on it, so the zone-fallback and
weekday doctrines can never drift apart.

Weekday names are a FIXED English table, never ``strftime('%A')`` --
strftime is locale-dependent and a CJK-locale deployment would leak
non-English weekday names into the English-only prompt layer.  The tool
feed stays English too: the writer's ``<answer_language>`` directive
localizes the answer, and the client's clock row re-localizes its
rendering through Intl off the ISO date."""

import datetime
from zoneinfo import ZoneInfo

WEEKDAYS_EN = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def weekday_name(day: datetime.date) -> str:
    """The fixed English weekday name for one date."""
    return WEEKDAYS_EN[day.weekday()]


def resolve_zone(name: str | None) -> tuple[ZoneInfo | None, str]:
    """(zone, cleaned IANA name) -- the tolerant resolve: ``(None, "")``
    for an empty name, ``(None, cleaned)`` when the name fails to
    resolve.  The caller owns the fallback and its honesty label:
    ``spine.today_text`` says "the server's local time"; the ``clock``
    tool raises on an EXPLICIT name instead (a model-chosen zone is an
    error it can fix, a missing one is a degrade)."""
    clean = (name or "").strip()[:64]
    if not clean:
        return None, ""
    try:
        return ZoneInfo(clean), clean
    except Exception:  # pylint: disable=broad-except
        return None, clean
