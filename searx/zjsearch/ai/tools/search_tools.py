# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``search_tools`` tool -- the progressive-disclosure DISCOVERY
instrument (the Agent Skills injection pattern).

ONE keyword-searchable index over BOTH halves of the long tail: the
external MCP servers' tools (:py:mod:`searx.zjsearch.ai.tools.mcp` --
that module is the bridge only) and the run's own DISCLOSED niche tools
(the specs the tier left out of the inline surface -- list_engines,
evaluate, recall_history, inspect_image on the research tiers).  The
model sees ONE search box, earns the matched tools' COMPLETE schemas on
a keyword match, and calls them by name next turn; an internal row
carries the tool's ``INSTRUCTIONS`` doctrine beside its schema (an MCP
row carries the server's), so doctrine arrives exactly when the schema
does.  A miss returns both directories for re-querying.  The
every-round instruments stay inline: the discovery round trip is a tax
only the rarely-needed tools should pay.  (The old wire name
``search_mcp_tools`` died when the index went general.)"""

import json
import typing as t

from searx.zjsearch.ai.tools.mcp import mcp_cfg, mcp_specs, server_instructions, server_of

DISCOVERY_TOOL = "search_tools"
"""The wire name -- the model's ONLY visible surface for the long tail."""


def discovery_spec(mcp_count: int, mcp_servers: list[str], internal_names: list[str] | None = None) -> dict[str, t.Any]:
    """The discovery tool's spec: the model's ONLY visible surface for
    the long tail until it searches.  The description names both index
    halves so the model knows what a miss does NOT cover (the core
    inline instruments)."""
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
        ),
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


def run_call(query: str, limit: int = 6, internal_specs: list[dict[str, t.Any]] | None = None) -> str:
    """The discovery call's execution: keyword-score both indexes -- the
    external MCP servers' tools AND the run's disclosed internal long
    tail -- and return the top matches WITH their full parameter
    schemas; an internal row carries the tool's INSTRUCTIONS doctrine
    beside its schema (an MCP row carries the server's).  The model can
    call a match on its next turn without a second lookup."""
    from searx.zjsearch.ai.tools import TOOL_INSTRUCTIONS  # pylint: disable=import-outside-toplevel

    terms = _terms(query)
    if not terms:
        return "error: empty query"
    known_instructions = server_instructions()
    rows: list[tuple[float, dict[str, t.Any], str]] = []  # (score, spec, instructions)
    for spec in internal_specs or []:
        score = _spec_score(spec, terms)
        if score > 0:
            name = str(spec["name"])
            rows.append(
                (
                    score,
                    {**spec, "server": ""},
                    TOOL_INSTRUCTIONS.get(name, "") or known_instructions.get(name, ""),
                )
            )
    for spec in mcp_specs():
        score = _spec_score(spec, terms)
        if score > 0:
            resolved = server_of(str(spec["name"]))
            server = resolved[0] if resolved else ""
            rows.append((score, {**spec, "server": server}, known_instructions.get(server, "")))
    if not rows:
        return _no_match_note(query, internal_specs)
    rows.sort(key=lambda pair: -pair[0])
    matches = []
    for _score, spec, instructions in rows[:limit]:
        out = dict(spec)
        if instructions:
            out["instructions"] = instructions
        matches.append(out)
    return (
        json.dumps(matches, ensure_ascii=False)
        + '\n\nCall a matched tool by its exact name (the string in "name" above)'
        " with arguments following its inputSchema."
    )


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
    covers BOTH the external MCP servers' tools and the run's disclosed
    internal long tail.  When neither index has anything, there is
    nothing to disclose and the run registers no discovery tool at all."""
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
