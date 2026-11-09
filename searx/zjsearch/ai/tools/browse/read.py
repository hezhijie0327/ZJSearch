# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``browse`` tool's READ LANE -- the parallel
one-shot page reads behind ``read(url)``.

The settings knobs, the SSRF guard, the render call and the TTL-cached
read service.  The render itself is the built-in browser
(:py:mod:`searx.zjsearch.ai.browser`, ``zjsearch.browser``); the
extraction pipeline is the browser package's :py:mod:`.extract` (the
shared error type lives there -- tools importing browser is the legal
edge).  The session lane (ONE interactive page) lives beside this in
:py:mod:`.session`; the executor routes ``read(url)`` here and every
other action there."""

import asyncio
import collections
import functools
import logging
import time
import typing as t
from urllib.parse import urlsplit

from searx import settings
from searx.network.client import get_loop
from searx.network.network import Network
from searx.utils import gen_useragent
from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.browser import engine as browser_engine
from searx.zjsearch.ai.browser.extract import PageReadError, _cap, extract_page
from searx.zjsearch.ai.core import config as core_config
from searx.zjsearch.ai.core import convert as convert_service
from searx.zjsearch.ai.core.guard import public_url_rejection

logger = logging.getLogger(__name__)

_CACHE_TTL = 600.0
_CACHE_MAX = 128
"""Same-page re-reads (a model returning to a source) reuse one render
for ten minutes; the FIFO cap keeps a long-lived worker's memory flat."""

_cache: "collections.OrderedDict[str, tuple[float, str, str]]" = collections.OrderedDict()


def enabled() -> bool:
    """The read lane's feature flag: ``zjsearch.reader.enabled`` --
    ``True`` unless explicitly switched off."""
    return core_config.zj_block("reader").get("enabled") is not False


def configured() -> bool:
    """True when ``read(url)`` may run: ``enabled``, the convert service
    present (markitdown -- the ONE markdown engine since the unified
    converter) and the render engine present (``zjsearch.browser.enabled``).
    A missing piece warns once and answers False -- the reads fail with
    one clear log line instead of erroring per read."""
    if not enabled():
        return False
    missing = convert_service.missing()
    if missing is not None:
        _warn_once(f"zjsearch.reader: the {missing} package is missing -- browse reads stay unavailable")
        return False
    return browser_config.ready()


_WARNED: set[str] = set()


def _warn_once(message: str) -> None:
    """One log line per distinct message, process-wide."""
    if message not in _WARNED:
        _WARNED.add(message)
        logger.warning("%s", message)


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
    # the SCHEME check runs first (the session lane's lesson): a
    # file://localhost/... url would otherwise ride the allow_hosts
    # exemption past the public-url gate, and the request-level gate
    # never sees a file navigation at all
    if not candidate.lower().startswith(("http://", "https://")):
        raise PageReadError("read public http(s) pages only")
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


@functools.lru_cache(maxsize=1)
def _document_network() -> Network:
    """Dedicated curl network for the direct document fetches (the
    attachments image network's shape): the default network is
    https-only -- this one keeps the ``outgoing`` proxies / verify for
    remote endpoints."""
    out = settings.get("outgoing", {})
    return Network(
        enable_http=True,
        verify=out.get("verify", True),
        enable_http2=out.get("enable_http2", True),
        max_connections=out.get("pool_connections", 10),
        proxies=out.get("proxies"),
        using_tor_proxy=bool(out.get("using_tor_proxy", False)),
        max_redirects=out.get("max_redirects", 30),
        retries=0,
        logger_name="zjsearch_ai",
    )


_DOC_FETCH_TIMEOUT = 30.0
_DOC_MAX_BYTES = 30 * 1024 * 1024
"""One document fetch's wall clock and body ceiling -- a paper arrives
in seconds; a 30MB file is not a reading task."""


def _fetch_document(url: str) -> bytes:
    """The document's bytes -- the browser sits OUT for this path (it
    renders PDFs as viewer chrome and Office files as download prompts,
    never content): a direct fetch over the shared loop instead, behind
    the same ``guard_url`` gate the render path passed.  Raises
    :class:`PageReadError` on anything unreadable."""

    async def _get():
        return await _document_network().request(
            "GET", url, timeout=_DOC_FETCH_TIMEOUT, headers={"User-Agent": gen_useragent()}
        )

    try:
        resp = asyncio.run_coroutine_threadsafe(_get(), get_loop()).result(_DOC_FETCH_TIMEOUT + 5)
    except Exception as exc:  # pylint: disable=broad-except
        raise PageReadError(f"the document could not be fetched ({exc})") from exc
    content = resp.content or b""
    if not content:
        raise PageReadError("the document url returned an empty body")
    if len(content) > _DOC_MAX_BYTES:
        raise PageReadError(f"the document is too large to read ({len(content)} bytes)")
    mime = str(resp.headers.get("content-type") or "").split(";", maxsplit=1)[0].strip().lower()
    if mime and ("text/html" in mime or "text/plain" in mime) and not content.startswith(b"%PDF"):
        # a .pdf/.docx url that 404s serves an error page -- say so, let
        # markitdown's own parse errors handle the rest
        raise PageReadError(f"the url does not serve a document (content-type {mime})")
    return content


def _document_title(url: str) -> str:
    tail = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
    return (tail or "document")[:200]


def _read_document(url: str, extension: str, limit: int | None) -> tuple[str, str]:
    """One document as markdown -- markitdown's pass over the fetched
    bytes (extract.py's PageReadError is the shared failure shape).
    Papers, spreadsheets, slide decks skip the browser entirely."""
    try:
        text = convert_service.to_markdown(_fetch_document(url), extension)
    except convert_service.ConvertError as exc:
        raise PageReadError(f"the document could not be read ({exc})") from exc
    return _document_title(url), _cap(text, limit)


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
    """(title, markdown text) of one URL -- ``read(url)``'s whole world.
    Raises :class:`PageReadError` with a message meant
    for the model (the tool result)."""
    if not configured():
        raise PageReadError("the page reader is not configured on this instance")
    guarded = guard_url(url)
    key = normalize_url(guarded)
    cached = _cache_get(key)
    if cached is not None:
        return cached
    extension = urlsplit(guarded).path.lower().rsplit(".", 1)[-1]
    if convert_service.is_document_extension(extension):
        # the browser renders these as viewer chrome or a download prompt,
        # never content -- a document url FETCHES its bytes and converts
        title, text = _read_document(guarded, extension, max_chars())
    else:
        html_text = rendered_html(guarded)
        if not html_text.strip():
            raise PageReadError("the browser rendered an empty page")
        title, text = extract_page(html_text, guarded, max_chars())
    _cache_put(key, title, text)
    return title, text
