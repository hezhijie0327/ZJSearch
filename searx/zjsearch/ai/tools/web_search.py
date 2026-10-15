# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``web_search`` tool -- spec and call parsing.

The researcher's primary instrument: one spec function in the
dialect-neutral llm shape (Vane's researcher/actions split, Morphic's
lib/tools -- schema, description and parsing live with the tool) plus
:py:func:`parse_call`, the sanitizer that turns untrusted call
arguments into an executed search.  The ``included_sites``/
``excluded_sites`` arguments carry the user's source preference
(Morphic's domain filters): they travel as ``site:``/``-site:``
operators appended to the query, which the engine's
advanced_search_syntax plugin enforces AUTHORITATIVELY on every result
regardless of engine support.
"""

import re
import typing as t
from searx.zjsearch.ai.core.text import raw_args

from searx.zjsearch.ai.tools.web_browser import WEB_BROWSER_TOOL

TOOL_NAME = "web_search"

SEARCH_CATEGORIES = ("general", "news", "images", "videos", "it", "science", "files", "music")
"""The fallback verticals -- used only before the instance's engine map
exists (bare imports, probes); the live enum is deployment-derived."""

_BANG_PREFIX_RE = re.compile(r"^(?:\s*![a-z0-9_-]+)*(?:\s+|$)", re.IGNORECASE)
_TIME_RANGES = ("day", "week", "month", "year")


def available_categories() -> tuple[str, ...]:
    """The deployment's REAL search verticals: every category at least one
    enabled engine serves.  Upstream's ``categories`` map also carries
    default-disabled engines -- a category only they declare can never
    answer a ``category`` search (fan-out skips them; only an explicit
    engine bang reaches them), so both the spec's enum and the call
    sanitizer read the same USABLE set.  Falls back to the static tuple
    when the engine map is empty."""
    from searx.engines import (  # pylint: disable=import-outside-toplevel
        categories as engine_categories,
        is_engine_active,
    )

    if not engine_categories or not any(engine_categories.values()):
        return SEARCH_CATEGORIES
    usable = sorted(
        name
        for name, members in engine_categories.items()
        if any(is_engine_active(engine) and not engine.disabled for engine in members)
    )
    return tuple(usable) if usable else SEARCH_CATEGORIES


def tool_spec(with_browser: bool = False, with_info: bool = False) -> dict[str, t.Any]:
    """The ``web_search`` tool in the dialect-neutral llm shape; with the
    browser / engine_info tools registered by the caller, the description
    cross-references them (a model that never sees a tool must not be
    told about it).  The ``category`` enum is the deployment's real
    verticals (:py:func:`available_categories`).  The
    ``included_sites``/``excluded_sites`` parameters carry the user's
    source preference (Morphic's domain filters): they are appended to
    the query as ``site:``/``-site:`` operators, which the engine's
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
            " filter before concluding. Results are pre-ranked for relevance to"
            " your query and near-duplicate syndications of already-seen stories"
            " are suppressed -- trust the top of the list, and few results usually"
            " means the topic is exhausted, not that your keywords were bad. Never"
            " use bangs unless the user explicitly names an engine OR you know"
            " this deployment keeps a fitting engine disabled (then prefix the"
            ' query with its bang, e.g. "!bocha keywords") -- a category search'
            " already fans out across every enabled engine in that vertical."
            + (
                "  The engine_info tool lists this deployment's engines --"
                " the categories, and the disabled ones with the bang that"
                " reaches each; consult it when unsure which vertical fits"
                " or when searches keep coming back thin."
                if with_info
                else ""
            )
            + " Results arrive as globally numbered [n]"
            " sources to cite in the final answer.  Instant answers: a query"
            ' of exactly "$SYMBOL" (e.g. "$AAPL") or ending in " stock" /'
            ' " quote" (e.g. "AAPL stock") triggers the stock-quote plugin --'
            " the live quote rides the results as a Direct answer. Prefer it"
            " for ticker questions (finance pages are often JS-walled or"
            " stale)."
            + (
                "  Snippets are heads: when a result promises the exact"
                f" missing detail, the {WEB_BROWSER_TOOL} tool's read reads"
                " that page in full; when the engines are bot-walled /"
                " captcha'd / all-empty, the same tool is a real interactive"
                " browser -- open and drive sites with it directly."
                if with_browser
                else ""
            )
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The keyword query to search for."},
                "category": {
                    "type": "string",
                    "enum": list(available_categories()),
                    "description": (
                        "Optional vertical -- the enum is exactly what this"
                        " deployment serves (every listed category has"
                        " enabled engines; each has its own client layout:"
                        " images render as a masonry, videos as a grid);"
                        " general when unsure."
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
                        ' "search reddit", "search only GitHub" ->'
                        ' ["github.com"];'
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
                "refresh": {
                    "type": "boolean",
                    "description": (
                        "Set true ONLY to deliberately re-run a query this"
                        " run already executed -- the material may have"
                        " changed (a live score, a just-published release,"
                        " a page the user says updated).  The"
                        " duplicate-query refusal is bypassed; pages"
                        " already among your sources still keep their [n]"
                        " numbers.  Never use it to paper over a thin"
                        " result -- vary the query instead."
                    ),
                },
            },
            "required": ["query"],
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
    args = raw_args(call)
    query = str(args.get("query") or "")
    bang_match = _BANG_PREFIX_RE.match(query)
    bang = ""
    if bang_match and bang_match.group(0).strip():
        bang = " ".join(token.lower() for token in bang_match.group(0).split())
        query = query[bang_match.end() :]
    query = query.replace("!", "")
    query = " ".join((bang + " " + query).split())[:200]
    category = str(args.get("category") or "general").strip().lower()
    if category not in available_categories():
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
