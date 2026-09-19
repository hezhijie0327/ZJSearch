# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
# pylint: disable=missing-module-docstring

import asyncio
import datetime
import json
import logging
import re
import time
import typing as t

from flask_babel import gettext

from searx.network.client import get_loop
from searx.network.network import get_network
from searx.result_types import EngineResults
from searx.utils import gen_useragent

from . import Plugin, PluginInfo

if t.TYPE_CHECKING:
    from searx.search import SearchWithPlugins
    from searx.extended_types import SXNG_Request
    from searx.plugins import PluginCfg

logger = logging.getLogger("searx.plugins.stock_quote")

CACHE_TTL = 60.0
"""Quotes move by the minute; repeated searches inside a minute reuse one fetch."""

FETCH_TIMEOUT = 3.0
"""Per-request budget.  A provider that cannot answer within it fails and the
lookup falls back to the other one; parallel batches cost the slowest request,
not the sum."""

QUOTE_CACHE: dict[str, tuple[float, dict[str, t.Any] | None]] = {}
"""``{source}:{symbol}`` -> (fetch time, payload or None while the resolve failed)."""

SUFFIX_RE = re.compile(r"^(.*\S)\s+(?:stock|quote)$", re.IGNORECASE)
PREFIX_DOLLAR_RE = re.compile(r"^\$([A-Za-z0-9.\-]{1,16})$")


def _parse_symbol(query: str) -> str | None:
    """``$AAPL`` or ``AAPL stock`` -> symbol or search term.  ``None`` when
    the query is not a stock quote request."""
    query = query.strip()
    match = PREFIX_DOLLAR_RE.match(query)
    if match:
        return match.group(1)
    match = SUFFIX_RE.match(query)
    if match:
        return match.group(1).strip()
    return None


def _headers() -> dict[str, str]:
    return {"User-Agent": gen_useragent()}


def _fetch_json(url: str) -> t.Any:
    future = asyncio.run_coroutine_threadsafe(
        get_network().request("GET", url, allow_redirects=True, timeout=FETCH_TIMEOUT, headers=_headers()),
        get_loop(),
    )
    return json.loads(future.result(timeout=FETCH_TIMEOUT + 1).text)


def _fetch_json_multi(urls: list[str]) -> list[t.Any]:
    """Fetch several URLs in parallel through the instance's default network
    (``outgoing.proxies`` apply like for every engine).  A failed item is
    ``None`` instead of aborting the batch."""
    loop = get_loop()
    futures = [
        asyncio.run_coroutine_threadsafe(
            get_network().request("GET", url, allow_redirects=True, timeout=FETCH_TIMEOUT, headers=_headers()),
            loop,
        )
        for url in urls
    ]
    out: list[t.Any] = []
    for future in futures:
        try:
            out.append(json.loads(future.result(timeout=FETCH_TIMEOUT + 1).text))
        except Exception:  # pylint: disable=broad-except
            out.append(None)
    return out


def _fetch_json_seq(urls: list[str]) -> list[t.Any]:
    """Sequential variant of :py:func:`_fetch_json_multi`.  Tencent's kline
    host drops concurrent connections from one client, so its batches run one
    after another (a failed item is ``None`` instead of aborting the batch)."""
    out: list[t.Any] = []
    for url in urls:
        try:
            out.append(_fetch_json(url))
        except Exception:  # pylint: disable=broad-except
            out.append(None)
    return out


# ----------------------------------------------------------------- eastmoney

EM_SUGGEST_URL = "https://searchapi.eastmoney.com/api/suggest/get?input={input}&type=14"
EM_QUOTE_URL = (
    "https://push2.eastmoney.com/api/qt/stock/get?secid={secid}"
    "&fields=f43,f44,f45,f46,f57,f58,f59,f60,f116,f162,f169,f170"
)
EM_KLINE_URL = (
    "https://push2his.eastmoney.com/api/qt/stock/kline/get"
    "?secid={secid}&fields1=f1,f2,f3&fields2={fields2}&klt={klt}&fqt=1&end=20500101&lmt={lmt}"
)
EM_FIELDS_FULL = "f51,f52,f53,f54,f55,f56"  # date,open,close,high,low,volume


