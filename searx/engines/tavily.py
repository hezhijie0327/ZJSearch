# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Tavily is a web search API built for LLMs and RAG pipelines.

API keys come from the `Tavily console <https://app.tavily.com>`_; the free
tier carries 1,000 credits per month, every search costs one (two on the
``advanced`` depth).

.. code:: yaml

  - name: tavily
    engine: tavily
    shortcut: tvly
    api_key: "tvly-..."
    disabled: false

The search honours searxng's ``time_range`` option (the API speaks the same
day/week/month/year vocabulary).  A news-focused instance rides the same
module through :py:obj:`tavily_topic`:

.. code:: yaml

  - name: tavily news
    engine: tavily
    shortcut: tvlyn
    tavily_topic: news
    categories: news
    api_key: "tvly-..."
    disabled: false
"""

import typing as t

from dateutil import parser
from searx.exceptions import SearxEngineAPIException
from searx.result_types import EngineResults

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams


TavilyTopic = t.Literal["general", "news", "finance"]
TavilyDepth = t.Literal["basic", "advanced", "fast", "ultra-fast"]

about = {
    "website": "https://www.tavily.com",
    "wikidata_id": None,
    "official_api_documentation": "https://docs.tavily.com/documentation/api-reference/endpoint/search",
    "use_official_api": True,
    "require_api_key": True,
    "results": "JSON",
}

categories = ["general", "web"]
# the API documents no pagination parameter -- one page per query
paging = False

base_url = "https://api.tavily.com"
api_key = ""
tavily_topic: TavilyTopic = "general"
"""Search profile: ``general`` (default), ``news`` (real-time) or
``finance``."""
tavily_depth: TavilyDepth = "basic"
"""Search depth: ``basic``/``fast``/``ultra-fast`` cost 1 credit,
``advanced`` costs 2."""
results_per_page = 10
"""1-20, the API's single-call cap is 20."""

time_range_support = True
time_range_dict = {
    "day": "day",
    "week": "week",
    "month": "month",
    "year": "year",
}


def setup(engine_data: dict[str, t.Any]):
    if not api_key:
        raise ValueError("missing api key (create one at https://app.tavily.com)")
    if tavily_topic not in t.get_args(TavilyTopic):
        raise ValueError(f"tavily_topic '{tavily_topic}' is not supported (one of: general, news, finance)")
    if tavily_depth not in t.get_args(TavilyDepth):
        raise ValueError(f"tavily_depth '{tavily_depth}' is not supported (one of: basic, advanced, fast, ultra-fast)")
    if not 1 <= results_per_page <= 20:
        raise ValueError("results_per_page must be between 1 and 20")


def request(query: str, params: "OnlineParams"):
    body: dict[str, t.Any] = {
        "query": query,
        "topic": tavily_topic,
        "search_depth": tavily_depth,
        "max_results": results_per_page,
        # beta flag -- without it the general topic answers no published_date
        # at all (the news topic enables it implicitly)
        "include_published_date": True,
    }
    if params["time_range"] in time_range_dict:
        body["time_range"] = time_range_dict[params["time_range"]]

    params["url"] = f"{base_url}/search"
    params["method"] = "POST"
    params["headers"]["Authorization"] = f"Bearer {api_key}"
    params["json"] = body


def _published_date(value: str | None):
    # e.g. "Tue, 11 Mar 2025 17:00:00 GMT" (RFC 2822), or None
    if not value:
        return None
    try:
        return parser.parse(value)
    except (parser.ParserError, TypeError, OverflowError):
        return None


def response(resp: "SXNG_Response") -> EngineResults:
    res = EngineResults()

    json_resp: dict[str, t.Any] = resp.json()
    # the raise-for-status gate upstream already answered the HTTP error
    # ladder (401 invalid key / 429 rate limit with Retry-After -> the
    # suspension ladder / 432+433 usage caps); results live on a 200 body
    for item in json_resp.get("results") or []:
        url = item.get("url")
        if not url:
            continue
        res.add(
            res.types.MainResult(
                url=url,
                title=item.get("title") or url,
                content=item.get("content") or "",
                publishedDate=_published_date(item.get("published_date")),
            )
        )

    return res
