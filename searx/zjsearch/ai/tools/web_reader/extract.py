# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search page reader: the HTML extraction and Markdown conversion.

The WHOLE rendered page goes to the shared markitdown service
(:py:mod:`core.convert`) -- no readability extraction, no drop-tree:
SILENT CONTENT LOSS is the one unacceptable failure here, and page
chrome (nav, footer, banners) is visible noise the model navigates past
on its own.  Title and the capped links appendix ride a bs4 parse of
the same markup (read-only -- nothing is removed from what converts).
"""

import logging
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from searx.zjsearch.ai.core import convert as convert_service

logger = logging.getLogger(__name__)


class PageReadError(Exception):
    """A page could not be read -- the message travels to the model as the
    tool result (a dead end it is taught to move on from).  The shared
    error type of the whole ``web_reader`` package, defined here at its
    bottom module: guard, render and extraction all raise it."""


LINKS_MAX = 25
"""The links appendix cap -- enough for the model to follow a site's
structure without flooding the feed."""


def _title_of(soup: BeautifulSoup) -> str:
    node = soup.find("title")
    title = " ".join(node.get_text().split()) if node is not None else ""
    if not title:
        for attrs in ({"property": "og:title"}, {"name": "og:title"}, {"name": "twitter:title"}):
            found = soup.find("meta", attrs=attrs)
            if found and found.get("content"):
                title = " ".join(str(found["content"]).split())
                break
    if not title:
        heading = soup.find("h1")
        if heading is not None:
            title = " ".join(heading.get_text().split())
    return title[:200]


def _links_of(soup: BeautifulSoup, base_url: str) -> list[str]:
    """A capped, deduplicated appendix of the page's links -- the model
    can ``web_reader`` its way through a site's structure."""
    lines: list[str] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a"):
        href = anchor.get("href") or ""
        if not href or href.startswith(("mailto:", "javascript:", "tel:", "#")):
            continue
        absolute = urljoin(base_url, href)
        if not absolute.startswith(("http://", "https://")) or absolute in seen:
            continue
        seen.add(absolute)
        label = " ".join(anchor.get_text().split()) or absolute
        lines.append(f"- {label[:120]} <{absolute[:300]}>")
        if len(lines) >= LINKS_MAX:
            break
    return lines


def _cap(text: str, max_chars: int | None) -> str:
    if max_chars is None or len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    newline = cut.rfind("\n")
    if newline > max_chars // 2:
        cut = cut[:newline]
    return f"{cut}\n\n[... truncated, the full page is {len(text)} characters ...]"


def extract_page(html_text: str, base_url: str, max_chars: int | None) -> tuple[str, str]:
    """(title, markdown text) of a rendered page.  Raises
    :class:`PageReadError` when the markup is unreadable, the converter
    fails or nothing readable survives the pass."""
    try:
        soup = BeautifulSoup(html_text, "lxml")
    except Exception as exc:  # pylint: disable=broad-except
        raise PageReadError("the page's markup is unreadable") from exc
    title = _title_of(soup)
    try:
        text = convert_service.to_markdown(html_text, "html")
    except convert_service.ConvertError as exc:
        raise PageReadError(f"the page could not be converted to markdown ({exc})") from exc
    links = _links_of(soup, base_url)
    if links:
        text = (text + "\n\nLinks on the page:\n" + "\n".join(links)).strip() if text else "\n".join(links)
    if len(text.strip()) < 40:
        raise PageReadError("no readable content found")
    return title, _cap(text, max_chars)
