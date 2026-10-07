# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search page reader: the HTML extraction and Markdown conversion.

The rendered page condenses in one lxml pass: the main-content element
(semantic landmark, else the largest content-ish container), noise tags
dropped, fragment-only anchors stripped, then ``html-to-markdown``
converts the cleaned subtree to real Markdown -- ATX headings, GFM
tables, code-block languages, inline semantics.  Without the converter
the hand-rolled walker produces markdown-ish text (a degraded but
honest fallback).  A capped links appendix gives the model the page's
structure to crawl further.
"""

import logging
import re
from urllib.parse import urljoin

from lxml import etree, html as lhtml

from searx.zjsearch.ai.tools.web_reader.fetch import PageReadError

logger = logging.getLogger(__name__)

try:  # html-to-markdown 3.x -- MIT, zero runtime deps, a compiled core
    from html_to_markdown import ConversionOptions, HeadingStyle, convert
except ImportError:  # the built-in walker keeps the reader alive without it
    convert = None
    logger.warning(
        "html-to-markdown is not installed -- the page reader degrades to"
        " the built-in walker (pip install html-to-markdown)"
    )

_H2MD_OPTIONS = (
    None
    if convert is None
    else ConversionOptions(
        heading_style=HeadingStyle.ATX,
        extract_metadata=False,
        # the reader's body is prose for a text model: images never render
        # (the feed's img= lines carry the useful ones) and metadata side
        # channels are dead weight
        skip_images=True,
    )
)

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
    can ``web_reader`` its way through a site's structure."""
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
    :class:`PageReadError` when the markup is unreadable or nothing
    readable survives the pipeline."""
    try:
        doc = lhtml.document_fromstring(html_text)
    except etree.ParserError as exc:
        raise PageReadError("the page's markup is unreadable") from exc
    body = doc.body
    if body is None:
        raise PageReadError("the page has no body")
    title = _title_of(doc, body)
    main = _main_of(body)
    for element in list(main.iter()):
        if not isinstance(element.tag, str) or element.getparent() is None:
            continue
        if element.tag in _DROP_TAGS:
            element.drop_tree()
        elif element.tag == "a" and str(element.get("href") or "").startswith("#"):
            # fragment-only anchors are permalink / TOC self-links (sphinx's
            # "¶") -- pure noise once links convert to inline markdown
            element.drop_tree()
    if convert is not None:
        text = convert(lhtml.tostring(main, encoding="unicode"), _H2MD_OPTIONS).content.strip()
    else:
        # the degraded fallback: markdown-ISH text from the hand-rolled
        # walker (no inline semantics, separator-less tables)
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
    return title, _cap(text, max_chars)
