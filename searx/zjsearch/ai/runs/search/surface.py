# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The run's TOOL SURFACE: one pure function assembling everything the
model sees.

The route hands in the run's AVAILABILITY FLAGS (mode, depth rung,
browser/decision/recall readiness, whether images or an outline ride
the request) and gets back the registered specs, the ``toolset``
frozenset the researcher prompt derives its blocks from, and the
INSTRUCTIONS notes in registration order -- one source of truth, so
the prompt can never promise a tool the model does not have and the
notes stay byte-stable per toolset (the prefix cache survives).

THE DISCLOSURE SPLIT is frequency-based.  Everything the model may
need EVERY round stays inline; the long tail is the EXTERNAL one -- the
MCP servers' tools, discoverable through the ``search_tools`` keyword
index (``tools/search_tools``).  The internal niche tools do NOT ride
the index: the set is small, bounded and deployment-independent, and a
prefix-cached inline spec costs a fraction of the discovery round trip
every run would otherwise pay -- so on the research tiers they register
inline beside the core instruments (speed keeps its AI-Overview
minimal set).  ``search_tools`` itself registers only when the index
has something to hold, and the no-research / AI-Overview surfaces
register no research machinery at all.
"""

import typing as t

from searx.zjsearch.ai.tools import (
    TOOL_INSTRUCTIONS,
    ask_user_spec,
    build_table_spec,
    calculate_spec,
    delegate_research_spec,
    evaluate_spec,
    inspect_image_spec,
    list_engines_spec,
    memory_spec,
    message_subtask_spec,
    recall_history_spec,
    record_findings_spec,
    search_web_spec,
    update_plan_spec,
)
from searx.zjsearch.ai.tools import browse as browse_tool
from searx.zjsearch.ai.tools import search_tools


class ToolSurface(t.NamedTuple):
    """The assembled surface: the registered specs, the prompt's
    ``toolset`` view of them, and the per-tool INSTRUCTIONS entries in
    registration order."""

    specs: list[dict[str, t.Any]]
    toolset: frozenset[str]
    tool_notes: list[tuple[str, str]]


def build_tool_surface(
    mode: str,
    depth_rung: int = 0,
    browser_on: bool = False,
    judge_on: bool = False,
    recall_on: bool = False,
    has_images: bool = False,
    has_outline: bool = False,
) -> ToolSurface:
    """Assemble the run's tool surface.  ``mode`` is one of
    ``runs.profile.SEARCH_MODES``; ``depth_rung`` is the depth probe's
    grade (the delegation tools are the HEAVY deep question's -- rung
    >= 2 mints them); the ``*_on`` flags are the run's availability
    gates (the browser engine, the decision model, a live recall);
    ``has_images``/``has_outline`` reflect the request's attachments
    and the report/deck outline.  PURE: no settings reads -- the MCP
    servers' specs (the discovery index's content) are process state
    consulted through :py:func:`search_tools.tools_surface`."""
    research_tier = mode in ("balanced", "deep")
    delegating = mode == "deep" and depth_rung >= 2
    specs: list[dict[str, t.Any]] = [
        # with_info: the desc's list_engines pointer is accurate when the
        # inventory exists (inline) -- Search has neither
        search_web_spec(browser_on, with_info=research_tier),
        calculate_spec(),
        memory_spec(),
    ]
    if research_tier:
        # the research machinery: ledger, the deployment inventory, the
        # structured tie-break and the history recall -- inline, not
        # discovered: the index round trip is a per-run tax the small
        # bounded internal set must not pay
        specs.append(record_findings_spec())
        specs.append(list_engines_spec())
        if judge_on:
            specs.append(evaluate_spec())
        if recall_on:
            specs.append(recall_history_spec())
    if research_tier or has_images:
        # the eyes on images: research runs may always meet a chart in a
        # source line; Search only carries the tool when the REQUEST
        # itself brought pictures
        specs.append(inspect_image_spec())
    if browser_on:
        specs.append(browse_tool.browse_spec())
    specs.append(ask_user_spec())
    if research_tier:
        specs.append(update_plan_spec())
    if has_outline:
        specs.append(build_table_spec())
    if delegating:
        specs += [
            delegate_research_spec(),
            # the subagents' follow-up channel: only meaningful beside
            # the delegation tool (the same depth gate mints both)
            message_subtask_spec(),
        ]
    specs += search_tools.tools_surface()
    return ToolSurface(
        specs=specs,
        toolset=frozenset(str(spec["name"]) for spec in specs),
        tool_notes=[
            (str(spec["name"]), TOOL_INSTRUCTIONS[str(spec["name"])])
            for spec in specs
            if str(spec["name"]) in TOOL_INSTRUCTIONS
        ],
    )