def _eastmoney_resolve(symbol: str) -> dict[str, t.Any] | None:
    table = _fetch_json(EM_SUGGEST_URL.format(input=symbol)).get("QuotationCodeTable") or {}
    data = table.get("Data")
    if not data:
        return None
    return data[0]


def _eastmoney_series(klines: list[str]) -> dict[str, t.Any]:
    """Full klines (``date,open,close,high,low,volume``) -> labels + candles."""
    return {
        "labels": [k.split(",")[0] for k in klines],
        "candles": [[float(k.split(",")[i]) for i in (1, 3, 4, 2, 5)] for k in klines],
    }


def _eastmoney_fetch(symbol: str) -> dict[str, t.Any] | None:
    suggestion = _eastmoney_resolve(symbol)
    if not suggestion:
        return None

    secid = suggestion["QuoteID"]
    code = suggestion.get("Code") or symbol
    name = suggestion.get("Name") or symbol
    market_label = suggestion.get("SecurityTypeName") or ""
    exchange = suggestion.get("JYS") or ""

    year_start = f"{datetime.date.today().year}-01-01"
    # 1M/YTD derive from the 1Y daily bars, so six requests cover all ranges
    quote_j, k1d, k5d, k1y_j, k5y_j, kmax_j = _fetch_json_multi(
        [
            EM_QUOTE_URL.format(secid=secid),
            EM_KLINE_URL.format(secid=secid, fields2=EM_FIELDS_FULL, klt=5, lmt=80),
            EM_KLINE_URL.format(secid=secid, fields2=EM_FIELDS_FULL, klt=15, lmt=130),
            EM_KLINE_URL.format(secid=secid, fields2=EM_FIELDS_FULL, klt=101, lmt=250),
            EM_KLINE_URL.format(secid=secid, fields2=EM_FIELDS_FULL, klt=102, lmt=270),
            EM_KLINE_URL.format(secid=secid, fields2=EM_FIELDS_FULL, klt=103, lmt=400),
        ]
    )

    q = (quote_j or {}).get("data") or {}
    if not q:
        return None
    scale = 10 ** int(q.get("f59") or 2)

    def scaled(field: str) -> float | None:
        value = q.get(field)
        return None if value in (None, 0) else value / scale

    price = scaled("f43")
    if price is None:
        return None
    previous_close = scaled("f60")
    if previous_close is None:
        return None
    change = scaled("f169")
    if change is None:
        change = round(price - previous_close, 2)
    # f170's own scale is inconsistent across markets -- deriving the percent
    # from price/previous_close is exact everywhere
    change_percent = round(change / previous_close * 100, 2) if previous_close else 0.0

    daily_full = (k1y_j or {}).get("data") or {}
    daily_klines: list[str] = daily_full.get("klines") or []
    daily_closes = [float(k.split(",")[2]) for k in daily_klines]
    daily_highs = [float(k.split(",")[3]) for k in daily_klines]
    daily_lows = [float(k.split(",")[4]) for k in daily_klines]
    daily_volumes = [float(k.split(",")[5]) for k in daily_klines]

    ytd_klines = [k for k in daily_klines if k.split(",")[0] >= year_start]

    def bounds(klines: list[str]) -> list[str]:
        return [klines[0].split(",")[0], klines[-1].split(",")[0]] if klines else ["", ""]

    as_of_date, as_of_time = "", ""
    intraday = ((k1d or {}).get("data") or {}).get("klines") or []
    if intraday:
        as_of_date, _, as_of_time = intraday[-1].split(",")[0].partition(" ")
    if not as_of_date and daily_klines:
        as_of_date = daily_klines[-1].split(",")[0]

    ranges = {
        "1D": _eastmoney_series(intraday),
        "5D": _eastmoney_series(((k5d or {}).get("data") or {}).get("klines") or []),
        "1M": _eastmoney_series(daily_klines[-23:]),
        "YTD": _eastmoney_series(ytd_klines),
        "1Y": _eastmoney_series(daily_klines),
        "5Y": _eastmoney_series(((k5y_j or {}).get("data") or {}).get("klines") or []),
        "MAX": _eastmoney_series(((kmax_j or {}).get("data") or {}).get("klines") or []),
    }
    range_bounds = {
        "1D": bounds(intraday),
        "5D": bounds(((k5d or {}).get("data") or {}).get("klines") or []),
        "1M": bounds(daily_klines[-23:]),
        "YTD": bounds(ytd_klines),
        "1Y": bounds(daily_klines),
        "5Y": bounds(((k5y_j or {}).get("data") or {}).get("klines") or []),
        "MAX": bounds(((kmax_j or {}).get("data") or {}).get("klines") or []),
    }
    # drop empty series so the client only offers ranges that carry data
    ranges = {key: value for key, value in ranges.items() if value["candles"]}
    range_bounds = {key: value for key, value in range_bounds.items() if key in ranges}

    avg_volume = round(sum(daily_volumes) / len(daily_volumes)) if daily_volumes else None

    currency = "USD" if "美" in market_label else ("HKD" if "港" in market_label else "CNY")

    return {
        "kind": "stock",
        "symbol": code,
        "name": name,
        "market": market_label,
        "exchange": exchange,
        "currency": currency,
        "price": price,
        "previous_close": previous_close,
        "change": change,
        "change_percent": change_percent,
        "open": scaled("f46"),
        "high": scaled("f44"),
        "low": scaled("f45"),
        # eastmoney does not compute a P/E for US listings
        "pe": scaled("f162"),
        "market_cap": q.get("f116"),
        "week52_high": max(daily_highs) if daily_highs else None,
        "week52_low": min(daily_lows) if daily_lows else None,
        "avg_volume": avg_volume,
        "as_of_date": as_of_date,
        "as_of_time": as_of_time,
        "ranges": ranges,
        "range_bounds": range_bounds,
    }



