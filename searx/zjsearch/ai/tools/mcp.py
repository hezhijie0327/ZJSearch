# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The MCP (Model Context Protocol) capability: external tool servers over
streamable HTTP, bridged into the agent's tool surface.

Configuration (``zjsearch.mcp`` -- a LIST of single-key mappings, the
server name maps to its connection)::

    mcp:
      - amap-maps:
          url: https://mcp.amap.com/mcp?key=YOUR_KEY
      - gateway:
          url: https://example.org/mcp
          header:
            app-code: test

``url`` is the only required key; ``header`` carries whatever auth the
server wants (merged verbatim onto the streamable-HTTP request
headers).  Streamable HTTP ONLY -- stdio / SSE servers are out of
scope.  Unconfigured = the capability is silent: no specs, no sessions.

The official ``mcp`` SDK drives the wire (MIT, theme requirement
section); sessions open lazily on the SHARED network loop and stay
cached per server -- one initialized session serves every call.  Tool
names are namespaced ``mcp_<server>_<tool>`` so two servers can never
collide with each other or with the built-ins."""

import asyncio
import functools
import json
import logging
import typing as t

from searx import settings
from searx.network.client import get_loop

logger = logging.getLogger(__name__)

_SESSION_TIMEOUT = 15.0
_CALL_TIMEOUT = 90.0
"""Connect/initialize and per-call budgets -- an MCP server that cannot
answer inside these is a dead end for the run (the model is told the
call failed)."""

MAX_SERVERS = 6
"""Session cap -- each open MCP server holds a connection; a runaway
config must not hold dozens."""

_sessions: dict[str, t.Any] = {}
"""server name -> (ClientSession, asyncio.ExitStack) on the shared loop."""


def mcp_cfg() -> list[tuple[str, str, dict[str, str]]]:
    """The parsed ``zjsearch.mcp`` block: (name, url, headers) triples.
    Read defensively -- a misshapen entry is skipped with a warning, and
    the list is capped at MAX_SERVERS."""
    block = settings.get("zjsearch", {}).get("mcp")
    entries = block if isinstance(block, list) else []
    out: list[tuple[str, str, dict[str, str]]] = []
    for entry in entries:
        if not isinstance(entry, dict) or not entry:
            continue
        name, conn = next(iter(entry.items()))
        if not isinstance(conn, dict) or not str(conn.get("url") or "").strip():
            logger.warning("zjsearch_mcp: skipping a misshapen entry (%r)", name)
            continue
        headers = conn.get("header")
        header_map = {str(k): str(v) for k, v in headers.items()} if isinstance(headers, dict) else {}
        out.append((str(name)[:60], str(conn["url"]).strip(), header_map))
        if len(out) >= MAX_SERVERS:
            break
    return out


def configured() -> bool:
    """True when at least one MCP server is declared -- the install gate."""
    return len(mcp_cfg()) > 0


def _sdk():
    """The official SDK, imported lazily (an absent package = the
    capability degrades to silence, like the reader's converter)."""
    try:
        from mcp import ClientSession  # pylint: disable=import-outside-toplevel
        from mcp.client.streamable_http import (  # pylint: disable=import-outside-toplevel
            create_mcp_http_client,
            streamable_http_client,
        )
    except ImportError:
        return None
    return ClientSession, streamable_http_client, create_mcp_http_client


def sdk_missing() -> str | None:
    """The missing package name for the install gate, or None."""
    return "mcp" if _sdk() is None else None


async def _with_session(name: str, action: t.Callable[[t.Any], t.Any]) -> t.Any:
    """Run ``action(initialized_session)`` inside ONE self-contained
    connection (open -> initialize -> act -> close, a single loop task).
    Sessions are deliberately NOT cached across calls: the SDK's anyio
    task groups cannot survive the next run_coroutine_threadsafe's
    different task (the cancel-scope-affinity error), and streamable
    HTTP reconnects are two cheap round trips.  The configured headers
    ride a dedicated http client (the SDK's factory applies them over
    its own defaults)."""
    sdk = _sdk()
    if sdk is None:
        raise RuntimeError("the 'mcp' package is not installed")
    ClientSession, streamable_http_client, create_mcp_http_client = sdk
    _, url, headers = next((srv for srv in mcp_cfg() if srv[0] == name), (None, None, None))
    if not url:
        raise RuntimeError(f"unknown MCP server: {name!r}")  # noqa: F841 -- url IS used below

    async def run() -> t.Any:
        async with create_mcp_http_client(headers=headers or None) as http_client:
            async with streamable_http_client(url, http_client=http_client) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    return await action(session)

    return await asyncio.wait_for(run(), _CALL_TIMEOUT)


def _server_of(name: str) -> tuple[str, str, dict[str, str]] | None:
    """The connection config of a namespaced tool's server."""
    prefix = "mcp_"
    if not name.startswith(prefix):
        return None
    rest = name[len(prefix) :]
    for server, url, headers in mcp_cfg():
        if rest == server or rest.startswith(f"{server}_"):
            return server, url, headers
    return None


async def list_tools() -> list[dict[str, t.Any]]:
    """Every configured server's tools as llm-shape specs, namespaced
    ``mcp_<server>_<tool>``.  A server that fails to answer logs a
    warning and contributes nothing (one dead endpoint must not take the
    run down)."""
    specs: list[dict[str, t.Any]] = []
    for name, _, _ in mcp_cfg():
        try:
            response = await _with_session(name, lambda session: session.list_tools())
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_mcp: listing %r failed: %s", name, exc)
            continue
        for tool in response.tools or []:
            tool_name = str(tool.name or "")[:60]
            if not tool_name:
                continue
            raw_schema = getattr(tool, "input_schema", None) or getattr(tool, "inputSchema", None)
            schema: dict[str, t.Any] = {}
            if raw_schema and isinstance(raw_schema, dict):
                schema = {
                    "type": "object",
                    "properties": raw_schema.get("properties") or {},
                    "required": raw_schema.get("required") or [],
                }
            specs.append(
                {
                    "name": f"mcp_{name}_{tool_name}",
                    "description": str(tool.description or f"{tool_name} (MCP: {name})")[:800],
                    "parameters": schema,
                }
            )
    return specs


async def call_tool(name: str, arguments: dict[str, t.Any]) -> str:
    """One namespaced tool call -> the server's text content.  Errors come
    back as readable messages (the model fixes or drops the call)."""
    resolved = _server_of(name)
    if resolved is None:
        return f"error: unknown MCP tool {name!r}"
    server, _, _ = resolved
    tool = name[len("mcp_") + len(server) + 1 :]
    try:
        response = await _with_session(server, lambda session: session.call_tool(tool, arguments=arguments))
    except asyncio.TimeoutError:
        return f"error: the MCP server {server!r} did not answer in time"
    except Exception as exc:  # pylint: disable=broad-except
        return f"error: the MCP call failed: {exc}"
    parts = list(response.content or [])
    texts = [part.text for part in parts if getattr(part, "type", "") == "text" and part.text]
    if not texts:
        return "(the tool returned no text content)"
    joined = "\n".join(texts)
    return joined[:20000]


@functools.lru_cache(maxsize=1)
def _specs_future() -> t.Any:
    """The specs list, computed ONCE on the shared loop per process (the
    tool surface of an MCP server does not change mid-run)."""
    return asyncio.run_coroutine_threadsafe(list_tools(), get_loop())


PROGRESSIVE_THRESHOLD = 8
"""The tool count past which the MCP surface switches to PROGRESSIVE
DISCLOSURE (the Agent Skills injection pattern): instead of every
server tool's full schema riding each run's context -- fifteen amap
schemas would burn thousands of tokens on a question about the news --
the model sees ONE discovery tool, searches it by keyword, and receives
the matched tools' complete schemas for calling.  Below the threshold
the tools inject directly (the discovery round trip costs more than the
schemas)."""

SEARCH_TOOL = "mcp_search_tools"


def discovery_spec(count: int, servers: list[str]) -> dict[str, t.Any]:
    """The progressive-disclosure discovery tool: the model's ONLY
    visible MCP surface until it searches; the result carries the
    matched tools' complete schemas so the next turn can call them
    directly."""
    return {
        "name": SEARCH_TOOL,
        "description": (
            "Search the connected MCP servers' tools by keyword (matches"
            " tool names and descriptions; the connected servers are:"
            f" {', '.join(servers)} -- {count} tools in total).  Returns"
            " each matching tool's NAME and FULL parameter schema -- call"
            " the tool by its returned name afterwards.  Try a few broad"
            " keywords (route, search, weather, geo...) when the first"
            " search matches nothing."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Space-separated keywords for what you want to do"
                        ' (e.g. "route driving distance", "weather forecast").'
                    ),
                },
            },
            "required": ["query"],
        },
    }


