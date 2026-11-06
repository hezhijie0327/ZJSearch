# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Firecrawl is a web search API built for AI applications; its index leans
towards developer / research / gov content and it can optionally SCRAPE the
hits.  This engine searches only -- ``scrapeOptions`` stay home (every
scraped page costs extra credits on top of the search).

API keys come from the `Firecrawl dashboard <https://www.firecrawl.dev/app/dashboard>`_;
keyless requests are answered with heavy rate limits.

.. code:: yaml

  - name: firecrawl
    engine: firecrawl
    shortcut: fc
    api_key: "fc-..."
    disabled: false

The search honours searxng's ``time_range`` option through Google-style
``tbs`` filters (qdr:d/w/m/y).

One endpoint answers three source lanes, each served by its own engine
entry through :py:obj:`firecrawl_source` (like the upstream qwant module's
``qwant_categ``):

.. code:: yaml

  - name: firecrawl news
    engine: firecrawl
    shortcut: fcn
    firecrawl_source: news
    categories: news
    api_key: "fc-..."
    disabled: false

  - name: firecrawl images
    engine: firecrawl
    shortcut: fci
    firecrawl_source: images
    categories: [images, web]
    api_key: "fc-..."
    disabled: false
"""

import re
import typing as t
from datetime import datetime, timedelta, timezone

from dateutil import parser
from searx.exceptions import SearxEngineAPIException
from searx.result_types import EngineResults

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams


FirecrawlSource = t.Literal["web", "news", "images"]

about = {
    "website": "https://www.firecrawl.dev",
    "wikidata_id": None,
    "official_api_documentation": "https://docs.firecrawl.dev/features/search",
    "use_official_api": True,
    "require_api_key": False,
    "results": "JSON",
}

categories = ["general", "web"]
# the search API documents no pagination parameter -- one page per query
paging = False

base_url = "https://api.firecrawl.dev"
api_key = ""
firecrawl_source: FirecrawlSource = "web"
"""Which result lane this instance serves: ``web`` (default), ``news`` or
``images`` -- all answered by the same /v2/search endpoint."""
results_per_page = 10
"""Kept at 10 on purpose: credits bill per RESULT (2 per 10, rounded up) --
a 100-row search would spend 20 credits where 10 rows spend 2.  The API
accepts up to 100+ (verified live) and the lane cannot paginate; raise this
per instance when the extra rows are worth the burn."""

time_range_support = True
time_range_dict = {
    "day": "qdr:d",
    "week": "qdr:w",
    "month": "qdr:m",
    "year": "qdr:y",
}


def setup(engine_data: dict[str, t.Any]):
    if firecrawl_source not in t.get_args(FirecrawlSource):
        raise ValueError(f"firecrawl_source '{firecrawl_source}' is not supported (one of: web, news, images)")
    if not 1 <= results_per_page <= 100:
        raise ValueError("results_per_page must be between 1 and 100")


def request(query: str, params: "OnlineParams"):
    body: dict[str, t.Any] = {
        "query": query,
        "sources": [firecrawl_source],
        "limit": results_per_page,
    }
    if params["time_range"] in time_range_dict:
        body["tbs"] = time_range_dict[params["time_range"]]

    params["url"] = f"{base_url}/v2/search"
    params["method"] = "POST"
    if api_key:
        params["headers"]["Authorization"] = f"Bearer {api_key}"
    params["json"] = body


_RELATIVE_AGO = re.compile(r"(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago")


def _published_date(value: str | None):
    if not value:
        return None
    try:
        return parser.parse(value)
    except (parser.ParserError, TypeError, OverflowError):
        pass
    # the news lane dates its hits relatively ("21 hours ago") -- resolve
    # them against the current clock
    match = _RELATIVE_AGO.fullmatch(value.strip())
    if not match:
        return None
    amount, unit = int(match.group(1)), match.group(2)
    seconds = {"second": 1, "minute": 60, "hour": 3600, "day": 86400,
               "week": 604800, "month": 2592000, "year": 31536000}[unit]
    return datetime.now(timezone.utc) - timedelta(seconds=amount * seconds)


def _add_web_rows(res: EngineResults, rows: list):
    for item in rows:
        url = item.get("url")
        if not url:
            continue
        res.add(
            res.types.MainResult(
                url=url,
                title=item.get("title") or url,
                content=item.get("description") or "",
                publishedDate=_published_date(item.get("date")),
            )
        )


def _add_news_rows(res: EngineResults, rows: list):
    for item in rows:
        url = item.get("url")
        if not url:
            continue
        res.add(
            res.types.MainResult(
                url=url,
                title=item.get("title") or url,
                content=item.get("snippet") or "",
                publishedDate=_published_date(item.get("date")),
            )
        )


def _add_image_rows(res: EngineResults, rows: list):
    for item in rows:
        img_src = item.get("imageUrl")
        if not img_src:
            continue
        width, height = item.get("imageWidth") or 0, item.get("imageHeight") or 0
        res.add(
            res.types.Image(
                url=item.get("url") or img_src,
                title=item.get("title") or "",
                img_src=img_src,
                thumbnail_src=img_src,
                resolution=f"{width} x {height}" if width and height else "",
            )
        )


_LANE_EXTRACTORS = {
    "web": _add_web_rows,
    "news": _add_news_rows,
    "images": _add_image_rows,
}


def response(resp: "SXNG_Response") -> EngineResults:
    res = EngineResults()

    json_resp: dict[str, t.Any] = resp.json()
    # the raise-for-status gate upstream already answered the HTTP error
    # ladder (401/403/429 -> the suspension ladder); the success flag only
    # guards a success-shaped status that carries a failure body
    if not json_resp.get("success"):
        message = json_resp.get("error") or json_resp.get("message") or "request failed"
        raise SearxEngineAPIException(f"Firecrawl: {message}")

    _LANE_EXTRACTORS[firecrawl_source](res, json_resp.get("data", {}).get(firecrawl_source) or [])
    return res
