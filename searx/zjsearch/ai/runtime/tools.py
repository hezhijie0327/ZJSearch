# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the tool specs and their argument parsing.

Each entry the model sees (``web_search``, ``web_reader``,
``ask_user``, ``task_write``) is one spec function in the
dialect-neutral llm shape plus the sanitizers that turn untrusted call
arguments into executed / displayed values (Vane's researcher/actions
split, Morphic's lib/tools -- schema, description and parsing live with
the tool).
"""

import json
import re
import typing as t

from searx.zjsearch.ai.capabilities import mcp

TOOL_NAME = "web_search"

PAGE_TOOL = "web_reader"

ASK_TOOL = "ask_user"

CALCULATOR_TOOL_NAME = "calculator"

USER_MEMORY_TOOL = "user_memory"

TASK_TOOL = "task_write"

PAST_RESEARCH_TOOL = "past_research"

SEARCH_CATEGORIES = ("general", "news", "images", "videos", "it", "science", "files", "music")
"""The verticals the model may pick; each has a dedicated client layout."""

_BANG_PREFIX_RE = re.compile(r"^(?:\s*![a-z0-9_-]+)*(?:\s+|$)", re.IGNORECASE)
_TIME_RANGES = ("day", "week", "month", "year")


def tool_spec(with_pages: bool) -> dict[str, t.Any]:
    """The ``web_search`` tool in the dialect-neutral llm shape; with the
    page reader configured, the description cross-references it (a model
    that never sees ``web_reader`` must not be told about it).  The
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


def ask_user_spec() -> dict[str, t.Any]:
    """The mid-research human-in-the-loop tool: the model may stop and ask
    instead of guessing -- when the request is genuinely ambiguous, when
    the user's success criteria are unstated, or when the answer's stakes
    make a wrong assumption expensive (forecasts, recommendations with
    money/health/legal consequences).  The run ends with the questions;
    the answers travel back as ``clarifications``.  The wire shape here
    mirrors ``gates.sanitize_questions`` EXACTLY (single/multi + 2-4
    options; every question carries the client's free-text line) -- a
    type the sanitizer would downgrade must not be advertised."""
    return {
        "name": ASK_TOOL,
        "description": (
            "Stop researching and ask the user for direction.  Do NOT plow"
            " ahead on a guess: call this ONCE, as the ONLY call of its"
            " turn, the moment you realize that -- whatever the research"
            " returns -- the answer could miss what the user actually"
            " wants.  Triggers: a genuinely ambiguous subject (an acronym,"
            " code or short name matching several unrelated products); a"
            " scope, target or success criterion only the user can state;"
            " a high-stakes deliverable (a forecast, an investment,"
            " purchase, health or legal question) whose assumptions would"
            " change the answer.  Asking one sharp question beats a full"
            " run on the wrong premise.  Do NOT use it for broad"
            " informational topics (cover their facets instead), for"
            " details live sources can settle, or after the user already"
            " confirmed a direction."
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
                                "description": (
                                    "single = pick one option; multi = pick any."
                                    "  The user can always add free text on"
                                    " every question -- a yes/no question is a"
                                    ' single with options ["Yes", "No"].'
                                ),
                            },
                            "options": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "2-4 short concrete answers to choose from.",
                            },
                        },
                        "required": ["q", "type"],
                    },
                    "description": "At most 3 questions.",
                },
            },
            "required": ["questions"],
        },
    }


def task_write_spec() -> dict[str, t.Any]:
    """The living task list (quality/goal): the model decomposes the
    request into subtasks and keeps their statuses current -- the client
    renders the list as the task card, and the list drives what gets
    delegated next."""
    return {
        "name": TASK_TOOL,
        "description": (
            "Create or update the SUBTASK LIST for this research.  First"
            " round: decompose the request into 2-4 concrete, independent"
            " subtasks (each answerable by its own focused research)."
            " Afterwards: update statuses as subtasks complete"
            ' ({"title": ..., "status": "done"}).  The list is rendered'
            " to the user as your research plan -- keep it current."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {
                                "type": "string",
                                "description": "The subtask, one concrete research question/topic.",
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "active", "done"],
                                "description": "pending = not started; active = researching; done = gathered.",
                            },
                        },
                        "required": ["title", "status"],
                    },
                    "description": "The COMPLETE list (2-4 items) -- not a diff.",
                },
            },
            "required": ["items"],
        },
    }


