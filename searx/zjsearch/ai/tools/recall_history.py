# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``recall_history`` tool: one self-contained package -- the
model-facing spec, the call parser and the index service it backs (the
model's RAG window into the browser's LOCAL knowledge base -- the
PGlite corpus of sources and reader full-texts accumulated across
sessions).  The run pre-sends a small candidate index -- the semantic
half already ran client-side when the index was picked -- carrying TWO
entry kinds:

- ``page`` entries: reader-cache pages WITH a ~1500-char content head
  (what a past ``browse`` read extracted);
- ``source`` entries: corpus sources the user's past runs touched,
  identity only (title + host -- no text stored).

The tool searches the index on the model's initiative.  A page match
returns its content head; a source-only match returns the identity plus
the instruction to re-verify it live through ``browse`` -- past
material supplements, live sources win.

THE RED LINE (AGENTS.md): this is supplementary, OPT-IN material -- the
model asks for its past when a stored page may hold the missing detail;
it never substitutes for live search and stale content loses to live
sources.  The server stays stateless: the index rides the request,
nothing is stored server-side."""

import typing as t

from searx.zjsearch.ai.core.text import query_terms, raw_args

RECALL_HISTORY_TOOL = "recall_history"

MAX_ENTRIES = 12
"""Index entries per request -- pages carry a ~1500-char text head."""
MAX_TEXT = 1500
"""Per-entry text head at parse time (the client already truncates)."""
MATCH_LIMIT = 4
"""Matches returned per tool call, each with its content slice."""


def recall_history_spec() -> dict[str, t.Any]:
    """The ``recall_history`` tool spec -- registered only when the client
    sent an index."""
    return {
        "name": RECALL_HISTORY_TOOL,
        "description": (
            "Search YOUR past research with this user (the browser-local"
            " knowledge base): pages you (or a previous session) already"
            " read in full, sources earlier runs already touched, and"
            " files the user uploaded to past runs (frameworks, prior"
            " reports -- matched files return their content head"
            " directly)."
            "  Full-text matches return their content head; source-only"
            " matches return their identity -- re-read one with your page"
            " reader before relying on its details.  Use it when a past page"
            " plausibly holds the missing detail (the user references"
            ' "what we found last time" / "the page I saw earlier", or a'
            " prior topic recurs), or when the"
            " question should be judged against a framework or document the"
            " user uploaded before.  Past content"
            " may be OUTDATED -- it supplements, never replaces, live"
            " search: keep searching when the memory is thin, and prefer"
            " fresh sources for anything time-sensitive.  Matched pages"
            " arrive as numbered [n] sources you can cite; uploaded files"
            " arrive as named context blocks."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Keywords for the past page's topic"
                        ' (e.g. "shinkansen ticket prices", "camera sensor review").'
                    ),
                },
            },
            "required": ["query"],
        },
    }


def parse_query(call: dict[str, t.Any]) -> str:
    """The tool call's query -- sanitized."""
    args = raw_args(call)
    return str(args.get("query") or "").strip()[:200]


def parse_entries(raw: t.Any) -> list[dict[str, str]]:
    """The run payload's ``recall_history`` index -- sanitized.  An entry
    with a ``text`` head is a reader page; one without is a corpus source
    (identity only).  An entry WITHOUT a url is a USER-UPLOADED FILE (the
    knowledge base's attachment documents): locally archived material no
    reader can re-fetch -- its text head is the whole point."""
    out: list[dict[str, str]] = []
    if isinstance(raw, list):
        for item in raw[:MAX_ENTRIES]:
            if not isinstance(item, dict):
                continue
            url = str(item.get("url") or "").strip()
            if url:
                out.append(
                    {
                        "url": url[:500],
                        "title": str(item.get("title") or "")[:300],
                        "host": str(item.get("host") or "")[:120],
                        "text": str(item.get("text") or "")[:MAX_TEXT],
                    }
                )
            elif item.get("title") and item.get("text"):
                out.append(
                    {
                        "url": "",
                        "title": str(item.get("title"))[:300],
                        "host": "",
                        "text": str(item.get("text"))[:MAX_TEXT],
                    }
                )
    return out


def rank(entries: list[dict[str, str]], query: str, limit: int = MATCH_LIMIT) -> list[dict[str, str]]:
    """Keyword-score the index (terms against title + text head); entries
    matching the TITLE rank above text-only matches.  Simple, fast,
    deterministic -- the index is tiny and the semantic half already ran
    client-side when the index was picked."""
    terms = query_terms(query)
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