def search_mcp_tools(query: str, limit: int = 6) -> str:
    """The discovery tool's execution: keyword-score every spec (name,
    description, property names), return the top matches WITH their full
    parameter schemas -- the model can call them on its next turn without
    a second lookup."""
    specs = mcp_specs()
    terms = [term for term in query.lower().replace("，", " ").split() if term]
    if not terms:
        return "error: empty query"
    scored: list[tuple[float, dict[str, t.Any]]] = []
    for spec in specs:
        haystack = spec["name"].lower() + " " + spec["description"].lower()
        for prop in (spec.get("parameters") or {}).get("properties", {}):
            haystack += " " + str(prop).lower()
        score = sum(2.0 if term in spec["name"].lower() else 1.0 if term in haystack else 0.0 for term in terms)
        if score > 0:
            scored.append((score, spec))
    scored.sort(key=lambda pair: -pair[0])
    if not scored:
        servers = ", ".join(server for server, _, _ in mcp_cfg())
        return (
            f"no MCP tool matches {query!r}.  The connected servers"
            f" ({servers}) expose: " + ", ".join(spec["name"] for spec in specs[:40]) + " -- try different keywords."
        )
    matches = [
        {"name": spec["name"], "description": spec["description"], "parameters": spec.get("parameters") or {}}
        for _, spec in scored[:limit]
    ]
    return (
        json.dumps(matches, ensure_ascii=False) + "\n\nCall a matched tool by its exact name (the mcp_... string above)"
        " with arguments following its parameter schema."
    )


