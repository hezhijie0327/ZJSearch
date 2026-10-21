# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``search_tools`` tool -- the progressive-disclosure DISCOVERY
instrument (the Agent Skills injection pattern).

ONE keyword-searchable index over the EXTERNAL long tail: the connected
MCP servers' tools (:py:mod:`searx.zjsearch.ai.tools.mcp` -- that
module is the bridge only).  The model sees ONE search box, earns the
matched tools' COMPLETE schemas on a keyword match, and calls them by
name next turn; a row carries the server's instructions beside the
schema, so doctrine arrives exactly when the schema does.  A miss
returns the servers' directory for re-querying -- and, when the
deployment configured embeddings, falls back to ONE semantic pass: the
query and the specs ride a single bounded ``run_batch`` (the service's
own LRU keeps the spec vectors free after the first miss) and the
closest matches above the cosine floor are returned with an honest
"matched by meaning" note (any failure fails OPEN to the plain
directory).  The every-round instruments stay inline: the discovery
round trip is a tax only the rarely-needed tools should pay.  (The
old wire name ``search_mcp_tools`` died when the index went general;
the internal niche tools -- once the index's second half -- moved back
inline: a small bounded set must not pay a per-run discovery tax.)
``internal_specs`` survives as the plumbing for a future true long
tail; every caller passes nothing today."""

import json
import typing as t

from searx.zjsearch.ai.tools.mcp import mcp_cfg, mcp_specs, server_instructions, server_of

DISCOVERY_TOOL = "search_tools"
"""The wire name -- the model's ONLY visible surface for the long tail."""

_SEMANTIC_FLOOR = 0.4
"""The cosine floor a semantic fallback match must clear (keyword
scoring found nothing; below this the "match" is noise)."""

_SEMANTIC_TIMEOUT = 4.0
"""The embedding pass's budget -- a slow gateway must not turn the
discovery call into a stall (the hung-rerank lesson)."""


def discovery_spec(mcp_count: int, mcp_servers: list[str], internal_names: list[str] | None = None) -> dict[str, t.Any]:
    """The discovery tool's spec: the model's ONLY visible surface for
    the long tail until it searches.  The description names what the
    index covers so the model knows what a miss does NOT cover (the
    core inline instruments)."""
    coverage: list[str] = []
    if internal_names:
        coverage.append("this deployment's own niche tools (" + ", ".join(internal_names) + ")")
    if mcp_count:
        coverage.append(f"the connected MCP servers' tools ({', '.join(mcp_servers)} -- {mcp_count} in total)")
    return {
        "name": DISCOVERY_TOOL,
        "description": (
            "Search the TOOL INVENTORY by keyword (matches tool names and"
            " descriptions; it covers "
            + " and ".join(coverage)
            + ").  Returns each matching tool's NAME and FULL parameter"
            " schema -- call the tool by its returned name afterwards.  Try"
            " a few broad keywords (route, weather, geo, engines, evaluate,"
            " judge, past research...) when the first search matches"
            " nothing."
        ),  # dynamic coverage composition -- assembly code, not a doc blob
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Space-separated keywords for what you want to do"
                        ' (e.g. "route driving distance", "engine inventory",'
                        ' "judge candidates").'
                    ),
                },
            },
            "required": ["query"],
        },
        "annotations": {"readOnlyHint": True},
    }


def _terms(query: str) -> list[str]:
    """The query's keywords -- both comma cultures split."""
    return [term for term in query.lower().replace("，", " ").split() if term]


def _spec_score(spec: dict[str, t.Any], terms: list[str]) -> float:
    """The keyword score of one spec (name hits weigh double)."""
    haystack = spec["name"].lower() + " " + spec["description"].lower()
    for prop in (spec.get("inputSchema") or {}).get("properties", {}):
        haystack += " " + str(prop).lower()
    return sum(2.0 if term in spec["name"].lower() else 1.0 if term in haystack else 0.0 for term in terms)


def _semantic_matches(query: str, specs: list[dict[str, t.Any]]) -> list[tuple[float, dict[str, t.Any]]] | None:
    """The keyword miss's fallback: ONE bounded embedding batch over the
    query and every spec's text; the specs whose vectors clear the
    cosine floor come back best-first.  ``None`` = no embeddings
    configured or the pass failed -- the caller fails open to the plain
    directory (the hung-rerank lesson: the budget is absolute)."""
    from searx.zjsearch.ai.llm import embed  # pylint: disable=import-outside-toplevel

    if not specs or not embed.configured():
        return None
    try:
        out = embed.run_batch(
            [query] + [f"{spec['name']} {spec.get('description') or ''}" for spec in specs],
            timeout=_SEMANTIC_TIMEOUT,
        )
    except Exception:  # pylint: disable=broad-except
        return None
    if not out:
        return None
    vectors = out[0]
    scored: list[tuple[float, dict[str, t.Any]]] = []
    for spec, vector in zip(specs, vectors[1:]):
        score = embed.cosine(vectors[0], vector)
        if score >= _SEMANTIC_FLOOR:
            scored.append((score, spec))
    scored.sort(key=lambda pair: -pair[0])
    return scored


