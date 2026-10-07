# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``web_reader`` tool -- spec and call parsing.

One URL's current full content through the page-reader provider (a real
Chrome render).  The spec carries the economy policy (reads are for
snippets that promise exactly the missing detail, never a substitute
for a search round); the tool is registered only when
``zjsearch.reader`` is configured, so a model that never sees it is
never told about it (the ``web_search`` spec cross-references it
conditionally).
"""

import json
import typing as t

PAGE_TOOL = "web_reader"


def page_spec() -> dict[str, t.Any]:
    """The ``web_reader`` tool: one URL's current full content through the
    page-reader provider (a real Chrome render).  Registered only when
    ``zjsearch.reader`` is configured (else the model never sees
    it).  The description carries the economy policy: reads are for
    snippets that promise exactly the missing detail, never a substitute
    for a search round."""
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
    capped; the public-url guard runs in
    :py:mod:`searx.zjsearch.ai.tools.web_reader.fetch`."""
    try:
        args = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    return str(args.get("url") or "").strip()[:2000]