def _avg_volume(day_candles: list[list[float]]) -> float | None:
    volumes = [c[4] for c in day_candles[-250:]]
    return round(sum(volumes) / len(volumes)) if volumes else None


# ------------------------------------------------------------------- tencent

TX_BASE = "https://web.ifzq.gtimg.cn"
TX_KLINE_URL = TX_BASE + "/appstock/app/fqkline/get?param={symbol},{granularity},{start},{end},{count},qfq"
TX_MKLINE_URL = TX_BASE + "/appstock/app/kline/mkline?param={symbol},{granularity},,{count}"
# tencent bar rows: [date, open, close, high, low, volume(, extra ...)]
TX_ROW_CANDLE = (1, 3, 4, 2, 5)  # open, high, low, close, volume


def _tencent_symbol(symbol: str) -> str:
    """Normalize a user symbol to a tencent one (``sh600519``, ``hk00700``,
    ``usAAPL``).  Already-prefixed symbols pass through unchanged.  US tickers
    are upper-cased: tencent's kline host is case-sensitive there and serves
    a stripped response for the all-lowercase spelling."""
    s = symbol.strip()
    low = s.lower()
    if re.fullmatch(r"(sh|sz|bj|hk|us)[0-9a-z.]{2,12}", low):
        return low[:2] + low[2:].upper() if low.startswith("us") else low
    if re.fullmatch(r"[0-9]{6}", low):
        if low[0] == "6":
            return "sh" + low
        if low[0] in "48":
            return "bj" + low
        return "sz" + low
    hk = re.fullmatch(r"([0-9]{1,5})\.?hk", low)
    if hk:
        return "hk" + hk.group(1).zfill(5)
    if re.fullmatch(r"[a-z]{1,6}", low):
        return "us" + s.upper()
    return s


