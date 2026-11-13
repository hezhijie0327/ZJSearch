# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``clock`` tool: the ONE composite time/date surface -- the wall
clock AND a calendar lookup table in a single call.  Three semantics,
one deterministic core (``datetime`` + ``ZoneInfo``, zero network):

- no args -- the current instant in the USER'S zone: date, clock time,
  weekday, UTC offset, UTC, unix;
- ``date`` -- a calendar lookup: ``YYYY-MM-DD`` full form, ``MM-DD``
  (current year) or a bare ``DD`` (the "the 25th" shape, current
  month); answers the weekday, ISO week, days from today,
  past/today/future;
- ``offset_days=N`` -- the date N days from today (tomorrow=1,
  yesterday=-1), same payload ("what date is next Wednesday": the model
  reads today's weekday off the payload or ``<today>``, adds the day
  count, calls with the offset -- every step deterministic, nothing
  guessed).

``tz`` (an IANA name) re-anchors all three semantics to another zone;
the default is the run's user zone, and a zoneless run falls back to
the server's local clock SAYING SO (the ``<today>`` doctrine: never
pretend).  The tool is registered for EVERY research run and the
overview: the ``<today>`` block only grounds the DATE -- the clock time
is never guessable, calendar arithmetic must not ride mental math, and
a long run's start-of-run date goes stale (a re-read mid-run is one
free call).

The instant the payload answers is the moment of the CALL, not of the
run -- that freshness is the point."""

import datetime
import json
import typing as t
from zoneinfo import ZoneInfo

from searx.zjsearch.ai.core.dates import resolve_zone, weekday_name
from searx.zjsearch.ai.core.text import raw_args

CLOCK_TOOL = "clock"

INSTRUCTIONS = """\
The <today> block grounds the DATE only -- the clock time is NEVER
guessable, and calendar arithmetic must not happen in your head.  Call
this tool whenever time-of-day matters (is the market open, business
hours, "how long until X"), for ANY calendar lookup ("what weekday is
2026-05-01", "what date is next Wednesday" -- read today's weekday,
add the day count, call with offset_days), and to RE-CHECK the current
time after a long stretch of research (the run's date goes stale across
hours).  A bare day-of-month ("the 25th") resolves in the CURRENT
month -- pass a full date when the user means another month or year.
One call answers in the user's zone by default; pass tz to convert for
another zone."""

_MAX_OFFSET_DAYS = 3650
"""Offset clamp: a decade either way -- the honest bound for a research
calendar (an offset beyond it is a model slip, not a question)."""


class ClockError(ValueError):
    """One rejected call -- the message goes back to the model, so it
    can fix the arguments instead of guessing."""


def clock_spec() -> dict[str, t.Any]:
    """The ``clock`` tool spec -- the three semantics live on one api:
    no args = now; ``date`` = absolute lookup (wins over ``offset_days``
    when both are passed); ``offset_days`` = relative to today."""
    return {
        "name": CLOCK_TOOL,
        "description": """\
The current time and date, plus a calendar lookup table.  No arguments: \
the current instant in the user's timezone (date, clock time, weekday, \
UTC offset, unix).  date: that date's weekday, ISO week number and days \
from today -- "YYYY-MM-DD" full form, "MM-DD" (current year) or a bare \
day "DD" (current month; "25" asks about the 25th of THIS month).  \
offset_days=N (integer): the date N days from today (tomorrow=1, \
yesterday=-1).  tz (IANA name, optional): answer in that zone instead \
of the user's.""",
        "annotations": {"readOnlyHint": True},
        "inputSchema": {
            "type": "object",
            "properties": {
                "date": {
                    "type": "string",
                    "description": (
                        'Absolute date lookup: "YYYY-MM-DD" full form, "MM-DD" (current year)'
                        ' or a bare day "DD" (current month) -- "what weekday is 2026-05-01"'
                        ' / "what weekday is the 25th".'
                    ),
                },
                "offset_days": {
                    "type": "number",
                    "description": "Relative date lookup: the date N days from today (tomorrow=1, yesterday=-1).",
                },
                "tz": {
                    "type": "string",
                    "description": 'IANA timezone to answer in ("Asia/Shanghai"); default is the user\'s zone.',
                },
            },
            "required": [],
        },
    }


def parse_clock_call(call: dict[str, t.Any]) -> tuple[str, str, int | None]:
    """(tz, date, offset_days) of one ``clock`` call -- sanitized: the
    tz/date strings capped, the offset clamped to the legal range
    (None when absent)."""
    args = raw_args(call)
    # the tz string needs no local cap -- resolve_zone bounds it (and the
    # date cap keeps the ladder's length checks meaningful)
    tz = str(args.get("tz") or "").strip()
    date = str(args.get("date") or "").strip()[:10]
    offset_raw = args.get("offset_days")
    if offset_raw is None or (isinstance(offset_raw, str) and not offset_raw.strip()):
        return tz, date, None
    try:
        offset = max(-_MAX_OFFSET_DAYS, min(int(float(offset_raw)), _MAX_OFFSET_DAYS))
    except (TypeError, ValueError):
        raise ClockError(f"offset_days must be an integer ({-_MAX_OFFSET_DAYS}..{_MAX_OFFSET_DAYS})") from None
    return tz, date, offset


