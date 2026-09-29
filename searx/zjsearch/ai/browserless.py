# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: the Browserless v2 page reader of AI Search.

``web_crawler`` turns one URL into reading material for the research model:
the page renders in the self-hosted Browserless browser (v2 ``POST
/content`` -- a real Chrome, so JS/SPA pages come out complete) and the
HTML condenses to compact markdown-ish text with a small lxml extractor
(title, main-content heuristic, headings, lists, tables, code, plus a
capped links appendix the model can follow with further ``web_crawler``
calls).  No new dependency: lxml ships with searxng, and the HTTP call
rides the instance's default network (``outgoing.proxies`` apply like for
every engine).

Configuration: the ``zjsearch.ai.browserless`` block -- ``endpoint`` (the
v2 root, e.g. ``https://browser.example.com``) and ``key`` (falls back to
the ``ZJSEARCH_BROWSERLESS_KEY`` environment, like ``ZJSEARCH_AI_KEY``).
Unconfigured means the ``web_crawler`` tool never registers (no error, the
model simply does not see it).  A small TTL cache keeps a re-read page
(the model coming back to a source) from rendering twice.
"""

import asyncio
import concurrent.futures
import collections
import ipaddress
import logging
import os
import re
import time
import typing as t
from urllib.parse import urljoin, urlsplit

import httpx
from lxml import etree, html as lhtml

from searx import settings
from searx.network.client import get_loop
from searx.network.network import get_network

logger = logging.getLogger(__name__)

FETCH_TIMEOUT = httpx.Timeout(75.0, connect=10.0)
"""The one browserless request's budget: the goto itself may take 30 s
(Browserless' own ceiling) plus render, settle and transfer."""

GOTO_TIMEOUT_MS = 30_000
SETTLE_MS = 1_200
"""Wait for ``load`` plus a short settle -- late hydration gets a moment
without paying a fixed second per page."""

REJECT_RESOURCE_TYPES = ("image", "media", "font")
"""The reader only needs the DOM: media loads are the bulk of the wall
time and are rejected at the request level."""

DEFAULT_MAX_CHARS = 12_000
"""Readable characters per page fed to the model; a long page truncates
with an honest marker (the model prefers a site:-search then)."""

CACHE_TTL = 600.0
CACHE_MAX = 128
"""Same-page re-reads (a model returning to a source) reuse one render
for ten minutes; the FIFO cap keeps a long-lived worker's memory flat."""

LINKS_MAX = 25
"""The links appendix cap -- enough for the model to follow a site's
structure without flooding the feed."""

_BLOCK_TAGS = frozenset(
    {
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "ul",
        "ol",
        "li",
        "pre",
        "blockquote",
        "table",
        "div",
        "section",
        "article",
        "main",
        "header",
        "footer",
        "aside",
        "nav",
        "form",
        "figure",
    }
)
_DROP_TAGS = frozenset(
    {
        "script",
        "style",
        "noscript",
        "template",
        "svg",
        "canvas",
        "iframe",
        "video",
        "audio",
        "object",
        "embed",
        "form",
        "button",
        "select",
        "textarea",
        "label",
        "nav",
        "header",
        "footer",
        "aside",
        "dialog",
        "link",
        "meta",
    }
)
_HEADINGS = frozenset({"h1", "h2", "h3", "h4", "h5", "h6"})

_cache: "collections.OrderedDict[str, tuple[float, str, str]]" = collections.OrderedDict()


class PageReadError(Exception):
    """A page could not be read -- the message travels to the model as the
    tool result (a dead end it is taught to move on from)."""


def _cfg() -> dict[str, t.Any]:
    """The ``zjsearch.ai.browserless`` settings block (absent unless the
    deployment defines it)."""
    ai = settings.get("zjsearch", {}).get("ai", {})
    cfg = ai.get("browserless") if isinstance(ai, dict) else None
    return cfg if isinstance(cfg, dict) else {}


def _key(cfg: dict[str, t.Any]) -> str:
    """The effective API key: the ``key`` setting first, then the
    ``ZJSEARCH_BROWSERLESS_KEY`` environment."""
    return str(cfg.get("key") or "") or os.environ.get("ZJSEARCH_BROWSERLESS_KEY", "")


def endpoint() -> str:
    """The Browserless v2 root (``zjsearch.ai.browserless.endpoint``), no
    trailing slash."""
    return str(_cfg().get("endpoint") or "").strip().rstrip("/")


def configured() -> bool:
    """True when ``endpoint`` and ``key`` are both present -- the gate for
    registering the ``web_crawler`` tool at all."""
    return bool(endpoint() and _key(_cfg()))


def normalize_url(url: str) -> str:
    """The dedup / cache key of a page: whitespace-stripped, fragment-free."""
    return str(url or "").strip().split("#", 1)[0]


def _guard_url(url: str) -> str:
    """Public http(s) URLs only: the model is untrusted input, and the
    render happens inside the Browserless host's network -- loopback,
    private ranges and the cloud metadata endpoint stay out of reach."""
    candidate = str(url or "").strip()
    if not candidate or len(candidate) > 2000:
        raise PageReadError("not a usable url")
    parts = urlsplit(candidate)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise PageReadError(f"not a public http(s) url: {candidate[:120]}")
    host = parts.hostname.lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise PageReadError(f"refusing a non-public host: {host}")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return candidate
    if not ip.is_global:
        # is_global covers private, loopback, link-local, reserved,
        # multicast and documentation ranges in one stroke
        raise PageReadError(f"refusing a non-public address: {host}")
    return candidate


def _max_chars() -> int:
    """``zjsearch.ai.browserless.max_chars``, clamped to sane bounds."""
    try:
        value = int(_cfg().get("max_chars"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_MAX_CHARS
    return max(2000, min(value, 100_000))


def _error_snippet(text: str) -> str:
    """One truncated, tag-stripped line of a browserless error body (the
    server answers with HTML pages on some failures)."""
    plain = " ".join(re.sub(r"<[^>]+>", " ", str(text or "")).split())
    return plain[:200] or "no reason given"


def _fetch(url: str) -> str:
    """The rendered HTML of one URL through Browserless v2 ``POST
    /content`` (the instance's default network: proxies apply)."""
    body = {
        "url": url,
        "gotoOptions": {"waitUntil": "load", "timeout": GOTO_TIMEOUT_MS},
        "waitForTimeout": SETTLE_MS,
        "rejectResourceTypes": list(REJECT_RESOURCE_TYPES),
    }
    future = asyncio.run_coroutine_threadsafe(
        get_network().request(
            "POST",
            f"{endpoint()}/content",
            params={"token": _key(_cfg())},
            json=body,
            headers={"Content-Type": "application/json"},
            timeout=FETCH_TIMEOUT,
            # status codes are THIS module's message to the model (a 4xx/5xx
            # body carries the actual reason) -- no network-layer raise
            raise_for_httperror=False,
        ),
        get_loop(),
    )
    try:
        response = future.result(timeout=80.0)
    except concurrent.futures.TimeoutError as exc:
        raise PageReadError("browserless timed out") from exc
    except Exception as exc:  # pylint: disable=broad-except
        # the network layer re-raises whatever its client dialect raised
        # (curl_cffi / httpx connection failures) -- one line for the model
        raise PageReadError(f"browserless unreachable: {type(exc).__name__}") from exc
    if response.status_code != 200:
        raise PageReadError(f"browserless HTTP {response.status_code}: {_error_snippet(response.text)}")
    return response.text


def _cache_get(key: str) -> tuple[str, str] | None:
    item = _cache.get(key)
    if item is None:
        return None
    stamp, title, text = item
    if time.monotonic() - stamp > CACHE_TTL:
        _cache.pop(key, None)
        return None
    _cache.move_to_end(key)
    return (title, text)


def _cache_put(key: str, title: str, text: str) -> None:
    _cache[key] = (time.monotonic(), title, text)
    _cache.move_to_end(key)
    while len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)


def _text_of(element: lhtml.HtmlElement) -> str:
    return " ".join(element.text_content().split())


def _own_text(element: lhtml.HtmlElement) -> str:
    """The element's text WITHOUT nested-list subtrees (a list item's
    bullet text only -- the nested ``ul``/``ol`` render on their own)."""
    parts = [" ".join((element.text or "").split())]
    for child in element.iterchildren():
        if isinstance(child.tag, str) and child.tag not in ("ul", "ol"):
            parts.append(_text_of(child))
    return " ".join(part for part in parts if part)


def _has_block(element: lhtml.HtmlElement) -> bool:
    for descendant in element.iter():
        if descendant is not element and isinstance(descendant.tag, str) and descendant.tag in _BLOCK_TAGS:
            return True
    return False


def _walk_list(list_el: lhtml.HtmlElement, out: list[str], depth: int = 1) -> None:
    for li in list_el.iterchildren("li"):
        text = _own_text(li)
        if text:
            out.append("  " * (depth - 1) + "- " + text)
        for sub in li.iterchildren():
            if isinstance(sub.tag, str) and sub.tag in ("ul", "ol"):
                _walk_list(sub, out, depth + 1)


def _table_rows(table: lhtml.HtmlElement) -> list[str]:
    rows: list[str] = []
    for tr in table.iter("tr"):
        cells = [_text_of(cell) for cell in tr.iterchildren() if isinstance(cell.tag, str) and cell.tag in ("td", "th")]
        if any(cells):
            rows.append("| " + " | ".join(cells) + " |")
    return rows[:100]


def _walk(element: lhtml.HtmlElement, out: list[str]) -> None:  # pylint: disable=too-many-branches
    for child in element.iterchildren():
        if not isinstance(child.tag, str):
            continue  # comments / processing instructions
        tag = child.tag
        if tag in _HEADINGS:
            text = _text_of(child)
            if text:
                out.append("#" * min(int(tag[1]), 6) + " " + text)
                out.append("")
        elif tag == "p":
            text = _text_of(child)
            if text:
                out.append(text)
                out.append("")
        elif tag in ("ul", "ol"):
            _walk_list(child, out)
            out.append("")
        elif tag == "pre":
            code = child.text_content().strip("\n")[:2000]
            if code.strip():
                out.append("```")
                out.append(code)
                out.append("```")
                out.append("")
        elif tag == "blockquote":
            text = _text_of(child)
            if text:
                out.append(f"> {text}")
                out.append("")
        elif tag == "table":
            rows = _table_rows(child)
            if rows:
                out.extend(rows)
                out.append("")
        elif _has_block(child):
            _walk(child, out)
        else:
            # a leaf container (div soup, spans) reads as one paragraph
            text = _text_of(child)
            if text:
                out.append(text)
                out.append("")


def _main_of(body: lhtml.HtmlElement) -> lhtml.HtmlElement:
    """The page's main-content element: a semantic landmark when one
    exists, else the largest content-ish container, else the body."""
    for xpath in ("//article", "//main", "//*[@role='main']"):
        candidates = [element for element in body.xpath(xpath) if isinstance(element.tag, str)]
        if candidates:
            return max(candidates, key=lambda element: len(element.text_content()))
    candidates = [
        element
        for element in body.iter("div", "section")
        if isinstance(element.tag, str)
        and any(
            token in f"{element.get('class') or ''} {element.get('id') or ''}".lower()
            for token in ("content", "article", "main", "post", "entry")
        )
    ]
    if candidates:
        best = max(candidates, key=lambda element: len(element.text_content()))
        if len(best.text_content()) * 2 >= len(body.text_content()):
            return best
    return body


def _title_of(doc: lhtml.HtmlElement, body: lhtml.HtmlElement) -> str:
    node = doc.find(".//title")
    title = " ".join((node.text or "").split()) if node is not None else ""
    if not title:
        for xpath in (
            "//meta[@property='og:title']/@content",
            "//meta[@name='og:title']/@content",
            "//meta[@name='twitter:title']/@content",
        ):
            found = [str(item) for item in doc.xpath(xpath) if str(item).strip()]
            if found:
                title = " ".join(found[0].split())
                break
    if not title:
        for element in body.iter("h1"):
            title = _text_of(element)
            if title:
                break
    return title[:200]


def _links_of(main: lhtml.HtmlElement, base_url: str) -> list[str]:
    """A capped, deduplicated appendix of the page's links -- the model
    can ``web_crawler`` its way through a site's structure."""
    lines: list[str] = []
    seen: set[str] = set()
    for anchor in main.iter("a"):
        href = anchor.get("href") or ""
        if not href or href.startswith(("mailto:", "javascript:", "tel:", "#")):
            continue
        absolute = urljoin(base_url, href)
        if not absolute.startswith(("http://", "https://")) or absolute in seen:
            continue
        seen.add(absolute)
        label = _text_of(anchor) or absolute
        lines.append(f"- {label[:120]} <{absolute[:300]}>")
        if len(lines) >= LINKS_MAX:
            break
    return lines


def _cap(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    newline = cut.rfind("\n")
    if newline > max_chars // 2:
        cut = cut[:newline]
    return f"{cut}\n\n[... truncated, the full page is {len(text)} characters ...]"


def _extract(html_text: str, base_url: str) -> tuple[str, str]:
    """(title, markdown-ish text) of a rendered page."""
    doc = lhtml.document_fromstring(html_text)
    body = doc.body
    if body is None:
        raise PageReadError("the page has no body")
    title = _title_of(doc, body)
    main = _main_of(body)
    for element in list(main.iter()):
        if isinstance(element.tag, str) and element.tag in _DROP_TAGS and element.getparent() is not None:
            element.drop_tree()
    lines: list[str] = []
    _walk(main, lines)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    # a layout the walker cannot crack (canvas apps, sentence-per-div soup)
    # falls back to the body's raw collapsed text -- noisy but honest
    if len(text) < min(600, len(_text_of(body)) * 0.2):
        text = _text_of(body)
    links = _links_of(main, base_url)
    if links:
        text = (text + "\n\nLinks on the page:\n" + "\n".join(links)).strip() if text else "\n".join(links)
    if len(text.strip()) < 40:
        raise PageReadError("no readable content found")
    return title, _cap(text, _max_chars())


def read_page(url: str) -> tuple[str, str]:
    """(title, markdown-ish text) of one URL -- the ``web_crawler`` tool's
    whole world.  Raises :py:class:`PageReadError` with a message meant
    for the model (the tool result)."""
    if not configured():
        raise PageReadError("the page reader is not configured on this instance")
    guarded = _guard_url(url)
    key = normalize_url(guarded)
    cached = _cache_get(key)
    if cached is not None:
        return cached
    html_text = _fetch(guarded)
    if not html_text.strip():
        raise PageReadError("the browser rendered an empty page")
    try:
        title, text = _extract(html_text, guarded)
    except etree.ParserError as exc:
        raise PageReadError("the page's markup is unreadable") from exc
    _cache_put(key, title, text)
    return title, text