def mcp_specs() -> list[dict[str, t.Any]]:
    """The namespaced tool specs (blocking; the first call pays the
    handshakes, later calls hit the memoized future)."""
    if not configured() or _sdk() is None:
        return []
    try:
        return _specs_future().result(_SESSION_TIMEOUT * MAX_SERVERS)
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_mcp: tool discovery failed: %s", exc)
        return []


def tools_surface() -> list[dict[str, t.Any]]:
    """What the RUN registers: every namespaced spec when they fit the
    context, or -- past the threshold -- just the progressive-discovery
    tool (the Agent Skills pattern: metadata first, full schemas on
    demand)."""
    specs = mcp_specs()
    if not specs:
        return []
    if len(specs) <= PROGRESSIVE_THRESHOLD:
        return specs
    return [discovery_spec(len(specs), [server for server, _, _ in mcp_cfg()])]


def call_mcp_tool_sync(name: str, arguments: dict[str, t.Any]) -> str:
    """The executor's entry: one tool call, blocking the WSGI thread on
    the shared loop's result."""
    try:
        return asyncio.run_coroutine_threadsafe(call_tool(name, arguments), get_loop()).result(_CALL_TIMEOUT)
    except Exception as exc:  # pylint: disable=broad-except
        return f"error: the MCP call failed: {exc}"
