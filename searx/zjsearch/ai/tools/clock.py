# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``clock`` tool -- the current instant, NOTHING else.

Split from the composite calendar (2026-11): a bare "what time is it"
paid the whole lunar/almanac block on every call.  The clock answers
the instant in the user's timezone and nothing more; every date facet
(weekday of a past/future day, lunar, almanac, workday) is the
``calendar`` tool with ``date`` / ``offset_days`` / ``find_suited``.
"""

import datetime
import json
import typing as t

from searx.zjsearch.ai.core.dates import resolve_zone, weekday_name
from searx.zjsearch.ai.core.text import raw_args

CLOCK_TOOL = "clock"

INSTRUCTIONS = """\
The current instant in the user's timezone: clock time, date, weekday,
UTC offset, UTC and unix.  Call it whenever time-of-day matters (is the
market open, business hours, "how long until X", "what time is it
now") and to RE-CHECK the clock after a long stretch of research (the
run's date goes stale across hours).  Calendar arithmetic must not
happen in your head -- a DATE lookup (weekday, lunar, almanac,
workday) is the calendar tool with date or offset_days."""
"""The clock tool's doctrine -- the instant ONLY; every date/lunar/
almanac facet lives on the calendar tool."""


def clock_spec() -> dict[str, t.Any]:
    """The ``clock`` tool spec -- the current instant, nothing else
    (split from the composite calendar 2026-11: a bare "what time is
    it" used to pay the whole lunar/almanac block)."""
    return {
        "name": CLOCK_TOOL,
        "description": """\
The current clock time and date in the user's timezone: HH:MM:SS, \\
date, weekday, UTC offset, UTC and unix.  No arguments.  For a DATE \\
lookup (weekday of a past/future day, lunar month, almanac, workday \\
verdict) call calendar instead.""",
        "annotations": {"readOnlyHint": True},
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    }


def clock_payload(tz: str = "", default_tz: str | None = None) -> dict[str, t.Any]:
    """The ``clock`` payload: the instant ONLY (time, date, weekday,
    zone, UTC, unix)."""
    zone, name = resolve_zone(tz)
    if zone is None and default_tz:
        zone, name = resolve_zone(default_tz)
    now = datetime.datetime.now(zone) if zone else datetime.datetime.now()
    today = now.date()
    offset = now.strftime("%z") if zone else ""
    return {
        "mode": "now",
        "timezone": name or None,
        "today": today.isoformat(),
        "weekday": weekday_name(today),
        "utc_offset": f"UTC{offset[:3]}:{offset[3:]}" if offset else None,
        "time": now.strftime("%H:%M:%S"),
        "datetime": now.replace(microsecond=0).isoformat(timespec="seconds"),
        "utc": (
            now.astimezone(datetime.timezone.utc)
            .replace(microsecond=0)
            .isoformat(timespec="seconds")
            if zone
            else None
        ),
        "unix": int(now.timestamp()) if zone else None,
    }


def clock_run_call(
    call: dict[str, t.Any], rnd: int, wire_id: int, default_tz: str | None = None
) -> tuple[str, dict[str, t.Any]]:
    """One ``clock`` call -> (model feed, wire event): the instant is
    read HERE (no pool slot) and the payload rides the event so the
    client's row renders the real value."""
    args = raw_args(call)
    payload = clock_payload(str(args.get("tz") or ""), default_tz)
    return (
        f'{{"clock": {json.dumps(payload, ensure_ascii=False, separators=(",", ":"))}}}',
        {"round": rnd, "id": wire_id, "status": "ok", "calendar": payload},
    )


__all__ = [
    "CLOCK_TOOL",
    "INSTRUCTIONS",
    "clock_spec",
    "clock_payload",
    "clock_run_call",
]
