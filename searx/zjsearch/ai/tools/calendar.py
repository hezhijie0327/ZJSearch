# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``calendar`` tool: the ONE composite time/date surface -- the wall
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
pretend).  Every payload also carries a LUNAR block (ganzhi year,
zodiac, lunar month/day, the day's solar term, the festivals hitting
the day) computed through ``cnlunar`` -- a lunar-calendar question is a
lookup, never something the model composes.  The tool is registered for
EVERY research run and the overview: the ``<today>`` block only grounds
the DATE -- the clock time is never guessable, calendar arithmetic must
not ride mental math, and a long run's start-of-run date goes stale (a
re-read mid-run is one free call).

The instant the payload answers is the moment of the CALL, not of the
run -- that freshness is the point."""

import datetime
import json
import typing as t
from zoneinfo import ZoneInfo

from searx.zjsearch.ai.core.dates import resolve_zone, weekday_name
from searx.zjsearch.ai.core.text import raw_args

try:
    import cnlunar  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    cnlunar = None
"""The lunar-calendar engine -- OPTIONAL by design: a deployment without
it loses the ``lunar`` block (the block is omitted, never faked), the
clock itself keeps answering."""

try:
    import chinese_calendar  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    chinese_calendar = None
"""The statutory-holiday data (holidays AND make-up workdays, the
State-Council arrangements) -- OPTIONAL like ``cnlunar``; its table
ends where the annual announcement ends and the block reports the
boundary honestly."""

CALENDAR_TOOL = "calendar"

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
Every payload carries a lunar block (ganzhi year, zodiac, lunar
month/day, solar term, festivals, the statutory workday verdict) --
quote it for lunar-calendar, festival and workday questions, never
compose a lunar date yourself.  The statutory verdict is only as
current as the deployment's data: the block reports its coverage end
(`coverage_until`) -- for a LATER date say the arrangement is not
loaded and fall back to a web search for the official announcement;
never infer a holiday or a make-up workday.
One call answers in the user's zone by default; pass tz to convert for
another zone."""

_MAX_OFFSET_DAYS = 3650
"""Offset clamp: a decade either way -- the honest bound for a research
calendar (an offset beyond it is a model slip, not a question)."""

_LUNAR_MIN_YEAR = 1900
_LUNAR_MAX_YEAR = 2100
"""The lunar engine's honest coverage window (the library's table
range) -- outside it the block is omitted, never approximated."""

_LUNAR_FESTIVALS = {(1, 1): "春节", (1, 15): "元宵节", (2, 2): "龙抬头", (5, 5): "端午节", (7, 7): "七夕", (7, 15): "中元节", (8, 15): "中秋节", (9, 9): "重阳节", (12, 8): "腊八节"}  # in _LUNAR_FESTIVALS table data
"""The traditional lunar festivals keyed by (lunar month, lunar day) --
fixed table data (the CJK audit's functional-data exemption, the
stock_quote precedent), because the library's own folk-holiday feed
mixes deity birthdays in and misses festival days.  The year's last
lunar day is COMPUTED, not tabled (some years have no 30th), and
festivals never land in a leap month (they follow the first month)."""

_MONTH_SIZE_SUFFIXES = (chr(0x5927), chr(0x5c0f))
"""The month-size suffixes the library appends to the lunar month
name -- composed by codepoint so the source stays ASCII outside the
allowlisted data line."""
_NEW_YEARS_EVE = chr(0x9664) + chr(0x5915)
"""The year's-eve festival name -- composed by codepoint (the same
doctrine); the DAY it lands on is computed against the library, never
assumed from the month length."""


def _as_list(value: t.Any) -> list[str]:
    """The library's holiday feeds return "" / a name / a list of names
    depending on the day -- one normalized list of non-empty strings."""
    if not value:
        return []
    if isinstance(value, (list, tuple)):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value).strip()
    return [text] if text else []


