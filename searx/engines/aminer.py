# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AMiner Open Platform -- academic data APIs from datacenter.aminer.cn
(papers / scholars / patents / organizations / journals over a 3.0亿+
publication index).

.. _AMiner open platform: https://www.aminer.cn/open

The engine REQUIRES a token minted in the open-platform console; every
lane is on a free trial ("限免") at the time of writing, "论文搜索 pro"
is the paid tier.  Auth errors ride HTTP 500 with a ``code`` envelope,
so the HTTP status gate is off and the envelope is read here.

.. code:: yaml

  - name: aminer
    engine: aminer
    shortcut: aminer
    aminer_categ: paper
    api_key: "eyJ..."   # the console token
    disabled: false

Lanes (:py:obj:`aminer_categ`):

- ``paper`` -- GET /paper/search, paginated (page 1-10), time-agnostic.
- ``person`` -- POST /person/search by name; the API caps ``offset`` at
  20, so paging stops early.
- ``patent`` -- POST /patent/search; the API pages from 0 (max page 4).
- ``organization`` / ``venue`` -- entity lookup by name, single row.

Result links use the public pages (``/pub/<id>`` etc.), which resolve
the bare id fine.
"""

import typing as t
from datetime import datetime
from urllib.parse import urlencode

from searx.exceptions import (
    SearxEngineAPIException,
    SearxEngineTooManyRequestsException,
)
from searx.result_types import EngineResults

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams

about = {
    "website": "https://www.aminer.cn",
    "wikidata_id": None,
    "official_api_documentation": "https://www.aminer.cn/open/docs?id=671a19a46e728a29db292f73",
    "use_official_api": True,
    "require_api_key": True,
    "results": "JSON",
}

language = "zh"
categories = ["science"]
paging = True

api_key = ""
"""The Authorization token from the AMiner open-platform console."""

aminer_categ = "paper"
"""Which lane this instance serves: paper | paper_pro | person | patent
| organization | venue.  ``paper_pro`` is billed per call (0.01 CNY)."""

results_per_page = 20
"""Per-call row cap: 20 on the paper/patent lanes, 10 on person, up to
100 on paper_pro."""

aminer_paper_pro_order = ""
"""``paper_pro`` only: ``year`` or ``n_citation`` for a descending sort
by that field; empty keeps the default relevance order."""

base_url = "https://datacenter.aminer.cn/gateway/open_platform/api"

time_range_support = True
# the paper lanes filter by publication year only -- every searx range
# collapses onto "from this year on" (current year - N years)
time_range_dict = {"day": 0, "week": 0, "month": 1, "year": 5}
"""Range -> ``year_from`` offset from the current year."""

LANES = ("paper", "paper_pro", "person", "patent", "organization", "venue")

ERROR_HINTS = {
    40001: "parameter error",
    40301: "permission denied",
    40302: "token expired -- mint a new one in the console",
    40307: "invalid API key",
    40308: "invalid token -- check the expiry or the value",
}


def setup(engine_data: dict[str, t.Any]) -> bool:
    if not api_key:
        raise ValueError(
            "missing api key -- the Authorization token from the AMiner console"
        )
    if aminer_categ not in LANES:
        raise ValueError(f"aminer_categ '{aminer_categ}' is not supported (one of: {', '.join(LANES)})")
    if aminer_categ == "paper_pro":
        if not 1 <= results_per_page <= 100:
            raise ValueError("results_per_page must be between 1 and 100 on paper_pro")
        if aminer_paper_pro_order not in ("", "year", "n_citation"):
            raise ValueError("aminer_paper_pro_order must be empty, 'year' or 'n_citation'")
    elif not 1 <= results_per_page <= 20:
        raise ValueError("results_per_page must be between 1 and 20")
    return True


def request(query: str, params: "OnlineParams"):
    # auth failures ride HTTP 500 with a JSON envelope -- keep the body
    params["raise_for_httperror"] = False
    params["headers"]["Authorization"] = api_key

    # publication dates are year-grained; every searx range collapses
    # onto "published in the years it spans"
    year_from = ""
    if params.get("time_range") in time_range_dict:
        year_from = datetime.now().year - time_range_dict[params["time_range"]]

    if aminer_categ == "paper":
        args = {
            "query": query,
            "page": min(params["pageno"], 10),
            "size": results_per_page,
        }
        if year_from:
            args["year_from"] = year_from
        params["url"] = f"{base_url}/paper/search?{urlencode(args)}"
        return

    if aminer_categ == "paper_pro":
        args = {
            "query": query,
            "page": params["pageno"] - 1,  # the pro lane pages from 0
            "size": results_per_page,
        }
        if aminer_paper_pro_order:
            args["order"] = aminer_paper_pro_order
        if year_from:
            args["year_from"] = year_from
        params["url"] = f"{base_url}/paper/search/pro?{urlencode(args)}"
        return

    params["method"] = "POST"
    params["headers"]["Content-Type"] = "application/json;charset=utf-8"
    if aminer_categ == "person":
        params["url"] = f"{base_url}/person/search"
        params["json"] = {
            "name": query,
            "size": min(results_per_page, 10),
            "offset": min((params["pageno"] - 1) * 10, 20),
        }
    elif aminer_categ == "patent":
        params["url"] = f"{base_url}/patent/search"
        params["json"] = {
            "query": query,
            "page": min(params["pageno"] - 1, 4),
            "size": results_per_page,
        }
    elif aminer_categ == "organization":
        params["url"] = f"{base_url}/organization/search"
        params["json"] = {"orgs": [query]}
    else:  # venue
        params["url"] = f"{base_url}/venue/search"
        params["json"] = {"name": query}


def _check_envelope(json_resp: dict[str, t.Any]) -> None:
    code = json_resp.get("code")
    if code in (200, "200", None):
        return
    hint = ERROR_HINTS.get(code, json_resp.get("msg") or "error")
    if code == 40306:
        raise SearxEngineTooManyRequestsException()
    raise SearxEngineAPIException(f"AMiner: {code} {hint}".rstrip())


def _year(value: t.Any):
    try:
        return datetime(int(value), 1, 1)
    except (TypeError, ValueError):
        return None


def response(resp: "SXNG_Response") -> EngineResults:
    res = EngineResults()

    json_resp: dict[str, t.Any] = resp.json()
    _check_envelope(json_resp)

    rows = json_resp.get("data") or []
    if aminer_categ in ("paper", "paper_pro"):
        _add_paper_rows(res, rows)
    elif aminer_categ == "person":
        _add_person_rows(res, rows)
    elif aminer_categ == "patent":
        _add_patent_rows(res, rows)
    elif aminer_categ == "organization":
        _add_org_rows(res, rows)
    else:
        _add_venue_rows(res, rows)

    return res


def _add_paper_rows(res: EngineResults, rows: list[dict[str, t.Any]]):
    for item in rows:
        paper_id = item.get("id")
        title = item.get("title") or item.get("title_zh")
        if not paper_id or not title:
            continue
        meta = " · ".join(
            part
            for part in (
                item.get("first_author"),
                item.get("venue_name"),
                str(item.get("year") or ""),
                f"cited {item['n_citation_bucket']}" if item.get("n_citation_bucket") else "",
                item.get("doi"),
            )
            if part
        )
        res.add(
            res.types.MainResult(
                url=f"https://www.aminer.cn/pub/{paper_id}",
                title=title,
                content=meta,
                publishedDate=_year(item.get("year")),
            )
        )


def _add_person_rows(res: EngineResults, rows: list[dict[str, t.Any]]):
    for item in rows:
        person_id = item.get("id")
        if not person_id:
            continue
        name = item.get("name_zh") or item.get("name") or ""
        if item.get("name") and item.get("name_zh"):
            name = f"{item['name_zh']} ({item['name']})"
        interests = ", ".join(item.get("interests") or [])
        content = " · ".join(
            part
            for part in (
                item.get("org_zh") or item.get("org"),
                interests,
                f"cited {int(item['n_citation'])}" if item.get("n_citation") else "",
            )
            if part
        )
        res.add(
            res.types.MainResult(
                url=f"https://www.aminer.cn/profile/{person_id}",
                title=name,
                content=content,
            )
        )


def _add_patent_rows(res: EngineResults, rows: list[dict[str, t.Any]]):
    for item in rows:
        patent_id = item.get("id")
        title = item.get("title_zh") or item.get("title")
        if not patent_id or not title:
            continue
        content = " · ".join(
            part
            for part in (
                f"inventor {item['inventor_name']}" if item.get("inventor_name") else "",
                f"published {item['pub_year']}" if item.get("pub_year") else "",
                f"applied {item['app_year']}" if item.get("app_year") else "",
            )
            if part
        )
        res.add(
            res.types.MainResult(
                url=f"https://www.aminer.cn/patent/{patent_id}",
                title=title,
                content=content,
                publishedDate=_year(item.get("pub_year")),
            )
        )


def _add_org_rows(res: EngineResults, rows: list[dict[str, t.Any]]):
    for item in rows:
        org_id = item.get("org_id")
        org_name = item.get("org_name")
        if not org_id or not org_name:
            continue
        res.add(
            res.types.MainResult(
                url=f"https://www.aminer.cn/org/{org_id}",
                title=org_name,
                content=", ".join(item.get("aliases") or []),
            )
        )


def _add_venue_rows(res: EngineResults, rows: list[dict[str, t.Any]]):
    for item in rows:
        venue_id = item.get("id")
        name = item.get("name_en") or item.get("name_zh")
        if not venue_id or not name:
            continue
        content = " · ".join(
            part
            for part in (
                item.get("venue_type"),
                ", ".join(item.get("aliases") or []),
            )
            if part
        )
        res.add(
            res.types.MainResult(
                url=f"https://www.aminer.cn/venue/{venue_id}",
                title=name,
                content=content,
            )
        )
