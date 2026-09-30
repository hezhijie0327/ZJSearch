# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The page-reader capability (render in a real browser + extract).

``web_reader`` turns one URL into reading material for the research model:
the page renders in the self-hosted Browserless browser (v2 ``POST
/content`` -- a real Chrome, so JS/SPA pages come out complete) and the
HTML condenses to real Markdown with a small lxml pipeline (title,
main-content heuristic, noise/permalink-anchor stripping) plus the
``html-to-markdown`` converter -- ATX headings, GFM tables, code-block
languages and inline semantics -- and a capped links appendix the model
can follow with further ``web_reader`` calls.  The dependency is
deliberately gentle (MIT, zero runtime dependencies, a compiled core);
without it the hand-rolled walker below still produces markdown-ish text
(a logged, degraded fallback).  The HTTP call rides the instance's
default network (``outgoing.proxies`` apply like for every engine).

Configuration: the ``zjsearch.reader`` block, a sibling of
``zjsearch.ai`` -- ``base_url`` (the v2 root, e.g.
``https://browser.example.com``) and ``api_key`` (falls back to the
``ZJSEARCH_READER_KEY`` environment, like ``ZJSEARCH_AI_KEY``); the
``params`` block passes through 1:1 into the render request body
(the provider's own parameters -- ``blockAds``, ``launch``, ...;
dev carries ``blockAds: true`` + ``launch: {stealth: true}``: ad-block
keeps promo noise out of the extraction, the stealth launch lowers
bot-walls); ``max_chars`` caps a page's text -- UNSET = no cap (the
whole readable text goes to the model; contexts are long now), a set
value truncates at a line boundary with an honest marker; ``enabled``
(default ON) switches the whole capability off.  Unconfigured or
disabled means the ``web_reader`` tool
never registers (no error, the model simply does not see it).  A small
TTL cache keeps a re-read page (the model coming back to a source) from
rendering twice.

Modules: :py:mod:`searx.zjsearch.ai.capabilities.reader.config` -- the
settings block and budgets (re-exported here: the package's only source
of truth for its knobs); :py:mod:`searx.zjsearch.ai.capabilities.reader.fetch`
-- the SSRF guard and the Browserless HTTP call;
:py:mod:`searx.zjsearch.ai.capabilities.reader.extract` -- the lxml
extraction and Markdown conversion pipeline.
"""

import collections
import logging
import time

from searx.zjsearch.ai.capabilities.reader.config import (
    PageReadError,
    api_key,
    base_url,
    cfg,
    configured,
    enabled,
    max_chars,
    normalize_url,
    params,
)
from searx.zjsearch.ai.capabilities.reader.extract import extract_page
from searx.zjsearch.ai.capabilities.reader.fetch import guard_url, rendered_html

logger = logging.getLogger(__name__)

__all__ = [
    "PageReadError",
    "api_key",
    "base_url",
    "cfg",
    "configured",
    "enabled",
    "max_chars",
    "normalize_url",
    "params",
    "read_page",
]

CACHE_TTL = 600.0
CACHE_MAX = 128
"""Same-page re-reads (a model returning to a source) reuse one render
for ten minutes; the FIFO cap keeps a long-lived worker's memory flat."""

_cache: "collections.OrderedDict[str, tuple[float, str, str]]" = collections.OrderedDict()


def _cache_get(key: str) -> tuple[str, str] | None:
    # the get -> pop/move_to_end sequence races with a concurrent reader
    # expiring the same entry (Browserless reads run on worker threads):
    # every mutation tolerates the entry vanishing under it -- a cache
    # miss is the worst outcome, never a KeyError tool error
    item = _cache.get(key)
    if item is None:
        return None
    stamp, title, text = item
    if time.monotonic() - stamp > CACHE_TTL:
        _cache.pop(key, None)
        return None
    try:
        _cache.move_to_end(key)
    except KeyError:
        return None
    return (title, text)


def _cache_put(key: str, title: str, text: str) -> None:
    _cache[key] = (time.monotonic(), title, text)
    _cache.move_to_end(key)
    while len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)


def read_page(url: str) -> tuple[str, str]:
    """(title, markdown text) of one URL -- the ``web_reader`` tool's
    whole world.  Raises :py:class:`PageReadError` with a message meant
    for the model (the tool result)."""
    if not configured():
        raise PageReadError("the page reader is not configured on this instance")
    guarded = guard_url(url)
    key = normalize_url(guarded)
    cached = _cache_get(key)
    if cached is not None:
        return cached
    html_text = rendered_html(guarded)
    if not html_text.strip():
        raise PageReadError("the browser rendered an empty page")
    title, text = extract_page(html_text, guarded, max_chars())
    _cache_put(key, title, text)
    return title, text
