# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The past-research capability: the model's RAG window into the browser's
LOCAL knowledge base (the PGlite corpus -- sources and reader full-texts
accumulated across sessions).  The run pre-sends a small candidate index
-- the semantic half already ran client-side when the index was picked --
carrying TWO entry kinds:

- ``page`` entries: reader-cache pages WITH a ~1500-char content head
  (what a past ``web_reader`` read extracted);
- ``source`` entries: corpus sources the user's past runs touched,
  identity only (title + host -- no text stored).

The :py:func:`past_research_spec` tool searches the index on the model's
initiative.  A page match returns its content head; a source-only match
returns the identity plus the instruction to re-verify it live through
``web_reader`` -- past material supplements, live sources win.

THE RED LINE (AGENTS.md): this is supplementary, OPT-IN material -- the
model asks for its past when a stored page may hold the missing detail;
it never substitutes for live search and stale content loses to live
sources.  The server stays stateless: the index rides the request,
nothing is stored server-side."""

import re
import typing as t

MAX_ENTRIES = 12
"""Index entries per request -- pages carry a ~1500-char text head."""
MAX_TEXT = 1500
"""Per-entry text head at parse time (the client already truncates)."""
MATCH_LIMIT = 4
"""Matches returned per tool call, each with its content slice."""


def parse_entries(raw: t.Any) -> list[dict[str, str]]:
    """The run payload's ``past_research`` index -- sanitized.  An entry
    with a ``text`` head is a reader page; one without is a corpus source
    (identity only)."""
    out: list[dict[str, str]] = []
    if isinstance(raw, list):
        for item in raw[:MAX_ENTRIES]:
            if isinstance(item, dict) and item.get("url"):
                out.append(
                    {
                        "url": str(item["url"])[:500],
                        "title": str(item.get("title") or "")[:300],
                        "host": str(item.get("host") or "")[:120],
                        "text": str(item.get("text") or "")[:MAX_TEXT],
                    }
                )
    return out


def rank(entries: list[dict[str, str]], query: str, limit: int = MATCH_LIMIT) -> list[dict[str, str]]:
    """Keyword-score the index (terms against title + text head); entries
    matching the TITLE rank above text-only matches.  Simple, fast,
    deterministic -- the index is tiny and the semantic half already ran
    client-side when the index was picked."""
    terms = [term for term in re.split(r"[\s,，]+", query.lower()) if term]
    if not terms:
        return []
    scored: list[tuple[float, dict[str, str]]] = []
    for entry in entries:
        title = entry["title"].lower()
        text = entry["text"].lower()
        score = 0.0
        for term in terms:
            if term in title:
                score += 2.0
            elif term in text:
                score += 1.0
        if score > 0:
            scored.append((score, entry))
    scored.sort(key=lambda pair: -pair[0])
    return [entry for _, entry in scored[:limit]]