def _tx_label(raw: str) -> str:
    digits = raw.replace("-", "").replace(":", "").replace(" ", "")
    if len(digits) >= 12:
        return f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]} {digits[8:10]}:{digits[10:12]}"
    if len(digits) == 8:
        return f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}"
    return raw


def _candles(rows: list[list], o: int, h: int, low: int, c: int, v: int) -> list[list[float]]:
    out = []
    for row in rows:
        try:
            out.append([float(row[i]) for i in (o, h, low, c, v)])
        except (ValueError, IndexError):
            continue
    return out


def _qt_float(qt: list[str], index: int) -> float | None:
    if index >= len(qt) or qt[index] in ("", None):
        return None
    try:
        return float(qt[index])
    except ValueError:
        return None


def _tencent_fetch(symbol: str) -> dict[str, t.Any] | None:
    tx_symbol = _tencent_symbol(symbol)
    # qt[1] carries the listing name; the bare code is the fallback
    code = tx_symbol[2:].upper()
    name = code

    year_start = f"{datetime.date.today().year}-01-01"

    def node_of(payload: t.Any, symbol: str) -> dict[str, t.Any]:
        data = (payload or {}).get("data") or {}
        return data.get(symbol) or {}

    def rows_of(node: dict[str, t.Any], *keys: str) -> list[list]:
        rows: list[list] = []
        for key in keys:
            rows = rows or node.get(key) or []
        return rows

    def qt_of(node: dict[str, t.Any], *symbols: str) -> list[str]:
        qt_node = node.get("qt") or {}
        for symbol in symbols:
            qt = qt_node.get(symbol)
            if isinstance(qt, list) and len(qt) >= 30:
                return qt
        # degraded realtime block (US responses sometimes carry only a sparse
        # field dict) -- the daily bars take over for the quote fields below
        return []

    # the bare-symbol day response always carries the realtime qt block whose
    # index 2 holds the exchange-suffixed code (e.g. AAPL.OQ) that unlocks the
    # full US history -- the bare "usAAPL" series itself is a couple of bars
    # at most, so refetch under the suffix when the history looks truncated
    series_symbol = tx_symbol
    day_j = _fetch_json(TX_KLINE_URL.format(symbol=tx_symbol, granularity="day", start="", end="", count=280))
    day_node = node_of(day_j, tx_symbol)
    day_rows = rows_of(day_node, "qfqday", "day")
    qt = qt_of(day_node, tx_symbol)
    if len(day_rows) < 30 and len(qt) > 2 and str(qt[2]).strip():
        series_symbol = f"{tx_symbol[:2]}{str(qt[2]).strip()}"
        day_j = _fetch_json(TX_KLINE_URL.format(symbol=series_symbol, granularity="day", start="", end="", count=280))
        day_node = node_of(day_j, series_symbol)
        day_rows = rows_of(day_node, "qfqday", "day")
        qt = qt_of(day_node, series_symbol, tx_symbol)

    week_j, m5_j, m15_j = _fetch_json_seq(
        [
            TX_KLINE_URL.format(symbol=series_symbol, granularity="week", start="", end="", count=320),
            TX_MKLINE_URL.format(symbol=series_symbol, granularity="m5", count=80),
            TX_MKLINE_URL.format(symbol=series_symbol, granularity="m15", count=130),
        ]
    )

    week_rows = rows_of(node_of(week_j, series_symbol), "qfqweek", "week")
    m5_rows = rows_of(node_of(m5_j, series_symbol), "m5")
    m15_rows = rows_of(node_of(m15_j, series_symbol), "m15")
    if not day_rows:
        return None

    day_candles = _candles(day_rows, *TX_ROW_CANDLE)

    qt_float = lambda index: _qt_float(qt, index)  # noqa: E731
    if len(qt) > 1 and qt[1]:
        name = str(qt[1])

    # the qt layout differs per market: CN/HK report the P/E at index 52 and
    # 52-week extremes at 47/48; US listings carry the P/E at index 39 and
    # no 52-week extremes at all
    is_us = tx_symbol.startswith("us")

    # realtime fields first, daily bars as the fallback (close vs prior close)
    last_bar = day_candles[-1] if day_candles else None
    prev_bar = day_candles[-2] if len(day_candles) >= 2 else None

    price = qt_float(3)
    if price is None and last_bar:
        price = last_bar[3]
    previous_close = qt_float(4)
    if previous_close is None and prev_bar:
        previous_close = prev_bar[3]
    if price is None or previous_close is None:
        return None
    change = qt_float(31)
    if change is None:
        change = round(price - previous_close, 2)
    change_percent = qt_float(32)
    if change_percent is None:
        change_percent = round(change / previous_close * 100, 2) if previous_close else 0.0

    market_cap = qt_float(45)
    market_cap = market_cap * 1e8 if market_cap is not None else None

    open_price = qt_float(5)
    if open_price is None and last_bar:
        open_price = last_bar[0]
    high = qt_float(33)
    if high is None and last_bar:
        high = last_bar[1]
    low = qt_float(34)
    if low is None and last_bar:
        low = last_bar[2]

    # 52-week extremes always derive from the daily bars -- the qt indexes
    # that carry them differ per market and some layouts misreport; a shorter
    # history says nothing about a year, so the card hides them instead
    recent = day_candles[-250:] if len(day_candles) >= 30 else []
    week52_high = max(c[1] for c in recent) if recent else None
    week52_low = min(c[2] for c in recent) if recent else None

    def rows_series(rows: list[list]) -> dict[str, t.Any]:
        return {
            "labels": [_tx_label(str(row[0])) for row in rows],
            "candles": _candles(rows, *TX_ROW_CANDLE),
        }

    # a couple of bars say nothing about a month or a year either -- skip
    # those ranges instead of drawing two-point charts
    ranges = {
        "1D": rows_series(m5_rows) if m5_rows else None,
        "5D": rows_series(m15_rows) if m15_rows else None,
        "1M": rows_series(day_rows[-23:]) if len(day_rows) >= 10 else None,
        "YTD": rows_series([r for r in day_rows if str(r[0]) >= year_start]) if len(day_rows) >= 10 else None,
        "1Y": rows_series(day_rows[-250:]) if len(day_rows) >= 100 else None,
        "5Y": rows_series(week_rows[-260:]) if len(week_rows) >= 100 else None,
        "MAX": rows_series(week_rows) if len(week_rows) >= 30 else None,
    }
    ranges = {key: value for key, value in ranges.items() if value and value["candles"]}
    range_bounds = {
        key: [value["labels"][0], value["labels"][-1]] if value["labels"] else ["", ""]
        for key, value in ranges.items()
    }

    as_of_date, as_of_time = _tencent_as_of(qt)
    if not as_of_date and day_rows:
        as_of_date = str(day_rows[-1][0])

    return {
        "kind": "stock",
        "symbol": code,
        "name": name,
        "market": _tx_market_label(tx_symbol),
        "exchange": exchange_of(tx_symbol),
        "currency": "USD" if tx_symbol.startswith("us") else ("HKD" if tx_symbol.startswith("hk") else "CNY"),
        "price": price,
        "previous_close": previous_close,
        "change": change,
        "change_percent": change_percent,
        "open": open_price,
        "high": high,
        "low": low,
        "pe": qt_float(39 if is_us else 52),
        "market_cap": market_cap,
        "week52_high": week52_high,
        "week52_low": week52_low,
        "avg_volume": _avg_volume(day_candles),
        "as_of_date": as_of_date,
        "as_of_time": as_of_time,
        "ranges": ranges,
        "range_bounds": range_bounds,
    }


