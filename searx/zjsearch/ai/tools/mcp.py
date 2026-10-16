# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The MCP (Model Context Protocol) BRIDGE: external tool servers over
streamable HTTP, wired into the agent's tool surface.  This module is
the bridge only -- config, sessions, the namespaced specs and the
call path; the ``search_tools`` discovery instrument that indexes these
specs (beside the run's own disclosed tools) lives in
:py:mod:`searx.zjsearch.ai.tools.search_tools`.

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
section); each operation runs inside ONE self-contained connection
(open -> initialize -> act -> close) on the shared network loop -- the
SDK's anyio task groups cannot survive the next ``run_coroutine_threadsafe``
task, so sessions are deliberately NOT cached across calls.  Tool
names are namespaced ``mcp_<server>_<tool>`` so two servers can never
collide with each other or with the built-ins."""

import asyncio
import functools
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
"""The config-entry cap -- a runaway ``zjsearch.mcp`` list must not
hand the model dozens of servers."""


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


async def _with_session(name: str, action: t.Callable[[t.Any, t.Any], t.Any]) -> t.Any:
    """Run ``action(initialized_session, initialize_result)`` inside ONE
    self-contained connection (open -> initialize -> act -> close, a
    single loop task).  Sessions are deliberately NOT cached across
    calls: the SDK's anyio task groups cannot survive the next
    run_coroutine_threadsafe's different task (the cancel-scope-affinity
    error), and streamable HTTP reconnects are two cheap round trips.
    The initialize result rides along so the specs pass can capture the
    server's ``instructions`` in the SAME handshake (zero extra round
    trips).  The configured headers ride a dedicated http client (the
    SDK's factory applies them over its own defaults)."""
    sdk = _sdk()
    if sdk is None:
        raise RuntimeError("the 'mcp' package is not installed")
    ClientSession, streamable_http_client, create_mcp_http_client = sdk
    _, url, headers = next((srv for srv in mcp_cfg() if srv[0] == name), (None, None, None))
    if not url:
        raise RuntimeError(f"unknown MCP server: {name!r}")

    async def run() -> t.Any:
        async with create_mcp_http_client(headers=headers or None) as http_client:
            async with streamable_http_client(url, http_client=http_client) as (read, write):
                async with ClientSession(read, write) as session:
                    init = await session.initialize()
                    return await action(session, init)

    return await asyncio.wait_for(run(), _CALL_TIMEOUT)


def server_of(name: str) -> tuple[str, str, dict[str, str]] | None:
    """The server a namespaced ``mcp_<server>_<tool>`` call belongs to
    (public for the discovery tool, which labels its MCP rows)."""
    return _server_of(name)


def _server_of(name: str) -> tuple[str, str, dict[str, str]] | None:
    """The connection config of a namespaced tool's server.  LONGEST
    server name first: ``amap`` must never shadow ``amap_pro`` -- with
    the prefix-match shape the shorter name would swallow the longer
    one's tools whenever both are configured."""
    prefix = "mcp_"
    if not name.startswith(prefix):
        return None
    rest = name[len(prefix) :]
    for server, url, headers in sorted(mcp_cfg(), key=lambda srv: len(srv[0]), reverse=True):
        if rest == server or rest.startswith(f"{server}_"):
            return server, url, headers
    return None


def tool_of(namespaced: str) -> str | None:
    """The upstream tool name out of a namespaced one
    (``mcp_<server>_<tool>`` -> ``<tool>``), via the same resolution the
    call path uses -- the row renderer's replacement for blind string
    splits (a server name carrying an underscore broke those)."""
    resolved = _server_of(namespaced)
    if resolved is None:
        return None
    server = resolved[0]
    return namespaced[len("mcp_") + len(server) + 1 :]


_INSTRUCTIONS_CAP = 400
"""One server's ``instructions`` budget -- the servers' own usage guidance
is advisory context, not a second system prompt."""

_instructions: dict[str, str] = {}
"""The per-server ``instructions`` captured during the specs pass (the
same memoized handshake that lists the tools -- zero extra round
trips).  Advisory: a server without instructions simply contributes
nothing here."""


async def list_tools() -> list[dict[str, t.Any]]:
    """Every configured server's tools as llm-shape specs, namespaced
    ``mcp_<server>_<tool>``.  A server that fails to answer logs a
    warning and contributes nothing (one dead endpoint must not take the
    run down).  The initialize result's ``instructions`` land in
    :data:`_instructions` on the same pass."""
    specs: list[dict[str, t.Any]] = []
    for name, _, _ in mcp_cfg():
        try:

            def _list(session: t.Any, init: t.Any) -> t.Any:
                text = str(getattr(init, "instructions", "") or "").strip()
                if text:
                    _instructions[name] = text[:_INSTRUCTIONS_CAP]
                return session.list_tools()

            response = await _with_session(name, _list)
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
            # the server's own hints (readOnlyHint & co) ride along -- the
            # neutral spec is MCP-shaped, so they pass through untouched
            annotations: dict[str, t.Any] = {}
            raw_annotations = getattr(tool, "annotations", None)
            if raw_annotations is not None:
                try:
                    annotations = raw_annotations.model_dump(exclude_none=True)
                except AttributeError:
                    annotations = {}
            spec: dict[str, t.Any] = {
                "name": f"mcp_{name}_{tool_name}",
                "description": str(tool.description or f"{tool_name} (MCP: {name})")[:800],
                "inputSchema": schema,
            }
            if annotations:
                spec["annotations"] = annotations
            specs.append(spec)
    return specs


def server_instructions() -> dict[str, str]:
    """The per-server ``instructions`` (blocking like :func:`mcp_specs` --
    the capture rides the same memoized specs future).  A failed
    discovery returns whatever the healthy servers offered (fail-open:
    the instructions are advisory context, never a gate)."""
    if not configured() or _sdk() is None:
        return {}
    mcp_specs()
    return dict(_instructions)


async def call_tool(name: str, arguments: dict[str, t.Any]) -> str:
    """One namespaced tool call -> the server's text content.  Errors come
    back as readable messages (the model fixes or drops the call)."""
    resolved = _server_of(name)
    if resolved is None:
        return f"error: unknown MCP tool {name!r}"
    server, _, _ = resolved
    tool = name[len("mcp_") + len(server) + 1 :]
    try:
        response = await _with_session(server, lambda session, _init: session.call_tool(tool, arguments=arguments))
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


def mcp_specs() -> list[dict[str, t.Any]]:
    """The namespaced tool specs (blocking; the first call pays the
    handshakes, later calls hit the memoized future).  A FAILED
    discovery clears the memo -- one network blip at first use must not
    empty the MCP surface until process restart; the next run retries."""
    if not configured() or _sdk() is None:
        return []
    try:
        return _specs_future().result(_SESSION_TIMEOUT * MAX_SERVERS)
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_mcp: tool discovery failed: %s", exc)
        _specs_future.cache_clear()
        return []


def call_mcp_tool_sync(name: str, arguments: dict[str, t.Any]) -> str:
    """The executor's entry: one tool call, blocking the WSGI thread on
    the shared loop's result."""
    try:
        return asyncio.run_coroutine_threadsafe(call_tool(name, arguments), get_loop()).result(_CALL_TIMEOUT)
    except Exception as exc:  # pylint: disable=broad-except
        return f"error: the MCP call failed: {exc}"
