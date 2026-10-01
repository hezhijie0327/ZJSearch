# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The web-memory capability: the model's window into the browser's
PAST research (the sources and reader full-texts accumulated across
sessions).  The run pre-sends a small candidate index -- reader-cache
pages matching the question, WITH a content head each -- and the
``web_memory`` tool searches it on the model's initiative, returning
text slices that the executor numbers as real ``[n]`` sources (kind
history, the same badge the automatic writer-injection carries).

THE RED LINE (AGENTS.md): this is supplementary, OPT-IN material -- the
model asks for memory when a past page may hold the missing detail; it
never substitutes for live search and stale content loses to live
sources.  The server stays stateless: the index rides the request,
nothing is stored server-side."""

import re
import typing as t

WEB_MEMORY_TOOL = "web_memory"

MAX_ENTRIES = 12
"""Index entries per request -- each carries a ~1500-char text head."""
MAX_TEXT = 1500
"""Per-entry text head at parse time (the client already truncates)."""
MATCH_LIMIT = 4
"""Matches returned per tool call, each with its content slice."""


def parse_entries(raw: t.Any) -> list[dict[str, str]]:
    """The run payload's ``web_memory`` index -- sanitized."""
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


def web_memory_spec() -> dict[str, t.Any]:
    """The ``web_memory`` tool spec -- registered only when the client
    sent an index."""
    return {
        "name": WEB_MEMORY_TOOL,
        "description": (
            "Search YOUR past research with this user: pages you (or a"
            " previous session) already read in full, matching the"
            " keywords.  Returns each match's content head.  Use it when"
            " a past page plausibly holds the missing detail (the user"
            ' references "之前查过的/上次看的", or a prior topic recurs).'
            "  Past content may be OUTDATED -- it supplements, never"
            " replaces, live search: keep searching when the memory is"
            " thin, and prefer fresh sources for anything time-sensitive."
            "  Matched pages arrive as numbered [n] sources you can cite."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Keywords for the past page's topic" ' (e.g. "高铁 门票价格", "camera sensor review").'
                    ),
                },
            },
            "required": ["query"],
        },
    }


def parse_query(call: dict[str, t.Any]) -> str:
    """The tool call's query -- sanitized."""
    import json  # pylint: disable=import-outside-toplevel

    try:
        args = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    return str(args.get("query") or "").strip()[:200]


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


def evaluate_call(call: dict[str, t.Any], entries: list[dict[str, str]]) -> tuple[str, list[dict[str, t.Any]], int]:
    """One tool call -> (model feed, sources events, match count).  The
    CALLER assigns the [n] numbers (state.next_n) and appends feed
    blocks -- the matches become citable sources like any other."""
    query = parse_query(call)
    matches = rank(entries, query)
    if not matches:
        return "(no page in the user's past research matches -- continue with live search)", [], 0
    blocks = [f"[placeholder] {entry['title']} -- {entry['url']}\n{entry['text']}" for entry in matches]
    feed_head = (
        f"from the user's PAST research (may be outdated -- live sources"
        f" take precedence; {len(matches)} match(es)):"
    )
    return feed_head, blocks, len(matches)