def _tencent_as_of(qt: list[str]) -> tuple[str, str]:
    """Timestamps come in per-market layouts: CN/HK pack them as
    ``YYYYMMDDHHMM`` while US carries a dashed ``YYYY-MM-DD HH:MM`` string at
    a different index (a leading "delay" element shifts the whole array), so
    scan for either shape instead of trusting one position."""
    for raw in qt:
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})", str(raw))
        if m:
            return f"{m.group(1)}-{m.group(2)}-{m.group(3)}", f"{m.group(4)}:{m.group(5)}"
    for raw in qt:
        m = re.fullmatch(r"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})", str(raw))
        if m:
            return f"{m.group(1)}-{m.group(2)}-{m.group(3)}", f"{m.group(4)}:{m.group(5)}"
    return "", ""


def _tx_market_label(tx_symbol: str) -> str:
    if tx_symbol.startswith("sh"):
        return "沪A"
    if tx_symbol.startswith("sz"):
        return "深A"
    if tx_symbol.startswith("bj"):
        return "北A"
    if tx_symbol.startswith("hk"):
        return "港股"
    return "美股"


def exchange_of(tx_symbol: str) -> str:
    if tx_symbol.startswith("sh"):
        return "SH"
    if tx_symbol.startswith("sz"):
        return "SZ"
    if tx_symbol.startswith("bj"):
        return "BJ"
    if tx_symbol.startswith("hk"):
        return "HK"
    return "US"


