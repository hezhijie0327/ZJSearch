# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""A plugin to convert currency pairs given in the query term (e.g.
``5 usd to cny``).  It complements the unit_converter plugin: currency rates
are dynamic, so this plugin fetches the Frankfurter API v2 aggregated rates
and carries the whole rate table of the queried base currency in the payload
-- the theme's converter can then switch between any listed pair without a
new request.

The accepted currency codes are not hardcoded: the plugin caches the API's
currency list (``/v2/currencies``) for a day and gates queries against it.

Rates are cached in-process for an hour (reference rates move once a
business day).  When the rate table is unavailable the plugin is silent --
queries simply get no answer.
"""

import asyncio
import concurrent.futures
import json
import logging
import time
import typing
import re
import babel.numbers

from curl_cffi.requests.exceptions import RequestException

from flask_babel import gettext, get_locale

from searx.network.client import get_loop
from searx.network.network import get_network
from searx.plugins import Plugin, PluginInfo
from searx.result_types import EngineResults

if typing.TYPE_CHECKING:
    from searx.search import SearchWithPlugins
    from searx.extended_types import SXNG_Request
    from searx.plugins import PluginCfg

logger = logging.getLogger("searx.plugins.currency_convert")


CONVERT_KEYWORDS = ["in", "to", "as"]

RE_MEASURE = r'''
(?P<sign>[-+]?)         # +/- or nothing for positive
(\s*)                   # separator: white space or nothing
(?P<number>[\d\.,]*)    # number: 1,000.00 (en) or 1.000,00 (de)
(?P<E>[eE][-+]?\d+)?    # scientific notation: e(+/-)2 (*10^2)
(\s*)                   # separator: white space or nothing
(?P<unit>\S+)           # unit of measure (ISO-4217 alpha code)
'''

FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rates?base={base}"
CURRENCIES_URL = "https://api.frankfurter.dev/v2/currencies"
CURRENCY_CACHE_TTL = 3600.0
"""Reference rates are updated once per business day; an hour is plenty."""

CURRENCY_LIST_TTL = 86400.0
"""The currency catalogue is static in practice; refreshing once a day is plenty."""

_currency_cache: dict[str, tuple[float, dict[str, float]]] = {}
"""base currency -> (monotonic fetch time, rates ``X per 1 base``)."""

_currency_codes: frozenset[str] | None = None
"""Cached catalogue of ISO codes the API can serve, with fetch time."""


def _supported_currencies() -> frozenset[str] | None:
    """The ISO codes the API accepts (``/v2/currencies``), cached for a day.
    ``None`` while the catalogue is unavailable -- the plugin stays silent.

    The fetch goes through the instance's default network, so the
    ``outgoing.proxies`` settings apply like for every engine."""
    global _currency_codes
    now = time.monotonic()
    if _currency_codes and now - _currency_codes[0] < CURRENCY_LIST_TTL:
        return _currency_codes[1]

    future = asyncio.run_coroutine_threadsafe(
        get_network().request("GET", CURRENCIES_URL, allow_redirects=True, timeout=8),
        get_loop(),
    )
    try:
        body = future.result(timeout=12).text
    except (concurrent.futures.TimeoutError, RequestException) as exc:
        # no user-facing message -- silence is fine, the query simply gets no answer
        logger.warning("currency list fetch failed: %r", exc)
        return None

    try:
        # v2 answers with a JSON array of currency objects ("iso_code", ...)
        codes = frozenset(c["iso_code"].upper() for c in json.loads(body))
    except (ValueError, KeyError, AttributeError, TypeError) as exc:
        logger.warning("unexpected currency list payload: %r", exc)
        return None
    if not codes:
        logger.warning("empty currency list payload")
        return None

    _currency_codes = (now, codes)
    return codes


def _currency_rates(base: str) -> dict[str, float] | None:
    """Rates of the dimension: ``X per 1 base`` for every supported currency.
    Cached in-process (rates move once a day, searches don't have to).

    The fetch goes through the instance's default network, so the
    ``outgoing.proxies`` settings apply like for every engine."""
    now = time.monotonic()
    cached = _currency_cache.get(base)
    if cached and now - cached[0] < CURRENCY_CACHE_TTL:
        return cached[1]

    future = asyncio.run_coroutine_threadsafe(
        get_network().request("GET", FRANKFURTER_URL.format(base=base), allow_redirects=True, timeout=8),
        get_loop(),
    )
    try:
        body = future.result(timeout=12).text
    except (concurrent.futures.TimeoutError, RequestException) as exc:
        # no user-facing message -- silence is fine, the query simply gets no answer
        logger.warning("currency rates fetch failed: %r", exc)
        raise RequestException(f"currency rates unavailable ({exc})") from exc

    try:
        # v2 answers with a JSON array of {"date", "base", "quote", "rate"}
        # rows; error payloads (e.g. HTTP 422 for an invalid currency) are a
        # dict instead, which surfaces here as a TypeError.
        rows = json.loads(body)
        rates = {r["quote"]: float(r["rate"]) for r in rows if float(r["rate"]) > 0}
    except (ValueError, KeyError, TypeError) as exc:
        raise RequestException("unexpected currency rates payload") from exc
    if not rates:
        raise RequestException("empty currency rates payload")

    _currency_cache[base] = (now, rates)
    return rates


def _convert(base: str, to_unit: str, value: float, locale: str) -> tuple[str, dict] | None:
    """Convert ``value`` from currency ``base`` to ``to_unit`` and build the
    payload of the theme's interactive converter (factors of every listed
    currency relative to ``base``)."""
    rates = _currency_rates(base)
    if rates is None:
        return None
    rate = 1.0 if to_unit == base else rates.get(to_unit)
    if not rate:
        return None

    format_args = {"locale": locale, "format": "#,##0.##########;-#"}
    result = babel.numbers.format_decimal(value * rate, **format_args)
    from_value = babel.numbers.format_decimal(value, **format_args)

    units = [{"symbol": base, "to_si": 1.0}]
    # v2 lists the base currency itself at rate 1.0 -- skip it, "base" is
    # already the units head above.
    units.extend({"symbol": sym, "to_si": 1.0 / r} for sym, r in sorted(rates.items()) if r and sym != base)

    data = {
        "kind": "unit_conversion",
        "from_value": from_value,
        "from_unit": base,
        "to_value": result,
        "to_unit": to_unit,
        "units": units,
    }
    return f'{result} {to_unit}', data


class SXNGPlugin(Plugin):
    """Convert currency pairs.  The result is displayed in the "answers" area
    with the same interactive converter as the unit_converter plugin."""

    id = "currency_convert"

    def __init__(self, plg_cfg: "PluginCfg") -> None:
        super().__init__(plg_cfg)

        self.info = PluginInfo(
            id=self.id,
            name=gettext("Currency converter plugin"),
            description=gettext("Convert between currencies (Frankfurter aggregated rates)"),
            preference_section="general",
        )

    def post_search(self, request: "SXNG_Request", search: "SearchWithPlugins") -> EngineResults:
        results = EngineResults()

        # only convert on the first page
        if search.search_query.pageno > 1:
            return results

        query = search.search_query.query
        query_parts = query.split(" ")

        if len(query_parts) < 3:
            return results

        for query_part in query_parts:
            for keyword in CONVERT_KEYWORDS:
                if query_part == keyword:
                    from_query, to_query = query.split(keyword, 1)
                    converted = _parse_and_convert(from_query.strip(), to_query.strip())
                    if converted:
                        answer, data = converted
                        results.add(results.types.Answer(answer=answer, data=data))
                    break

        return results


def _parse_and_convert(from_query, to_query) -> tuple[str, dict] | None:
    if not (from_query and to_query):
        return None

    measured = re.match(RE_MEASURE, from_query, re.VERBOSE)
    if not (measured and measured.group('unit')):
        return None

    from_cur = (measured.group('unit') or '').upper()
    to_cur = to_query.strip().upper()
    codes = _supported_currencies()
    if not codes or from_cur not in codes or to_cur not in codes:
        return None

    locale = get_locale() or 'en_US'
    # a value-less query ("usd to cny") converts 1 by default, like the search
    # engines' own converters
    value = measured.group('sign') + (measured.group('number') or '1') + (measured.group('E') or '')
    value = babel.numbers.parse_decimal(value, locale=locale)

    return _convert(from_cur, to_cur, float(value), locale)
