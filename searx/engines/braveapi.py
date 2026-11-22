# SPDX-License-Identifier: AGPL-3.0-or-later
"""Engine to search using the Brave (WEB) Search API.

.. _Brave Search API: https://api-dashboard.search.brave.com/documentation

Configuration
=============

The engine has the following mandatory setting:

- :py:obj:`api_key`

Optional settings are:

- :py:obj:`results_per_page`
- :py:obj:`brave_api_category`

.. code:: yaml

  - name: braveapi
    engine: braveapi
    api_key: 'YOUR-API-KEY'  # required
    results_per_page: 20     # optional
    brave_api_category: news # optional: general (default), images, videos, news

The API supports paging, safesearch and time filters.  The time filter
uses the ``freshness`` query parameter with the values ``pd``, ``pw``,
``pm``, ``py`` (verified against the live API; a query parameter named
``time_range`` is rejected by the API).
"""

import typing as t

from urllib.parse import urlencode

from searx.engines.brave import parse_search_result
from searx.exceptions import SearxEngineAPIException
from searx.result_types import EngineResults, LegacyResult
from searx.utils import html_to_text

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams

about = {
    "website": "https://api.search.brave.com/",
    "wikidata_id": None,
    "official_api_documentation": "https://api-dashboard.search.brave.com/api-reference/web/search/get",
    "use_official_api": True,
    "require_api_key": True,
    "results": "JSON",
}

api_key: str = ""
"""API key for Brave Search API (required)."""

categories = ["general", "web"]
paging = True
safesearch = True
safesearch_map = {2: "strict", 1: "moderate", 0: "off"}
time_range_support = True

results_per_page: int = 20
"""Maximum number of results per page (default 20)."""

api_base_url: str = "https://api.search.brave.com/res/v1"
"""Root of the Brave Search API; vertical endpoints sit next to the web one."""

base_url: str = api_base_url + "/web/search"
"""Web-search endpoint of the Brave Search API."""

brave_api_category: str = "general"
"""Vertical this instance serves: general (web), images, videos or news."""

brave_api_category_map: dict[str, str] = {
    "general": "web",
    "images": "images",
    "videos": "videos",
    "news": "news",
}
"""Maps :py:obj:`brave_api_category` to the API endpoint name."""

time_range_map: dict[str, str] = {
    "day": "pd",
    "week": "pw",
    "month": "pm",
    "year": "py",
}
"""SearXNG time ranges to Brave API ``freshness`` values."""

max_page = 10


def setup(_: dict[str, t.Any]) -> bool | None:
    """Initialize the engine."""
    if not api_key:
        raise SearxEngineAPIException("No API key provided")
    if brave_api_category not in brave_api_category_map:
        raise SearxEngineAPIException(f"Unsupported category: {brave_api_category}")


def request(query: str, params: "OnlineParams") -> None:
    """Create the API request."""
    endpoint = brave_api_category_map[brave_api_category]
    url = base_url if endpoint == "web" else f"{api_base_url}/{endpoint}/search"

    search_args: dict[str, str | int | None] = {
        "q": query,
        "count": results_per_page,
        "offset": params["pageno"] - 1,
        "text_decorations": False,
    }

    # Apply time filter if specified
    if params["time_range"]:
        search_args["freshness"] = time_range_map.get(params["time_range"])

    # Apply SafeSearch
    search_args["safesearch"] = safesearch_map.get(params["safesearch"], "off")

    params["url"] = f"{url}?{urlencode(search_args)}"
    params["headers"]["X-Subscription-Token"] = api_key
    params["headers"]["Accept"] = "application/json"
    params["headers"]["Cache-Control"] = "no-cache"


def _images_result(item: dict[str, t.Any]) -> LegacyResult:
    return LegacyResult(
        {
            "template": "images.html",
            "url": item.get("url"),
            "thumbnail_src": (item.get("thumbnail") or {}).get("src", ""),
            "img_src": (item.get("properties") or {}).get("url"),
            "title": item.get("title"),
            "source": (item.get("meta_url") or {}).get("netloc"),
        }
    )


def _videos_result(item: dict[str, t.Any]) -> LegacyResult:
    return LegacyResult(
        {
            "url": item.get("url"),
            "title": item.get("title"),
            "content": html_to_text(item.get("description")),
            "length": (item.get("video") or {}).get("duration"),
            "thumbnail_src": (item.get("thumbnail") or {}).get("src", ""),
        }
    )


def _news_result(item: dict[str, t.Any]) -> LegacyResult:
    return LegacyResult(
        {
            "url": item.get("url"),
            "title": item.get("title"),
            "content": html_to_text(item.get("description")),
            "thumbnail_src": (item.get("thumbnail") or {}).get("src", ""),
        }
    )


def response(resp: "SXNG_Response") -> EngineResults:
    """Process the API response and return results."""
    data = resp.json()

    res = EngineResults()
    if brave_api_category == "general":
        results_json = (data.get("web") or {}).get("results", [])
        for result in results_json:
            res.add(parse_search_result(result))
        return res

    parser = {"images": _images_result, "videos": _videos_result}.get(brave_api_category, _news_result)
    for item in data.get("results", []):
        res.add(parser(item))

    return res
