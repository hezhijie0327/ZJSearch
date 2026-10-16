# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``delegate_research`` tool: one subagent per delegation -- a
nested research loop with its OWN context window.

The delegation contract is the four-field shape Anthropic's multi-agent
lessons converged on (objective / output format / tool guidance /
boundaries): without it subagents duplicate work or miss the point; the
parent registry is SHARED so an overlapping search settles as
``duplicate`` mechanically.  The subagent reports a COMPRESSED digest
(facts + gaps + the source lines) -- the compression is the point: the
lead keeps the conclusions, the child's raw reads never reach it.

The digest's ``[Subtask Sn]`` tag is the subagent's stable handle: the
lead's ``message_subtask(id, message)`` resumes THAT subagent -- its
conversation (sources, ledger, reads) is kept verbatim -- with a
correction, a new angle or a gap-closing instruction, and a fresh
digest comes back.  Re-delegation would re-search the facet from zero;
the follow-up spends turns, not a new context."""

import typing as t

from searx.zjsearch.ai.core.text import raw_args

DELEGATE_RESEARCH_TOOL = "delegate_research"

INSTRUCTIONS = """\
Delegate when the question has 2-4 INDEPENDENT facets worth parallel
depth; do NOT delegate a quick lookup you can search yourself.  Use it
too when ONE facet needs many reads (a broad landscape scan) that would
flood your own context -- the subagent reads wide and returns only the
digest.  Brief each subagent with the four fields: vague briefs produce
duplicated work.  Batch the independent subtasks in ONE round so they
run in parallel; do not delegate more than 3-4 subtasks per round.
Their digests arrive as tool results -- aggregate them, never
re-research what a digest already settled.  Every digest opens with its
[Subtask Sn] tag: Sn is that subagent's id for the REST of the run --
message_subtask(id, message) sends it a follow-up it executes INSIDE the
context it built (its sources, ledger and reads are kept).  A digest
that was close-but-incomplete, a gap its digest reported, a correction
after you learned something new -- message it, don't re-delegate (a new
subagent would re-search the facet from zero)."""
"""The delegation doctrine -- injected into the system prompt's
<tool_notes> whenever the delegation tools are registered (Deep
Research only)."""


def delegate_research_spec() -> dict[str, t.Any]:
    """The delegation tool's spec: the four-field contract plus the
    title the timeline row carries."""
    return {
        "name": DELEGATE_RESEARCH_TOOL,
        "description": """\
Delegate ONE independent research subtask to a subagent -- a nested
researcher with its own context window that searches and reads pages,
then reports a compressed digest back to you.  One call = one subagent;
batch independent subtasks in one round to run them in parallel.  Brief
it like a colleague: objective (what to establish), output_format (what
the digest must contain), tool_guidance (where to look, what to skip),
boundaries (what is OUT of scope).""",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "A 4-12 word label for the timeline (the subtask's name).",
                },
                "objective": {
                    "type": "string",
                    "description": "What the subagent must establish -- specific, self-contained,"
                    " with the key entities/numbers/constraints named.",
                },
                "output_format": {
                    "type": "string",
                    "description": "What the digest back to you must contain (facts with numbers/dates,"
                    " a comparison table, a ranked list...).",
                },
                "tool_guidance": {
                    "type": "string",
                    "description": "Where to look: query languages, source types to prefer, pages worth"
                    " reading in full.",
                },
                "boundaries": {
                    "type": "string",
                    "description": "What is OUT of scope (other subtasks own it; do not research it here).",
                },
            },
            "required": ["title", "objective", "output_format", "tool_guidance", "boundaries"],
        },
    }


def parse_delegate_research_call(call: dict[str, t.Any]) -> dict[str, str]:
    """The sanitized delegation out of a ``delegate_research`` call."""
    args = raw_args(call)
    parsed: dict[str, str] = {}
    for field in ("title", "objective", "output_format", "tool_guidance", "boundaries"):
        parsed[field] = str(args.get(field) or "").strip()[:600]
    if not parsed["title"]:
        parsed["title"] = parsed["objective"][:60]
    return parsed
