# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``past_research`` tool's model-facing surface.

The name, the spec and the call parser live here; the index parsing and
the ranking are the capability --
:py:mod:`searx.zjsearch.ai.capabilities.past_research`.  The timeline
rows and the executor's branch reference the registered string, never a
literal.
"""

import json
import typing as t

PAST_RESEARCH_TOOL = "past_research"


def past_research_spec() -> dict[str, t.Any]:
    """The ``past_research`` tool spec -- registered only when the client
    sent an index."""
    return {
        "name": PAST_RESEARCH_TOOL,
        "description": (
            "Search YOUR past research with this user (the browser-local"
            " knowledge base): pages you (or a previous session) already"
            " read in full, and sources earlier runs already touched."
            "  Full-text matches return their content head; source-only"
            " matches return their identity -- re-read one with web_reader"
            " before relying on its details.  Use it when a past page"
            " plausibly holds the missing detail (the user references"
            ' "之前查过的/上次看的", or a prior topic recurs).  Past content'
            " may be OUTDATED -- it supplements, never replaces, live"
            " search: keep searching when the memory is thin, and prefer"
            " fresh sources for anything time-sensitive.  Matched pages"
            " arrive as numbered [n] sources you can cite."
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
    try:
        args = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    return str(args.get("query") or "").strip()[:200]
