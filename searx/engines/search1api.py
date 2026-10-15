# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""search1api (s1.dev) is a search aggregator: one API key fronts several
underlying engines -- google, bing, bingcn, duckduckgo, baidu, wechat,
bilibili, github, arxiv and more -- plus crawl / news / screenshot lanes
(this module uses the search and news lanes).

API keys come from the `search1api console <https://s1.dev/console>`_.

.. code:: yaml

  - name: search1api
    engine: search1api
    shortcut: s1api
    api_key: "..."
    disabled: false

The underlying engine is selected per instance through
:py:obj:`search1_service`; each one is its own engine entry (a distinct
``name`` / ``shortcut``), so e.g. a WeChat-article search joins the
general category under its own bang:

.. code:: yaml

  - name: search1api wechat
    engine: search1api
    shortcut: s1w
    search1_service: wechat
    api_key: "..."
    disabled: false

The search honours searxng's ``time_range`` option (the API speaks the same
day/week/month/year vocabulary) and pages through the API's ``page``
parameter.

The news lane serves the ``/news`` endpoint (same row shape, a smaller
service set, no pagination) through :py:obj:`search1_categ`:

.. code:: yaml

  - name: search1api news
    engine: search1api
    shortcut: s1n
    search1_categ: news
    categories: news
    paging: false
    api_key: "..."
    disabled: false
"""

import typing as t

from dateutil import parser
from searx.exceptions import SearxEngineAPIException
from searx.result_types import EngineResults

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams


SEARCH_SERVICES = (
    "google",
    "bing",
    "bingcn",
    "duckduckgo",
    "yahoo",
    "yandex",
    "youtube",
    "x",
    "reddit",
    "github",
    "arxiv",
    "wechat",
    "bilibili",
    "imdb",
    "wikipedia",
    "grokipedia",
    "baidu",
    "360",
    "quark",
)

NEWS_SERVICES = ("google", "bing", "duckduckgo", "yahoo", "hackernews", "reuters")

Search1Categ = t.Literal["search", "news"]

about = {
    "website": "https://s1.dev",
    "wikidata_id": None,
    "official_api_documentation": "https://s1.dev/docs/basic/search",
    "use_official_api": True,
    "require_api_key": True,
    "results": "JSON",
}

categories = ["general", "web"]
paging = True

base_url = "https://api.search1api.com"
api_key = ""
search1_categ: Search1Categ = "search"
"""Which endpoint this instance serves: ``search`` (default, paginated) or
``news`` (the /news lane -- same row shape, smaller service set, no
pagination)."""
search1_service = "google"
"""The underlying engine this instance fronts; the allowed set depends on
:py:obj:`search1_categ` (:py:obj:`SEARCH_SERVICES` vs :py:obj:`NEWS_SERVICES`)."""
results_per_page = 10
"""1-50, the API's single-call cap is 50."""

time_range_support = True
time_range_dict = {
    "day": "day",
    "week": "week",
    "month": "month",
    "year": "year",
}


def setup(engine_data: dict[str, t.Any]):
    if not api_key:
        raise ValueError("missing api key (create one at https://s1.dev/console)")
    if search1_categ not in t.get_args(Search1Categ):
        raise ValueError(f"search1_categ '{search1_categ}' is not supported (one of: search, news)")
    allowed = NEWS_SERVICES if search1_categ == "news" else SEARCH_SERVICES
    if search1_service not in allowed:
        raise ValueError(f"search1_service '{search1_service}' is not supported on the {search1_categ} lane (one of: {', '.join(allowed)})")
    if not 1 <= results_per_page <= 50:
        raise ValueError("results_per_page must be between 1 and 50")


def request(query: str, params: "OnlineParams"):
    body: dict[str, t.Any] = {
        "query": query,
        "search_service": search1_service,
        "max_results": results_per_page,
    }
    if search1_categ == "search":
        # only the /search endpoint pages; /news documents no page parameter
        body["page"] = params["pageno"]
    if params["time_range"] in time_range_dict:
        body["time_range"] = time_range_dict[params["time_range"]]

    params["url"] = f"{base_url}/{'news' if search1_categ == 'news' else 'search'}"
    params["method"] = "POST"
    params["headers"]["Authorization"] = f"Bearer {api_key}"
    params["json"] = body


def _published_date(value: str | None):
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
    # ladder (401 auth / 402 quota / 429 -> the suspension ladder)
    for item in json_resp.get("results") or []:
        url = item.get("link")
        if not url:
            continue
        res.add(
            res.types.MainResult(
                url=url,
                title=item.get("title") or url,
                content=item.get("snippet") or "",
                publishedDate=_published_date(item.get("published_date")),
            )
        )

    return res
