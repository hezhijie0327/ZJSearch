# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the tool specs and their argument parsing.

Each entry the model sees (``web_search``, ``web_crawler``,
``ask_user``, ``plan``) is one spec function in the dialect-neutral
llm shape plus the sanitizers that turn untrusted call arguments into
executed / displayed values (Vane's researcher/actions split, Morphic's
lib/tools -- schema, description and parsing live with the tool).
"""

import json
import re
import typing as t

TOOL_NAME = "web_search"

PAGE_TOOL = "web_crawler"

ASK_TOOL = "ask_user"

PLAN_TOOL = "plan"

SEARCH_CATEGORIES = ("general", "news", "images", "videos", "it", "science", "files", "music")
"""The verticals the model may pick; each has a dedicated client layout."""

_BANG_PREFIX_RE = re.compile(r"^(?:\s*![a-z0-9_-]+)*(?:\s+|$)", re.IGNORECASE)
_TIME_RANGES = ("day", "week", "month", "year")


def tool_spec(with_pages: bool) -> dict[str, t.Any]:
    """The ``web_search`` tool in the dialect-neutral llm shape; with the
    page reader configured, the description cross-references it (a model
    that never sees ``web_crawler`` must not be told about it).  The
    ``included_sites``/``excluded_sites`` parameters carry the user's
    source preference (Morphic's domain filters): they are appended to the
    query as ``site:``/``-site:`` operators, which the engine's
    advanced_search_syntax plugin enforces AUTHORITATIVELY on every result
    regardless of engine support."""
    return {
        "name": TOOL_NAME,
        "description": (
            "Run one web search on the metasearch engine with specific keywords."
            " Search like a skilled human: short keyword sets (never full"
            " sentences), distinct facets of the question, alternative phrasings"
            " or translations when the wording is uncertain. Prefer several"
            " parallel calls over one broad query. Precision operators are"
            " applied authoritatively by the engine and are welcome when they"
            " sharpen the results: site: / -site:, filetype:, \"exact phrase\","
            " before:YYYY-MM-DD / after:YYYY-MM-DD. Optional filters"
            " (time_range) are not supported by every engine: when a filtered"
            " search comes back EMPTY, retry the same intent once without the"
            " filter before concluding. Never use bangs unless the user"
            " explicitly names an engine (then prefix the query, e.g. \"!baidu"
            " keywords\") -- a category search already fans out across every"
            " engine in that vertical. Results arrive as globally numbered [n]"
            " sources to cite in the final answer."
            + (
                "  When a result's snippet promises the exact missing detail,"
                f" the {PAGE_TOOL} tool can read that result's page in full."
                if with_pages
                else ""
            )
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The keyword query to search for."},
                "category": {
                    "type": "string",
                    "enum": list(SEARCH_CATEGORIES),
                    "description": (
                        "Optional vertical (images for visual context, news for"
                        " current events); general when unsure."
                    ),
                },
                "time_range": {
                    "type": "string",
                    "enum": list(_TIME_RANGES),
                    "description": (
                        "Optional freshness window -- use it when the question"
                        " is about recent material (news, releases, changelogs);"
                        " omit otherwise."
                    ),
                },
                "included_sites": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Bare domains to RESTRICT the search to (at most 3),"
                        " only when the user signals a source preference:"
                        ' "search reddit", "在 GitHub 上找" -> ["github.com"];'
                        ' "official sources" -> the relevant authoritative'
                        " domains.  Prefer this over stuffing the site name"
                        " into the keywords -- the filter is enforced exactly,"
                        " the keyword is not.  Do not invent restrictions for"
                        " ordinary queries.  If the filtered search comes"
                        " back thin, run one more without it."
                    ),
                },
                "excluded_sites": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Bare domains to EXCLUDE (at most 3), only when the"
                        ' user signals an aversion: "not pinterest" ->'
                        ' ["pinterest.com"].'
                    ),
                },
            },
            "required": ["query"],
        },
    }


def page_spec() -> dict[str, t.Any]:
    """The ``web_crawler`` tool: one URL's current full content through the
    self-hosted Browserless browser.  Registered only when
    ``zjsearch.ai.browserless`` is configured (else the model never sees
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


def plan_spec() -> dict[str, t.Any]:
    """The answer-planning tool (Vane's reasoning preamble, adapted): the
    model's deliberation about the SHAPE of its final answer goes HERE --
    the user sees it as a research step -- instead of leaking into the
    answer text (the wrapped-up model's "Excellent, [n] is useful..."
    monologue was exactly that leak)."""
    return {
        "name": PLAN_TOOL,
        "description": (
            "State how you will structure your final answer BEFORE writing"
            " it.  Call this ONCE, as the ONLY call of its turn, when you"
            " catch yourself deliberating about the answer -- triaging"
            " sources, weighing what belongs where, drafting section"
            " outlines: put THAT thinking here instead of your reply.  The"
            " plan is shown to the user as your research step; your NEXT"
            " message must be the finished answer itself, opening with the"
            " conclusion -- no meta commentary, no restating of the plan."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "plan": {
                    "type": "string",
                    "description": "1-4 sentences: the sections and shape of the answer you are about to write.",
                },
            },
            "required": ["plan"],
        },
    }


def ask_user_spec() -> dict[str, t.Any]:
    """The mid-research human-in-the-loop tool: the model may stop and ask
    when it realizes -- only research can reveal this -- that the request
    is genuinely ambiguous (an acronym naming several unrelated products,
    a code that is also a model name, ...).  The run ends with the
    questions; the answers travel back as ``clarifications``."""
    return {
        "name": ASK_TOOL,
        "description": (
            "Stop researching and ask the user to disambiguate the request."
            "  Call this ONCE, as the ONLY call of its turn, when you realize"
            " the request is genuinely ambiguous: an acronym, code or short"
            " name that matches several unrelated products/domains, where"
            " guessing wrong wastes the whole run.  Do NOT use it for broad"
            " informational topics (cover their facets instead) and do not"
            " use it after the user already confirmed a direction."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "intro": {"type": "string", "description": "One sentence on why you ask."},
                "questions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "q": {"type": "string", "description": "The question to the user."},
                            "type": {
                                "type": "string",
                                "enum": ["single", "multi"],
                                "description": "single = pick one option; multi = pick any.",
                            },
                            "options": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "2-4 short concrete answers to choose from.",
                            },
                        },
                        "required": ["q", "type", "options"],
                    },
                    "description": "At most 3 questions.",
                },
            },
            "required": ["questions"],
        },
    }


