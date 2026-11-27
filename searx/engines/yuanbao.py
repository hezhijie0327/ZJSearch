# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Tencent Yuanbao (so.qq.com) is Tencent's general-purpose
web search -- the PC web front of the Yuanbao search stack, strong on
Chinese content (official science channels, WeChat official-account
articles, WeChat Channels videos, Tencent ecosystem pages).

.. code:: yaml

  - name: yuanbao
    engine: yuanbao
    shortcut: yuanbao
    disabled: false

The private ``next-page`` JSON API is reverse-engineered from the site:
a POST body of ``{"query", "page", "variant": "pc"}`` answers a card list
where only a few ``cardName`` families are real results (the rest are
dictionary/word-card/hint widgets that are skipped).  Titles and snippets
carry private-use highlight wrappers (U+E40A .. U+E40B, or ``<em>`` tags
on the video lane) that are stripped server-side.

The site's vertical tabs ride the same endpoint through ``sp.tab`` and are
served per engine entry via :py:obj:`yuanbao_categ`, like the upstream
qwant module's ``qwant_categ``:

.. code:: yaml

  - name: yuanbao gzh
    engine: yuanbao
    shortcut: ybgzh
    yuanbao_categ: weixin_article
    disabled: false

  - name: yuanbao videos
    engine: yuanbao
    shortcut: ybvideo
    yuanbao_categ: weixin_video
    disabled: false

``weixin_article`` serves WeChat official-account articles (the site UI
gates the tab behind a login, but the API answers anonymously and the
``jumpUrl`` links are stable, signature-free ``mp.weixin.qq.com`` URLs).
Its ``page`` parameter is verifiably IGNORED (page 2 repeats page 1's
docIds, ``hasMore`` stays false) -- set ``paging: false`` on that engine
entry so only the first page is ever requested.  ``weixin_video`` serves
WeChat Channels videos; their ``h5Url`` previews and covers are
time-limited tokens.

