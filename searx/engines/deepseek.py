# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""DeepSeek Search API -- a Chinese commercial web-search API built for AI
applications (`API docs`_): reranked rows scored on relevance/authority/
freshness over DeepSeek's index, with ``site:``/``lang:``/``after:`` search
syntax honored inside the query.

.. _API docs: https://api-docs.deepseek.com/zh-cn/guides/search/

The engine REQUIRES a paid API key (DeepSeek platform key); every successful
call is billed (5 CNY per 1,000 successful searches -- failures and
empty result sets are NOT billed).

.. code:: yaml

  - name: deepseek
    engine: deepseek
    shortcut: ds
    api_key: "sk-..."
    disabled: false

The API has no pagination -- one call answers up to :py:obj:`results_per_page`
rows (the API's cap is 50).  ``time_range`` is expressed through the query
syntax's ``after:`` operator (UTC dates).
"""

import typing as t
from datetime import datetime, timedelta

from dateutil import parser
from searx.exceptions import SearxEngineAPIException
from searx.result_types import EngineResults

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams

about = {
    "website": "https://api-docs.deepseek.com",
    "wikidata_id": None,
    "official_api_documentation": "https://api-docs.deepseek.com/zh-cn/guides/search/",
    "use_official_api": True,
    "require_api_key": True,
    "results": "JSON",
}

categories = ["general"]
# the API has no pagination -- one call, up to `count` rows (cap 50)
paging = False

base_url = "https://api.deepseek.com"
api_key = ""
results_per_page = 10
"""1-50 (the API's cap); billed per call, not per row, so pull more per
call when the row flood is wanted."""

time_range_support = True
time_range_dict = {"day": 1, "week": 7, "month": 30, "year": 365}
"""``time_range`` rides the query syntax's ``after:`` operator (UTC date)."""


def setup(engine_data: dict[str, t.Any]):
    if not api_key:
        raise ValueError(
            "missing api key (billed API -- create one on the DeepSeek platform)"
        )
    if not 1 <= results_per_page <= 50:
        raise ValueError("results_per_page must be between 1 and 50")


def request(query: str, params: "OnlineParams"):
    body: dict[str, t.Any] = {
        "query": query,
        "count": results_per_page,
        # billed the same per call, and the row content feeds the ranker /
        # AI reader where the full text beats a snippet
        "need_content": True,
    }
    days = time_range_dict.get(params["time_range"])
    if days:
        after = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d")
        body["query"] = f"{query} after:{after}"

    params["url"] = f"{base_url}/v1/tools/search"
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


def _trim(text: str, limit: int = 400) -> str:
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[:limit].rstrip() + " …"
    return text


def response(resp: "SXNG_Response") -> EngineResults:
    res = EngineResults()

    json_resp: dict[str, t.Any] = resp.json()
    # the raise-for-status gate upstream already answered the HTTP error
    # ladder (401 invalid key / 402 balance spent / 429 rate limit -> the
    # suspension ladder); this guard only answers an error envelope riding
    # a 200-shaped body
    if isinstance(json_resp.get("error"), dict):
        err = json_resp["error"]
        raise SearxEngineAPIException(
            f"DeepSeek: {err.get('type') or 'error'} {err.get('message') or ''}".rstrip()
        )

    for item in json_resp.get("results") or []:
        url = item.get("url")
        if not url:
            continue
        res.add(
            res.types.MainResult(
                url=url,
                title=item.get("title") or url,
                # the fetched page content first (need_content), falling
                # back to the card-oriented snippet / model summary
                content=_trim(item.get("content") or item.get("snippet") or item.get("summary") or ""),
                publishedDate=_published_date(item.get("date")),
            )
        )

    return res
