# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The writer's feed builder: real results -> the compact [n] lines.

:py:func:`serialize_results` renders raw engine results through the very
``_result_data`` macro the page-data uses (the client's sub-result cards
speak the same shape); :py:func:`build_search_feed` compiles one
search's serialized entries into the ``[n]`` feed block the model reads
(5 deep with snippet heads + 5 shallow title-only, images marked
``img=`` and whitelisted into the gallery pool).
"""

import json
import logging
import typing as t
from html import escape

import flask

from searx.webutils import highlight_content
from searx.zjsearch.ai.llm.embed import cosine as embed_cosine
from searx.zjsearch.ai.tools import web_reader as reader
from searx.zjsearch.ai.runs.search.registry import SourcesRegistry

logger = logging.getLogger(__name__)

FEED_DEEP = 5
FEED_SHALLOW = 5
FEED_SNIPPET_CHARS = 300
"""The model's compacted view of one search: 5 deep (title + snippet
head) + 5 shallow (title only), numbered with the global [n] registry."""

RESULTS_CAP = 30
"""Results per search sent to the client (the model only sees the feed)."""

_RESULT_TEMPLATE = (
    '{%- from "zjsearch/data/macros.html" import result_data with context -%}'
    # the separator is a block-if ON PURPOSE: inline-if string literals come
    # out autoescaped ("&#34;, &#34;") and break the JSON (the repo gotcha)
    '[{%- for result in results %}{% if not loop.first %},{% endif %}{{ result_data(result) }}{%- endfor %}]'
)


def serialize_results(raw_results: list[t.Any], query: str) -> list[dict[str, t.Any]]:
    """Ordered results as page-data-shaped dicts -- highlighted like the
    search view does, serialized through the very ``_result_data`` macro
    the page payload uses (runs in the request thread).  The FEED builder
    consumes them; the client's sources grid rides the ``sources`` event,
    never this serialized payload."""
    for result in raw_results:
        if "content" in result and result["content"]:
            result["content"] = highlight_content(escape(result["content"][:1024]), query)
        if "title" in result and result["title"]:
            result["title"] = highlight_content(escape(result["title"] or ""), query)
    rendered = None
    try:
        # the macro speaks the render context's helper functions -- pass the
        # very same callables webapp.render / the stream mirror pass
        from searx import webapp  # pylint: disable=import-outside-toplevel,cyclic-import

        rendered = flask.render_template_string(
            _RESULT_TEMPLATE,
            results=raw_results,
            favicon_url=webapp.favicons.favicon_url,
            get_pretty_url=webapp.get_pretty_url,
            image_proxify=webapp.image_proxify,
        )
        return json.loads(rendered)
    except Exception as exc:  # pylint: disable=broad-except
        # a malformed field reaching the macro raises anything from
        # ValueError to jinja2.TemplateError; one bad result degrades to no
        # serialized feed for THAT search, never a crashed round
        logger.warning(
            "zjsearch_ai_search: result serialization failed: %r -- head: %.240r",
            exc,
            rendered if isinstance(rendered, str) else "",
        )
        return []


def _dup_match(reg: SourcesRegistry, dup_gate: dict[str, t.Any] | None, pos: int) -> int | None:
    """The semantic dup gate's verdict for feed position ``pos``: the fed
    [n] whose embedding clears the gate's threshold against the
    position's vector, or ``None`` -- no vector at this position means
    unchecked (fail-open), like every stage of the funnel."""
    vector = ((dup_gate or {}).get("vectors") or {}).get(pos)
    if vector is None:
        return None
    threshold = float((dup_gate or {}).get("threshold") or 0.0)
    for fed_n, fed_vector in reg.fed_vectors:
        if embed_cosine(vector, fed_vector) >= threshold:
            return fed_n
    return None


def build_search_feed(  # pylint: disable=too-many-locals
    reg: SourcesRegistry,
    query: str,
    category: str,
    items: list[dict[str, t.Any]],
    dup_gate: dict[str, t.Any] | None = None,
) -> tuple[str, list[dict[str, t.Any]]]:
    """One search's serialized entries -> ``(feed block, source entries)``.
    The cross-search dedup points at a url's EXISTING [n] instead of
    minting a duplicate (the sources grid shows the page once); an
    img-bearing upgrade entry reaches the client when a parallel page
    read numbered the url first.
    ``dup_gate`` (optional) is the SEMANTIC layer over the exact-url dedup:
    ``{"vectors": {feed position -> the head's embedding}, "threshold":
    cosine, "dropped": list the matched [n]s land in}`` -- a new url whose
    embedding clears the threshold against any ALREADY-FED source is the
    same story from another outlet: no line, no mint, and the existing
    [n] rides the row's ``dupes`` so the model (and the client) still see
    where the story lives.  Fail-open: a missing vector means unchecked."""
    entries: list[dict[str, t.Any]] = []
    feed_lines = [f'Search "{query}" (category: {category}) returned {len(items)} results:']
    for pos, item in enumerate(items[: FEED_DEEP + FEED_SHALLOW]):
        meta = str(item.get("length_display") or item.get("filesize_display") or "")
        url = str(item.get("url") or "")
        norm = reader.normalize_url(url) if url else ""
        known_n = reg.known(norm)
        title = str(item.get("title_text") or "")
        netloc = str(item.get("netloc") or "")
        img = str(item.get("img_src") or item.get("thumbnail") or item.get("thumbnail_src") or "")
        if known_n is not None:
            if pos < FEED_DEEP:
                head = str(item.get("content_text") or "")[:FEED_SNIPPET_CHARS]
                reg.note_gallery(img, known_n)
                feed_lines.append(f"[{known_n}] {netloc}: {title} - {head} (same source as an earlier result)")
            else:
                feed_lines.append(f"[{known_n}] {netloc}: {title} (same source as an earlier result)")
            if img:
                entries.append(
                    {
                        "n": known_n,
                        "round": 0,
                        "id": 0,
                        "idx": pos,
                        "title": title[:200],
                        "url": url,
                        "netloc": netloc,
                        "favicon": str(item.get("favicon") or ""),
                        "img": img,
                        "content": str(item.get("content_text") or "")[:500],
                        "pretty_url": str(item.get("pretty_url") or ""),
                        "published_date": str(item.get("published_date") or ""),
                        "meta": meta,
                        "engines": [str(e) for e in (item.get("engines") or [])][:4],
                        "score": item.get("score"),
                    }
                )
            continue
        # the SEMANTIC dup gate (fail-open): a fresh url whose embedding
        # clears the threshold against an already-fed source is the same
        # story syndicated elsewhere -- no line, no [n], the existing
        # number rides the row's ``dupes``
        dup_match = _dup_match(reg, dup_gate, pos)
        if dup_match is not None:
            dropped = (dup_gate or {}).setdefault("dropped", [])
            if dup_match not in dropped and len(dropped) < 12:
                dropped.append(dup_match)
            continue
        n = reg.mint()
        reg.note_url(norm, n)
        reg.note_meta(norm, title, str(item.get("content_text") or ""))
        dup_vector = (dup_gate or {}).get("vectors", {}).get(pos)
        if dup_vector is not None:
            reg.note_vector(n, dup_vector)
        # the gallery whitelist mirrors the FEED: only deep lines carry the
        # img= token -- an image the model was never shown must not spend
        # the writer's validated pool
        if pos < FEED_DEEP:
            reg.note_gallery(img, n)
        entries.append(
            {
                "n": n,
                "round": 0,
                "id": 0,
                "idx": pos,
                "title": title[:200],
                "url": url,
                "netloc": netloc,
                "favicon": str(item.get("favicon") or ""),
                "img": img,
                "category": str(item.get("category") or ""),
                "content": str(item.get("content_text") or "")[:500],
                "pretty_url": str(item.get("pretty_url") or ""),
                "published_date": str(item.get("published_date") or ""),
                "meta": meta,
                "engines": [str(e) for e in (item.get("engines") or [])][:4],
                "score": item.get("score"),
            }
        )
        if pos < FEED_DEEP:
            head = str(item.get("content_text") or "")[:FEED_SNIPPET_CHARS]
            img_part = f" img={img}" if img else ""
            feed_lines.append(f"[{n}] {netloc}: {title} - {head}{img_part}")
        else:
            feed_lines.append(f"[{n}] {netloc}: {title}")
    return "\n".join(feed_lines), entries
