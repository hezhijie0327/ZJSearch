# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""360 Images (image.so.com) -- the image-search vertical of 360 Search.

The dedicated video site ``tv.360kan.com`` died in late 2026 (its DNS was
even pulled); the image vertical lives on and serves a clean JSON lane at
``/j``: rows with title, original/thumb URLs, dimensions, filesize and type.
Pagination is ``sn`` (start offset) + ``pn`` (page size); the HTML result
page embeds the same rows as a ``"list": [...]`` JSON blob.
"""

import json
import typing as t
from urllib.parse import urlencode

from searx.exceptions import SearxEngineAccessDeniedException
from searx.result_types import EngineResults

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams

about = {
    "website": "https://image.so.com/",
    "wikidata_id": None,
    "use_official_api": False,
    "require_api_key": False,
    "results": "JSON",
}

language = "zh"
categories = ["images"]
paging = True
results_per_page = 60
"""The lane answers up to 100 rows per call; 60 mirrors the web UI."""

base_url = "https://image.so.com"


def request(query: str, params: "OnlineParams"):
    args = {
        "q": query,
        "src": "srp",
        "pn": results_per_page,
        "sn": (params["pageno"] - 1) * results_per_page,
    }
    params["url"] = f"{base_url}/j?{urlencode(args)}"
    # the web page loads this lane as a script tag -- no Referer, no data
    # (an anti-bot page answers instead)
    params["headers"]["Referer"] = f"{base_url}/"


def _int(value: t.Any):
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def _loads(text: str):
    """Parse the lane's payload: plain JSON to some clients, JSONP
    (``jQueryNNN_N({...})``) to others -- strip a wrapper when present."""
    text = text.strip()
    if text.startswith("<"):
        # the anti-bot page ("360图片_访问异常出错")
        raise SearxEngineAccessDeniedException("360 images anti-bot page")
    if text[0] not in "{[":
        start, end = text.find("("), text.rfind(")")
        if start != -1 and end > start:
            text = text[start + 1 : end]
    return json.loads(text)


def response(resp: "SXNG_Response") -> EngineResults:
    res = EngineResults()

    data: dict[str, t.Any] = _loads(resp.text)
    for item in data.get("list") or []:
        img = item.get("img") or item.get("link") or ""
        if not img:
            continue
        thumb = item.get("thumb") or item.get("_thumb") or img
        width, height = _int(item.get("width")), _int(item.get("height"))
        res.add(
            res.types.Image(
                url=img,
                title=item.get("title") or "",
                img_src=img,
                thumbnail_src=thumb,
                source=item.get("site") or "",
                resolution=f"{width} x {height}" if width and height else "",
                filesize=item.get("imgsize") or "",
                img_format=item.get("imgtype") or "",
            )
        )

    return res