def _clean_sites(raw: t.Any) -> list[str]:
    """Bare domains out of the model's ``included_sites``/``excluded_sites``
    arguments: scheme/path/port stripped, lowercased, deduped, capped --
    anything that is not host-shaped is dropped (the operators travel in
    the query and the engine's plugin enforces them; a malformed token
    would just match nothing)."""
    out: list[str] = []
    for value in (raw if isinstance(raw, list) else [])[:6]:
        host = str(value or "").strip().lower()
        host = re.sub(r"^[a-z][a-z0-9+.-]*://", "", host)
        host = host.split("/", 1)[0].split(":", 1)[0]
        if host and "." in host and len(host) <= 100 and host not in out:
            out.append(host)
        if len(out) >= 3:
            break
    return out


def parse_call(call: dict[str, t.Any]) -> tuple[str, str, str, list[str], list[str]]:
    """(query, category, time_range, included_sites, excluded_sites) of one
    tool call -- sanitized: a LEADING group of engine bangs (e.g. "!baidu")
    survives because the model may only use one when the user explicitly
    names the engine; every other "!" is noise, whitespace collapses, the
    category and the freshness window are whitelist-checked and the site
    filters are host-shaped bare domains."""
    try:
        args = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    query = str(args.get("query") or "")
    bang_match = _BANG_PREFIX_RE.match(query)
    bang = ""
    if bang_match and bang_match.group(0).strip():
        bang = " ".join(token.lower() for token in bang_match.group(0).split())
        query = query[bang_match.end() :]
    query = query.replace("!", "")
    query = " ".join((bang + " " + query).split())[:200]
    category = str(args.get("category") or "general").strip().lower()
    if category not in SEARCH_CATEGORIES:
        category = "general"
    time_range = str(args.get("time_range") or "").strip().lower()
    if time_range not in _TIME_RANGES:
        time_range = ""
    return (
        query,
        category,
        time_range,
        _clean_sites(args.get("included_sites")),
        _clean_sites(args.get("excluded_sites")),
    )


def parse_page_call(call: dict[str, t.Any]) -> str:
    """The url of one ``web_crawler`` tool call -- sanitized: trimmed and
    capped; the public-url guard runs in
    :py:mod:`searx.zjsearch.ai.capabilities.reader.fetch`."""
    try:
        args = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    return str(args.get("url") or "").strip()[:2000]


def _raw_args(call: dict[str, t.Any]) -> dict[str, t.Any]:
    """The model's RAW tool-call arguments as a dict -- the timeline row's
    debug expansion shows exactly what was passed (q, category, ...),
    unfiltered."""
    try:
        value = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def display_item(idx: int, call: dict[str, t.Any]) -> dict[str, t.Any]:
    """One ``calls`` wire item: the client's timeline row.  ``tool``
    discriminates the row kind -- a search renders its query, a page read
    its url.  Site filters display folded into the query so the row shows
    the operators the engine will enforce."""
    if str(call.get("name") or "") == PAGE_TOOL:
        # args rides along: the RAW tool-call arguments -- the timeline row's
        # debug expansion shows exactly what the model passed
        return {
            "id": idx,
            "tool": PAGE_TOOL,
            "url": parse_page_call(call),
            "args": _raw_args(call),
        }
    query, category, time_range, include, exclude = parse_call(call)
    operators = " ".join([f"site:{host}" for host in include] + [f"-site:{host}" for host in exclude])
    if operators:
        query = f"{query} {operators}"
    return {
        "id": idx,
        "tool": TOOL_NAME,
        "q": query,
        "category": category,
        "time_range": time_range or None,
        "args": _raw_args(call),
    }