def _row(
    spec: dict[str, t.Any], score: float, known_instructions: dict[str, str]
) -> tuple[float, dict[str, t.Any], str]:
    """One matched spec's row: server attribution + the doctrine beside
    the schema (an internal spec carries its registry INSTRUCTIONS, an
    MCP spec its server's)."""
    resolved = server_of(str(spec["name"]))
    server = resolved[0] if resolved else ""
    if server:
        return score, {**spec, "server": server}, known_instructions.get(server, "")
    from searx.zjsearch.ai.tools import TOOL_INSTRUCTIONS  # pylint: disable=import-outside-toplevel

    name = str(spec["name"])
    return score, {**spec, "server": server}, TOOL_INSTRUCTIONS.get(name, "") or known_instructions.get(name, "")


def run_call(
    query: str, limit: int = 6, internal_specs: list[dict[str, t.Any]] | None = None
) -> tuple[str, dict[str, t.Any]]:
    """The discovery call's execution: keyword-score the index -- the
    external MCP servers' tools (plus the reserved ``internal_specs``
    plumbing, empty today) -- and return (model feed, settlement
    extras).  The feed carries the top matches WITH their full parameter
    schemas; an internal row carries the tool's INSTRUCTIONS doctrine
    beside its schema (an MCP row carries the server's), so doctrine
    arrives exactly when the schema does.  A keyword miss falls back to
    ONE semantic pass when embeddings are configured (``_semantic_matches``
    -- the feed says so honestly); nothing at all returns the
    directories for re-querying.  The extras carry the same matches
    STRUCTURED (``tools`` -- the timeline row's expanded body renders
    them as cards) plus ``n`` for the row's metric.  The model can call
    a match on its next turn without a second lookup."""
    terms = _terms(query)
    if not terms:
        return "error: empty query", {"query": query, "n": 0, "tools": []}
    known_instructions = server_instructions()
    pool = [*(internal_specs or []), *mcp_specs()]
    rows: list[tuple[float, dict[str, t.Any], str]] = []  # (score, spec, instructions)
    for spec in pool:
        score = _spec_score(spec, terms)
        if score > 0:
            rows.append(_row(spec, score, known_instructions))
    semantic = False
    if not rows:
        matches = _semantic_matches(query, pool)
        if matches:
            rows = [_row(spec, score, known_instructions) for score, spec in matches]
            semantic = True
    if not rows:
        return _no_match_note(query, internal_specs), {"query": query, "n": 0, "tools": []}
    rows.sort(key=lambda pair: -pair[0])
    feed_matches: list[dict[str, t.Any]] = []
    view_matches: list[dict[str, t.Any]] = []
    for _score, spec, instructions in rows[:limit]:
        wire = dict(spec)
        if instructions:
            wire["instructions"] = instructions
        feed_matches.append(wire)
        schema = spec.get("inputSchema") or {}
        view_matches.append(
            {
                "name": spec["name"],
                "server": spec.get("server") or "",
                "description": (spec.get("description") or "")[:220],
                "params": sorted(str(k) for k in (schema.get("properties") or {})),
                "required": list(schema.get("required") or []),
                "instructions": (instructions or "")[:800],
            }
        )
    feed_text = json.dumps(feed_matches, ensure_ascii=False)
    if semantic:
        feed_text = "no keyword match; closest tools by meaning:\n\n" + feed_text
    text = (
        feed_text + '\n\nCall a matched tool by its exact name (the string in "name" above)'
        " with arguments following its inputSchema."
    )
    return text, {"query": query, "n": len(view_matches), "tools": view_matches}


def _no_match_note(query: str, internal_specs: list[dict[str, t.Any]] | None) -> str:
    """The empty result: what the inventory DOES hold (a compact
    directory over both indexes), so the next keyword has a target."""
    parts = [f"no tool matches {query!r}."]
    internal = [str(spec["name"]) for spec in internal_specs or []]
    if internal:
        parts.append("This deployment's niche tools: " + ", ".join(internal) + ".")
    specs = mcp_specs()
    if specs:
        known = server_instructions()
        servers = ", ".join(
            f"{server} ({known[server][:120]})" if known.get(server) else server for server, _, _ in mcp_cfg()
        )
        parts.append(
            f"The connected MCP servers -- {servers} -- expose: "
            + ", ".join(spec["name"] for spec in specs[:40])
            + "."
        )
    parts.append("Try different keywords.")
    return "  ".join(parts)


def tools_surface(internal_specs: list[dict[str, t.Any]] | None = None) -> list[dict[str, t.Any]]:
    """What the RUN registers: ALWAYS just the progressive-disclosure
    discovery tool -- however small the surface, the model sees ONE
    search box and earns the full schemas on a keyword match.  The index
    covers the external MCP servers' tools (the internal niche tools
    ride the surface inline -- ``runs.search.surface``; the parameter
    survives for a future true long tail).  When the index has nothing
    to hold, there is nothing to disclose and the run registers no
    discovery tool at all."""
    specs = mcp_specs()
    if not specs and not internal_specs:
        return []
    return [
        discovery_spec(
            len(specs),
            [server for server, _, _ in mcp_cfg()] if specs else [],
            [str(spec["name"]) for spec in internal_specs or []],
        )
    ]