``images`` serves the site's image vertical (``/ipics``).  Its own
``napi/pc/searchList`` pagination API sits behind an antispider approval
handshake, so the lane parses the server-rendered page instead: the
first batch (48 images) is embedded in ``window.__INITIAL_STATE__`` and
fetchable without cookies -- set ``paging: false`` on that engine entry,
and note that ``time_range`` does NOT apply to it (the SSR payload
ignores the site's ``timeFilter``).

Time range (:py:obj:`time_range_support`) maps to ``sp.timeFilter``
(verified live: ``1d``/``1w``/``1m``/``1y`` answer date windows that
match the site's time-filter options) -- only the ``web`` lane honours it;
the vertical lanes carry no time filter UI.  The site's remaining tabs
(academic, organization sites, mainstream outlets) are either narrow
source-whitelist views of the web lane or need their own card parsers and
are not served.
"""

import json
import typing as t
from datetime import datetime, timezone
from urllib.parse import quote

from dateutil import parser
from searx.exceptions import SearxEngineAPIException
from searx.result_types import EngineResults
from searx.utils import html_to_text

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams

YuanbaoCateg = t.Literal["web", "weixin_article", "weixin_video", "images"]

about = {
    "website": "https://so.qq.com",
    "wikidata_id": None,
    "use_official_api": False,
    "require_api_key": False,
    "results": "JSON",
}

categories = ["general", "web"]
paging = True
results_per_page = 10
time_range_support = True
time_range_dict = {
    "day": "1d",
    "week": "1w",
    "month": "1m",
    "year": "1y",
}

base_url = "https://so.qq.com"
yuanbao_categ: YuanbaoCateg = "web"
"""Which result lane this instance serves: the ordinary web rows (default),
the WeChat official-account articles (``weixin_article``), the WeChat
Channels videos (``weixin_video``) or the image vertical (``images``)."""

# ordinary web-result card families; everything else in the card list is a
# widget (dictionary card, word list, hints, AI overview, ...)
_WEB_CARDS = frozenset(
    (
        "card-pc/card_normal_result",
        "card-pc/card30010588",
        "card-pc/card30010585",
    )
)

# per-lane result card families
_LANE_CARDS = {
    "web": _WEB_CARDS,
    "weixin_article": frozenset(("card-common/card30010612",)),
    "weixin_video": frozenset(("card-common/card_tab_weixin_video",)),
}

# search-term highlight wrappers the site mangles into titles/snippets
_HIGHLIGHT_MARKS = str.maketrans("", "", "\ue40a\ue40b")

_STATE_MARKER = "window.__INITIAL_STATE__="


def setup(engine_data: dict[str, t.Any]):
    if yuanbao_categ not in t.get_args(YuanbaoCateg):
        raise ValueError(f"yuanbao_categ '{yuanbao_categ}' is not supported (one of: web, weixin_article, weixin_video, images)")


def _clean(text: str) -> str:
    return text.translate(_HIGHLIGHT_MARKS).strip()


def _published_date(value: str):
    if not value:
        return None
    try:
        return parser.parse(value)
    except (parser.ParserError, TypeError, OverflowError):
        # relative labels (e.g. "today") are not dates -- fail open without one
        return None


def _published_timestamp(value: str):
    if not value:
        return None
    try:
        return datetime.fromtimestamp(int(value), timezone.utc)
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def request(query: str, params: "OnlineParams"):
    if yuanbao_categ == "images":
        # the SSR page answers anonymously; its pagination API would need
        # the site's antispider approval handshake -- single batch only
        params["url"] = f"{base_url}/ipics?query={quote(query)}"
        return

    body: dict[str, t.Any] = {"query": query, "page": params["pageno"], "variant": "pc"}
    sp: dict[str, str] = {}
    if yuanbao_categ != "web":
        sp["tab"] = yuanbao_categ
    elif params["time_range"] in time_range_dict:
        sp["timeFilter"] = time_range_dict[params["time_range"]]
    if sp:
        body["sp"] = sp

    params["url"] = f"{base_url}/searchweb/api/search/next-page"
    params["method"] = "POST"
    params["json"] = body


def _add_web_rows(res: EngineResults, vm: dict[str, t.Any]):
    url = vm.get("url")
    if not url:
        return
    res.add(
        res.types.MainResult(
            url=url,
            title=_clean(vm.get("title") or "") or url,
            content=_clean(vm.get("content") or ""),
            publishedDate=_published_date(vm.get("date") or ""),
            thumbnail=vm.get("imageUrl") or "",
        )
    )


def _add_article_rows(res: EngineResults, vm: dict[str, t.Any]):
    url = vm.get("jumpUrl")
    if not url:
        return
    res.add(
        res.types.MainResult(
            url=url,
            title=_clean(vm.get("title") or "") or url,
            content=_clean(vm.get("summary") or ""),
            publishedDate=_published_date(vm.get("publishTime") or ""),
            thumbnail=vm.get("imgUrl") or "",
        )
    )


def _add_video_rows(res: EngineResults, vm: dict[str, t.Any]):
    url = vm.get("h5Url")
    if not url:
        return
    author = vm.get("authorName") or ""
    duration = vm.get("duration") or ""
    content = " · ".join(part for part in (author, duration) if part)
    res.add(
        res.types.Video(
            url=url,
            title=html_to_text(vm.get("title") or "") or url,
            content=content,
            publishedDate=_published_date(vm.get("publishTime") or ""),
            thumbnail=vm.get("cover") or "",
        )
    )


_LANE_ROWS = {
    "web": _add_web_rows,
    "weixin_article": _add_article_rows,
    "weixin_video": _add_video_rows,
}


def _response_images(resp: "SXNG_Response") -> EngineResults:
    text = resp.text
    start = text.find(_STATE_MARKER)
    if start < 0:
        raise SearxEngineAPIException("Invalid response")
    start += len(_STATE_MARKER)
    end = text.find("</script>", start)
    if end < 0:
        raise SearxEngineAPIException("Invalid response")
    raw = text[start:end]
    try:
        data = json_loads(raw)
    except ValueError as e:
        raise SearxEngineAPIException(f"Invalid response: {e}") from e

    items = (data.get("searchList") or {}).get("searchList") or []
    res = EngineResults()
    for item in items:
        img_src = item.get("oriPicUrl") or item.get("thumbUrl")
        if not img_src:
            continue
        res.add(
            res.types.Image(
                url=item.get("url") or img_src,
                title=_clean(item.get("title") or ""),
                img_src=img_src,
                thumbnail_src=item.get("thumbUrl") or "",
                publishedDate=_published_timestamp(item.get("publish_time")),
            )
        )
    return res


def json_loads(raw: str):
    # the SSR payload serializes Python literals verbatim -- bare
    # `undefined` (and the occasional NaN) are not valid JSON
    try:
        return json.loads(raw)
    except ValueError:
        return json.loads(raw.replace("undefined", "null").replace("NaN", "null"))


def response(resp: "SXNG_Response") -> EngineResults:
    if yuanbao_categ == "images":
        return _response_images(resp)

    try:
        data = resp.json()
    except Exception as e:
        raise SearxEngineAPIException(f"Invalid response: {e}") from e

    if not data.get("ok"):
        raise SearxEngineAPIException("Invalid response")

    lane_cards = _LANE_CARDS[yuanbao_categ]
    add_rows = _LANE_ROWS[yuanbao_categ]
    res = EngineResults()
    for card in data.get("cards") or []:
        card_data = card.get("data") or {}
        if card_data.get("cardName") not in lane_cards:
            continue
        add_rows(res, card_data.get("vm") or {})
    return res
