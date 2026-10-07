# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``web_reader`` tool -- one module, the whole tool.

The model-facing spec and call parsing, the settings knobs, the SSRF
guard, the render call and the TTL-cached read service.  The render
itself is the built-in browser (:py:mod:`searx.zjsearch.ai.browser`,
``zjsearch.browser``); the extraction pipeline is :py:mod:`.extract`,
the package's bottom module (the shared error type lives there).  The
tool registers only when configured, so a model that never sees it is
never told about it (the ``web_search`` spec cross-references it
conditionally).
"""

import collections
import json
import logging
import time
import typing as t
from urllib.parse import urlsplit

from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.browser import engine as browser_engine
from searx.zjsearch.ai.core import config as core_config
from searx.zjsearch.ai.core.guard import public_url_rejection

from .extract import PageReadError, extract_page

logger = logging.getLogger(__name__)

PAGE_TOOL = "web_reader"

_CACHE_TTL = 600.0
_CACHE_MAX = 128
"""Same-page re-reads (a model returning to a source) reuse one render
for ten minutes; the FIFO cap keeps a long-lived worker's memory flat."""

_cache: "collections.OrderedDict[str, tuple[float, str, str]]" = collections.OrderedDict()


def page_spec() -> dict[str, t.Any]:
    """The ``web_reader`` tool: one URL's current full content, rendered
    in the built-in browser and returned as compact markdown.  The
    description carries the economy policy: reads are for snippets that
    promise exactly the missing detail, never a substitute for a search
    round."""
    return {
        "name": PAGE_TOOL,
        "description": (
            "Open ONE URL and read its current full page content, rendered in"
            " a real browser and returned as compact markdown.  Reach for it"
            " when a source's snippet promises exactly the detail you still"
            " need (specs, prices, tables, documentation, exact numbers) or"
            " when a load-bearing claim must be checked against its source --"
            " never as a substitute for searching.  This is a SINGLE-page"
            " reader, not a recursive crawl: one page per call, and to follow"
            " a link you open it in another explicit call.  Very long pages"
            " arrive truncated.  Failed or empty pages are dead ends: move on"
            " to a different source instead of retrying."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The absolute http(s) URL of the page to read."},
            },
            "required": ["url"],
        },
    }


def parse_page_call(call: dict[str, t.Any]) -> str:
    """The url of one ``web_reader`` tool call -- sanitized: trimmed and
    capped; the public-url guard runs in :func:`guard_url`."""
    try:
        args = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    return str(args.get("url") or "").strip()[:2000]


def enabled() -> bool:
    """The reader feature flag: ``zjsearch.reader.enabled`` -- ``True``
    unless explicitly switched off (``false`` = the ``web_reader`` tool
    never registers, exactly like a missing engine)."""
    return core_config.zj_block("reader").get("enabled") is not False


def configured() -> bool:
    """True when the tool may register: ``enabled`` and the render
    engine present (``zjsearch.browser.enabled``).  An engine that is
    enabled but not installed warns once and answers False -- the tool
    never registers instead of erroring per read."""
    return enabled() and browser_config.ready()


def normalize_url(url: str) -> str:
    """The dedup / cache key of a page: whitespace-stripped, fragment-free."""
    return str(url or "").strip().split("#", 1)[0]


def max_chars() -> int | None:
    """``zjsearch.reader.max_chars`` -- UNSET means NO cap (the whole
    readable text goes to the model; contexts are long now); a set value
    truncates, clamped to sane bounds."""
    value = core_config.zj_block("reader").get("max_chars")
    if value is None:
        return None
    try:
        limit = int(value)
    except (TypeError, ValueError):
        return None
    return max(2000, min(limit, 100_000))


def guard_url(url: str) -> str:
    """Public http(s) URLs only: the model is untrusted input, and the
    render happens inside this host's network -- the shared public-address
    gate (:py:mod:`searx.zjsearch.ai.core.guard`), its reason surfaced as
    a :class:`PageReadError` the model moves on from.  Hosts on the
    engine's ``zjsearch.browser.allow_hosts`` list (the deployment's
    intranet, the audit's loopback fixtures) pass by name -- the same
    list the request gate honors."""
    candidate = str(url or "").strip()
    if not candidate or len(candidate) > 2000:
        raise PageReadError("not a usable url")
    host = (urlsplit(candidate).hostname or "").lower().rstrip(".")
    if host not in browser_config.allow_hosts():
        reason = public_url_rejection(candidate)
        if reason is not None:
            raise PageReadError(reason)
    return candidate


def rendered_html(url: str) -> str:
    """The rendered HTML of one URL through the built-in browser -- the
    one render backend (the engine raises the model-facing failures)."""
    try:
        return browser_engine.read_html(url)
    except browser_config.RenderError as exc:
        raise PageReadError(str(exc)) from exc


def _cache_get(key: str) -> tuple[str, str] | None:
    # the get -> pop/move_to_end sequence races with a concurrent reader
    # expiring the same entry (reads run on worker threads): every
    # mutation tolerates the entry vanishing under it -- a cache miss is
    # the worst outcome, never a KeyError tool error
    item = _cache.get(key)
    if item is None:
        return None
    stamp, title, text = item
    if time.monotonic() - stamp > _CACHE_TTL:
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
    while len(_cache) > _CACHE_MAX:
        _cache.popitem(last=False)


def read_page(url: str) -> tuple[str, str]:
    """(title, markdown text) of one URL -- the ``web_reader`` tool's
    whole world.  Raises :class:`PageReadError` with a message meant
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