def _resolve_zone(tz: str) -> tuple[ZoneInfo | None, str]:
    """(zone, name) for one ``tz`` argument -- an explicit (model-chosen)
    name that fails to resolve is an ERROR (the model can fix it); the
    empty name resolves to no zone (the caller's fallback decides).
    The tolerant shared resolve lives in ``core.dates``; this wrapper
    adds the tool's raising contract."""
    zone, name = resolve_zone(tz)
    if zone is None and name:
        raise ClockError(f"unknown timezone {name!r} -- pass an IANA name like 'Asia/Shanghai'")
    return zone, name


def _parse_date(text: str, today: datetime.date) -> datetime.date:
    """One ``date`` argument -> a real calendar date, via a DETERMINISTIC
    ladder (fixed anchors, never a guess): ``YYYY-MM-DD`` as-is;
    ``MM-DD`` in the current year; a bare ``DD`` (the day-of-month-only
    shape, "the 25th") in the current month -- the payload's
    ``relation``/``days_from_today`` then say which side of today it
    landed on, and the model can re-call with a full date when the user
    meant another month/year.  Anything else (and any impossible date,
    ``02-30`` alike) is an ERROR the model can fix."""
    parts = text.split("-")
    try:
        if len(parts) == 3 and len(text) == 10:
            return datetime.date(int(parts[0]), int(parts[1]), int(parts[2]))
        if len(parts) == 2:
            return datetime.date(today.year, int(parts[0]), int(parts[1]))
        if len(parts) == 1 and text.isdigit():
            return datetime.date(today.year, today.month, int(text))
    except ValueError as exc:
        raise ClockError(f"date {text!r} is not a real calendar date: {exc}") from exc
    raise ClockError(f'date must be "YYYY-MM-DD", "MM-DD" (current year) or a bare day "DD" (current month), got {text!r}')


def clock_payload(
    tz: str = "",
    date: str = "",
    offset_days: int | None = None,
    default_tz: str | None = None,
) -> dict[str, t.Any]:
    """One call -> its payload dict: the ``now`` mode (instant fields)
    or the ``date`` mode (calendar fields), plus the shared zone ground
    (``timezone``/``today``/``weekday``/``utc_offset``).  ``default_tz``
    is the run's user zone (the ``<today>`` anchor); a run without one
    answers on the server's local clock and says so (``timezone: null``)."""
    zone, name = _resolve_zone(tz)
    if zone is None and default_tz:
        zone, name = resolve_zone(default_tz)
    now = datetime.datetime.now(zone) if zone else datetime.datetime.now()
    today = now.date()
    weekday = weekday_name(today)
    offset = now.strftime("%z") if zone else ""
    payload: dict[str, t.Any] = {
        "timezone": name or None,
        "today": today.isoformat(),
        "weekday": weekday,
        "utc_offset": f"UTC{offset[:3]}:{offset[3:]}" if offset else None,
    }
    if date or offset_days is not None:
        if date:
            target = _parse_date(date, today)
        else:
            assert offset_days is not None
            target = today + datetime.timedelta(days=offset_days)
        days = (target - today).days
        payload["mode"] = "date"
        payload["target"] = target.isoformat()
        payload["weekday"] = weekday_name(target)
        payload["iso_week"] = target.isocalendar()[1]
        payload["days_from_today"] = days
        payload["relation"] = "today" if days == 0 else ("future" if days > 0 else "past")
        return payload
    payload["mode"] = "now"
    payload["time"] = now.strftime("%H:%M:%S")
    payload["datetime"] = now.replace(microsecond=0).isoformat(timespec="seconds")
    payload["utc"] = (
        now.astimezone(datetime.timezone.utc).replace(microsecond=0).isoformat(timespec="seconds")
        if zone
        else None
    )
    payload["unix"] = int(now.timestamp()) if zone else None
    return payload


def run_call(
    call: dict[str, t.Any], rnd: int, wire_id: int, default_tz: str | None = None
) -> tuple[str, dict[str, t.Any]]:
    """One tool call -> (model feed, wire event): the clock is read HERE
    (instant, no pool slot) and the ``clock`` payload rides the event so
    the client's row renders the real value."""
    try:
        tz_arg, date_arg, offset_arg = parse_clock_call(call)
        payload = clock_payload(tz_arg, date_arg, offset_arg, default_tz)
    except ClockError as exc:
        return f"error: {exc}", {"round": rnd, "id": wire_id, "status": "error"}
    return (
        f'{{"clock": {json.dumps(payload, ensure_ascii=False, separators=(",", ":"))}}}',
        {"round": rnd, "id": wire_id, "status": "ok", "clock": payload},
    )
