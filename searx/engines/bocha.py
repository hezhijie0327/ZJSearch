# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Bocha (bocha.cn) is a Chinese commercial web-search API built for AI
applications -- Bing-compatible results (news, encyclopedia, libraries, ...)
over a CN-friendly index.

The engine REQUIRES a paid API key: create one in the
`open platform <https://open.bocha.cn>`_'s API KEY management; every call
is billed.

.. code:: yaml

  - name: bocha
    engine: bocha
    shortcut: bocha
    api_key: "sk-..."
    disabled: false

The search honours searxng's ``time_range`` option through the API's
``freshness`` parameter (day/week/month/year).

The one ``web-search`` endpoint answers TWO result lanes (the API's video
lane is declared but always empty so far) -- each served by its own engine
entry through :py:obj:`bocha_categ`, like the upstream qwant module's
``qwant_categ``:

.. code:: yaml

  - name: bocha images
    engine: bocha
    shortcut: bochai
    bocha_categ: images
    api_key: "sk-..."
    disabled: false
"""

import typing as t

from dateutil import parser
from searx.exceptions import SearxEngineAPIException
from searx.result_types import EngineResults

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams


BochaCateg = t.Literal["web", "images"]

about = {
    "website": "https://bocha.cn",
    "wikidata_id": None,
    "official_api_documentation": "https://open.bochaai.com",
    "use_official_api": True,
    "require_api_key": True,
    "results": "JSON",
}

categories = ["general", "web"]
# the API's intro mentions pagination, but the documented request-body
# parameters have no page field and a posted "page" is verifiably IGNORED
# (page 1 and page 2 answer identical rows) -- single page per query.
paging = False

base_url = "https://api.bocha.cn"
api_key = ""
bocha_categ: BochaCateg = "web"
"""Which result lane this instance serves: the ``webPages`` rows (default)
or the ``images`` riding the same web-search response."""
bocha_summary = True
"""Request the API's full-text ``summary`` field; rows fall back to the
short ``snippet`` when it is absent."""
results_per_page = 50
"""1-50, the API's single-call cap is 50.  The lane cannot paginate (the
API ignores its page parameter), so the default pulls the cap -- dial back
here or per instance when the row flood is unwanted."""

time_range_support = True
time_range_dict = {
    "day": "oneDay",
    "week": "oneWeek",
    "month": "oneMonth",
    "year": "oneYear",
}


def setup(engine_data: dict[str, t.Any]):
    if not api_key:
        raise ValueError("missing api key (billed API -- create one at https://open.bocha.cn)")
    if not 1 <= results_per_page <= 50:
        raise ValueError("results_per_page must be between 1 and 50")
    if bocha_categ not in t.get_args(BochaCateg):
        raise ValueError(f"bocha_categ '{bocha_categ}' is not supported (one of: web, images)")


def request(query: str, params: "OnlineParams"):
    body: dict[str, t.Any] = {
        "query": query,
        "summary": bocha_summary,
        "count": results_per_page,
    }
    if params["time_range"] in time_range_dict:
        body["freshness"] = time_range_dict[params["time_range"]]

    params["url"] = f"{base_url}/v1/web-search"
    params["method"] = "POST"
    params["headers"]["Authorization"] = f"Bearer {api_key}"
    params["json"] = body


def _published_date(item: dict[str, t.Any]):
    value = item.get("datePublished")
    if not value:
        value = item.get("dateLastCrawled")
        if value and value.endswith("Z"):
            # documented bocha quirk: the trailing Z on dateLastCrawled
            # actually carries UTC+8 wall time (their v2 will fix the
            # offset) -- rewriting keeps the parsed instant honest
            value = value[:-1] + "+08:00"
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


def _add_web_rows(res: EngineResults, data: dict[str, t.Any]):
    for item in ((data.get("webPages") or {}).get("value")) or []:
        url = item.get("url")
        if not url:
            continue
        res.add(
            res.types.MainResult(
                url=url,
                title=item.get("name") or url,
                content=_trim(item.get("summary") or item.get("snippet") or ""),
                publishedDate=_published_date(item),
            )
        )


def _add_image_rows(res: EngineResults, data: dict[str, t.Any]):
    for item in ((data.get("images") or {}).get("value")) or []:
        img_src = item.get("contentUrl")
        if not img_src:
            continue
        width, height = item.get("width") or 0, item.get("height") or 0
        res.add(
            res.types.Image(
                url=item.get("hostPageUrl") or img_src,
                title=item.get("name") or "",
                img_src=img_src,
                thumbnail_src=item.get("thumbnailUrl") or img_src,
                resolution=f"{width} x {height}" if width and height else "",
            )
        )


def response(resp: "SXNG_Response") -> EngineResults:
    res = EngineResults()

    json_resp: dict[str, t.Any] = resp.json()
    # the raise-for-status gate upstream already answered the HTTP error
    # ladder (401 invalid key / 403 balance spent / 429 rate limit -> the
    # suspension ladder); this envelope check only guards a success-shaped
    # body that carries a non-200 code
    if json_resp.get("code") not in (200, "200", None):
        raise SearxEngineAPIException(
            f"Bocha: HTTP {resp.status_code} {json_resp.get('code')} {json_resp.get('msg') or ''}".rstrip()
        )

    data = json_resp.get("data") or {}
    if bocha_categ == "images":
        _add_image_rows(res, data)
    else:
        _add_web_rows(res, data)

    return res