def _workday_block(day: datetime.date) -> dict[str, t.Any] | None:
    """The statutory WORKDAY block for one day -- ``off`` (holiday or
    ordinary weekend), ``workday`` or ``makeup`` (a make-up workday,
    named for the festival it compensates), with the package's own
    (English) holiday name riding verbatim -- the data is the ground,
    the model localizes the prose.  ``coverage_until`` names the data's
    last announced day so a stale dependency is VISIBLE (the doctrine
    for out-of-coverage dates lives in INSTRUCTIONS: fall back to a
    search, never infer).  Outside the announced coverage the verdict
    is dropped (the block rides with a null ``status``): an unknown
    year's arrangement must never read as "workday"."""
    if chinese_calendar is None:
        return None
    try:
        boundary = max(chinese_calendar.holidays.keys())
        is_holiday, name = chinese_calendar.get_holiday_detail(day)
    except Exception:  # pylint: disable=broad-except
        return None
    name = str(name).strip() if name else None
    covered = day <= boundary
    status = ("off" if is_holiday else ("makeup" if name else "workday")) if covered else None
    return {"status": status, "name": name if covered else None, "coverage_until": boundary.isoformat()}


def _lunar_block(day: datetime.date) -> dict[str, t.Any] | None:
    """The FULL lunar-calendar block for one day -- the lunar date
    (ganzhi + year characters + zodiac + month/day with the leap prefix
    in the month string), the ganzhi pillars, the day's solar term and
    the next one, the festivals (our lunar table + the statutory feed),
    the folk observances, the statutory workday verdict and the
    traditional almanac (suited/avoided activities, the auspicious and
    inauspicious gods, the 12-day officer with its ecliptic mark, the
    28 mansions, the nayin, Pengzu's taboos, the lucky directions, the
    fetus god, the moon phase).  Outside the coverage window (or on any
    library hiccup) the block is OMITTED -- a missing lunar answer
    beats a wrong one."""
    if cnlunar is None or not (_LUNAR_MIN_YEAR <= day.year <= _LUNAR_MAX_YEAR):
        return None
    try:
        d = cnlunar.Lunar(datetime.datetime(day.year, day.month, day.day), godType="8char")
        month = str(d.lunarMonthCn or "")
        if month and month[-1] in _MONTH_SIZE_SUFFIXES:
            month = month[:-1]
        festivals: list[str] = []
        if not d.isLunarLeapMonth:
            tabled = _LUNAR_FESTIVALS.get((d.lunarMonth, d.lunarDay))
            if tabled:
                festivals.append(tabled)
            # the year's eve: the day BEFORE the first month's day one
            # (computed against the library, never assumed -- some years
            # end on the 29th)
            eve = cnlunar.Lunar(
                datetime.datetime.combine(day + datetime.timedelta(days=1), datetime.time()),
                godType="8char",
            )
            if eve.lunarMonth == 1 and eve.lunarDay == 1 and not eve.isLunarLeapMonth:
                festivals.append(_NEW_YEARS_EVE)
        for legal in _as_list(d.get_legalHolidays()):
            if legal not in festivals:
                festivals.append(legal)
        term = str(d.todaySolarTerms or "").strip()
        # the next solar term's (month, day) rolls into next year once
        # the term's month is behind the day's own (the terms' months
        # are monotonic within one year)
        term_month, term_day = d.nextSolarTermDate
        next_year = day.year + (1 if term_month < day.month else 0)
        officer_12 = d.get_today12DayOfficer()
        almanac = {
            "suited": _as_list(d.goodThing),
            "avoided": _as_list(d.badThing),
            "gods": _as_list(d.goodGodName),
            "avoid_gods": _as_list(d.badGodName),
            "officer": officer_12[0] if officer_12 else "",
            "ecliptic": officer_12[2] if officer_12 else "",
            "duty_god": officer_12[1] if len(officer_12) > 2 else "",
            "mansions": str(d.today28Star or ""),
            "east_star": str(d.todayEastZodiac or ""),
            "nayin": str(d.get_nayin() or ""),
            "pengzu": str(d.get_pengTaboo() or ""),
            "directions": _as_list(d.get_luckyGodsDirection()),
            "fetus_god": str(d.get_fetalGod() or ""),
            "moon": str(d.phaseOfMoon or ""),
        }
        return {
            "year": str(d.year8Char or ""),
            "year_cn": str(d.lunarYearCn or ""),
            "zodiac": str(d.chineseYearZodiac or ""),
            "month": month,
            "day": str(d.lunarDayCn or ""),
            "leap": bool(d.isLunarLeapMonth),
            "season": str(d.get_season() or ""),
            "ganzhi": {
                "year": str(d.year8Char or ""),
                "month": str(d.month8Char or ""),
                "day": str(d.day8Char or ""),
            },
            "term": "" if term in ("", "\u65e0") else term,
            "next_term": {
                "name": str(d.nextSolarTerm or ""),
                "date": f"{next_year:04d}-{term_month:02d}-{term_day:02d}",
            },
            "festivals": festivals,
            "solar_holidays": _as_list(d.get_otherHolidays()),
            "folk": _as_list(d.get_otherLunarHolidays()),
            "workday": _workday_block(day),
            "almanac": almanac,
        }
    except Exception:  # pylint: disable=broad-except
        return None


