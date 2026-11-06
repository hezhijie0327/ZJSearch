# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``set_deliverable`` tool -- spec and call parsing.

The output-shape flip (quality/goal): the model commits the run's
DELIVERABLE format (a written report, a presentation deck) while the
research is still running -- an outline is minted on the spot and the
write phase switches from the single-answer shape to the outline-driven
document.  The shape is a run-level contract, not a per-turn result:
this is a CONTROL tool in the paid-bang family (it flips run state and
answers with an acknowledgement, the document itself arrives at write
time).
"""

import typing as t

from searx.zjsearch.ai.core.text import raw_args

SET_DELIVERABLE_TOOL = "set_deliverable"

SHAPES = ("report", "deck")

INSTRUCTIONS = """\
The deliverable shape is the FORM the final answer takes: the default
is the direct answer; a REPORT is an outline-driven document (title,
sections, each written and cited separately) and a DECK is the same
skeleton on a slide contract.  Call set_deliverable the moment the
request names a deliverable format (a report, a research report, a
briefing document, a PPT / slide deck / presentation)
or the material clearly deserves one -- EARLY, ideally in the first
round, so the remaining rounds gather with the document in view.  Call
it ONCE; a second call only re-mints the skeleton.  After the call keep
researching exactly as before -- every source you gather is what the
sections will cite; the document itself is written at the write phase,
not by this call.  When the run already writes a report or deck, do not
call this tool (the reader can still re-pick the structure themselves)."""
"""The deliverable-shape doctrine -- injected into the system prompt's
<tool_notes> whenever the tool is registered."""


def set_deliverable_spec() -> dict[str, t.Any]:
    """The output-shape flip (quality/goal): commit the run's deliverable
    format -- an outline is minted immediately and the write phase
    produces the outline-driven document; the research itself continues
    unchanged."""
    return {
        "name": SET_DELIVERABLE_TOOL,
        "description": """\
Set the DELIVERABLE SHAPE of this run's final answer: "report" (an
outline-driven document -- title, sections, per-section citations) or
"deck" (the same skeleton on a presentation-slide contract).  Call it
when the request names a deliverable format or the material clearly
deserves one; the outline is minted immediately and the remaining
research keeps running -- the document is written at the write phase.
The default shape (no call) stays the direct answer.""",
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True},
        "inputSchema": {
            "type": "object",
            "properties": {
                "shape": {
                    "type": "string",
                    "enum": list(SHAPES),
                    "description": 'report = a written, section-structured document; deck = a presentation outline.',
                },
            },
            "required": ["shape"],
        },
    }


def parse_set_deliverable_call(call: dict[str, t.Any]) -> str | None:
    """The sanitized shape out of a ``set_deliverable`` call: one of
    :data:`SHAPES`, ``None`` on anything malformed (the handler teaches
    the correct shape)."""
    args = raw_args(call)
    shape = str(args.get("shape") or "").strip().lower()
    return shape if shape in SHAPES else None