def parse_task_call(call: dict[str, t.Any]) -> list[dict[str, str]]:
    """The sanitized task list out of a ``task_write`` call."""
    args = _raw_args(call)
    items = args.get("items")
    out: list[dict[str, str]] = []
    for item in (items if isinstance(items, list) else [])[:6]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:200]
        status = str(item.get("status") or "pending").strip().lower()
        if not title:
            continue
        out.append({"title": title, "status": status if status in ("pending", "active", "done") else "pending"})
    return out


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
    """The url of one ``web_reader`` tool call -- sanitized: trimmed and
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


def display_item(  # pylint: disable=too-many-return-statements, too-many-branches
    idx: int, call: dict[str, t.Any]
) -> dict[str, t.Any]:
    """One ``calls`` wire item: the client's timeline row.  ``tool``
    discriminates the row kind -- a search renders its query, a page read
    its url.  Site filters display folded into the query so the row shows
    the operators the engine will enforce."""
    call_name = str(call.get("name") or "")
    if call_name == TASK_TOOL:
        items = parse_task_call(call)
        return {
            "id": idx,
            "tool": TASK_TOOL,
            "q": f"{sum(1 for i in items if i.get('status') == 'done')}/{len(items)}",
            "args": _raw_args(call),
        }
    if call_name == ASK_TOOL:
        # the human-in-the-loop ask: the row's label is the question's
        # intro (falling back to the first question's text) -- the raw
        # arguments ride along like every other row's debug pane
        try:
            ask_args = _raw_args(call)
        except Exception:  # pylint: disable=broad-except
            ask_args = {}
        questions = ask_args.get("questions")
        first = ""
        if isinstance(questions, list) and questions and isinstance(questions[0], dict):
            first = str(questions[0].get("q") or "").strip()[:120]
        return {
            "id": idx,
            "tool": ASK_TOOL,
            "q": str(ask_args.get("intro") or "").strip()[:120] or first,
            "args": ask_args,
        }
    if call_name == PAST_RESEARCH_TOOL:
        try:
            memory_args = _raw_args(call)
        except Exception:  # pylint: disable=broad-except
            memory_args = {}
        return {
            "id": idx,
            "tool": PAST_RESEARCH_TOOL,
            "q": str(memory_args.get("query") or "")[:120],
            "args": memory_args,
        }
    if call_name == USER_MEMORY_TOOL:
        try:
            memory_args = _raw_args(call)
        except Exception:  # pylint: disable=broad-except
            memory_args = {}
        action = str(memory_args.get("action") or "search")
        return {
            "id": idx,
            "tool": USER_MEMORY_TOOL,
            "name": action,
            "q": str(memory_args.get("query") or memory_args.get("content") or "")[:120],
            "args": memory_args,
        }
    if call_name == mcp.SEARCH_TOOL:
        # progressive disclosure's discovery call: the row shows the
        # KEYWORD the model searched the tool inventory for (a bare
        # "tools" label reads as noise)
        try:
            search_args = _raw_args(call)
        except Exception:  # pylint: disable=broad-except
            search_args = {}
        return {
            "id": idx,
            "tool": "mcp",
            "name": "search_tools",
            "q": str(search_args.get("query") or "")[:120],
            "args": search_args,
        }
    if call_name.startswith("mcp_"):
        # an MCP bridge call: the row shows the server-scoped tool name
        # (everything after the mcp_<server> prefix); the raw args ride
        # along like every other row's debug pane
        return {
            "id": idx,
            "tool": "mcp",
            "name": call_name.split("_", 2)[-1] if call_name.count("_") >= 2 else call_name,
            "args": _raw_args(call),
        }
    if str(call.get("name") or "") == CALCULATOR_TOOL_NAME:
        try:
            calc_args = _raw_args(call)
        except Exception:  # pylint: disable=broad-except
            calc_args = {}
        expression = str(calc_args.get("expression") or "")[:500]
        try:
            precision = max(0, min(int(calc_args.get("precision")), 12))
        except (TypeError, ValueError):
            precision = 10
        return {
            "id": idx,
            "tool": CALCULATOR_TOOL_NAME,
            # the expression IS the row's label (the result rides the right
            # side as "= x") -- the client renders `expr = result`
            "q": expression,
            "expression": expression,
            "precision": precision if precision != 10 else None,
            "args": _raw_args(call),
        }
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