class CalendarError(ValueError):
    """One rejected call -- the message goes back to the model, so it
    can fix the arguments instead of guessing."""


def calendar_spec() -> dict[str, t.Any]:
    """The ``calendar`` tool spec -- the three semantics live on one api:
    no args = now; ``date`` = absolute lookup (wins over ``offset_days``
    when both are passed); ``offset_days`` = relative to today."""
    return {
        "name": CALENDAR_TOOL,
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


def parse_calendar_call(call: dict[str, t.Any]) -> tuple[str, str, int | None]:
    """(tz, date, offset_days) of one ``calendar`` call -- sanitized: the
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
        raise CalendarError(f"offset_days must be an integer ({-_MAX_OFFSET_DAYS}..{_MAX_OFFSET_DAYS})") from None
    return tz, date, offset


def _resolve_zone(tz: str) -> tuple[ZoneInfo | None, str]:
    """(zone, name) for one ``tz`` argument -- an explicit (model-chosen)
    name that fails to resolve is an ERROR (the model can fix it); the
    empty name resolves to no zone (the caller's fallback decides).
    The tolerant shared resolve lives in ``core.dates``; this wrapper
    adds the tool's raising contract."""
    zone, name = resolve_zone(tz)
    if zone is None and name:
        raise CalendarError(f"unknown timezone {name!r} -- pass an IANA name like 'Asia/Shanghai'")
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
        raise CalendarError(f"date {text!r} is not a real calendar date: {exc}") from exc
    raise CalendarError(f'date must be "YYYY-MM-DD", "MM-DD" (current year) or a bare day "DD" (current month), got {text!r}')


def calendar_payload(
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
        # the TARGET's lunar fields -- "which lunar day is Mid-Autumn" is
        # a date-mode lookup
        payload["lunar"] = _lunar_block(target)
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
    # the lunar block rides BOTH modes -- a lunar-date chat question is a now lookup
    payload["lunar"] = _lunar_block(today)
    return payload


def run_call(
    call: dict[str, t.Any], rnd: int, wire_id: int, default_tz: str | None = None
) -> tuple[str, dict[str, t.Any]]:
    """One tool call -> (model feed, wire event): the clock is read HERE
    (instant, no pool slot) and the ``calendar`` payload rides the event so
    the client's row renders the real value."""
    try:
        tz_arg, date_arg, offset_arg = parse_calendar_call(call)
        payload = calendar_payload(tz_arg, date_arg, offset_arg, default_tz)
    except CalendarError as exc:
        return f"error: {exc}", {"round": rnd, "id": wire_id, "status": "error"}
    return (
        f'{{"calendar": {json.dumps(payload, ensure_ascii=False, separators=(",", ":"))}}}',
        {"round": rnd, "id": wire_id, "status": "ok", "calendar": payload},
    )