# ------------------------------------------------------------------ dispatch

def _lookup(symbol: str) -> dict[str, t.Any] | None:
    """Cached ``symbol -> payload``.  Eastmoney is the primary source; when
    it fails -- or does not know the listing -- the same symbol is tried on
    tencent.  A total failure is cached for one TTL so a downed source is
    not hammered on every search."""
    cached = QUOTE_CACHE.get(symbol)
    if cached and time.monotonic() - cached[0] < CACHE_TTL:
        return cached[1]
    payload = None
    for fetch in (_eastmoney_fetch, _tencent_fetch):
        try:
            payload = fetch(symbol)
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("stock quote fetch failed via %s for %r: %r", fetch.__name__, symbol, exc)
            continue
        if payload:
            break
    QUOTE_CACHE[symbol] = (time.monotonic(), payload)
    return payload


@t.final
class SXNGPlugin(Plugin):
    """Stock quote answer: ``$AAPL``, ``AAPL stock`` render a quote card with
    price, change, range-switchable chart (1D/5D/1M/YTD/1Y/5Y/MAX) and a
    statistics grid.  The data source is configurable via the dedicated
    ``stock_quote.source`` setting (``eastmoney`` -- the default -- or
    ``tencent``); see ``settings.yml``."""

    id: str = "stock_quote"

    def __init__(self, plg_cfg: "PluginCfg"):
        super().__init__(plg_cfg)

        self.info = PluginInfo(
            id=self.id,
            name=gettext("Stock quote plugin"),
            description=gettext("Stock quote card with range charts and statistics ($AAPL, AAPL stock)."),
            preference_section="query",
            examples=["$AAPL", "AAPL stock"],
        )

    def post_search(self, request: "SXNG_Request", search: "SearchWithPlugins") -> EngineResults:
        results = EngineResults()
        if search.search_query.pageno > 1:
            return results

        symbol = _parse_symbol(search.search_query.query)
        if not symbol:
            return results

        payload = _lookup(symbol)
        if not payload:
            return results

        answer = (
            f"{payload['name']} ({payload['symbol']}): {payload['price']} {payload['currency']}"
            f" ({payload['change']:+.2f}, {payload['change_percent']:+.2f}%)"
        )
        results.add(
            results.types.Answer(
                answer=answer,
                template="answer/stock.html",
                data=payload,
            )
        )
        return results
