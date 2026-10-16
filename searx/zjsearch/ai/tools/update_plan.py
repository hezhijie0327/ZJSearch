# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``update_plan`` tool -- spec and call parsing.

The living task list (quality/goal): the model decomposes the request
into subtasks, keeps their statuses current AND reshapes the plan as the
evidence demands -- the client renders the list as the task card, and
the coverage tracker only records PROVENANCE (which source titles
landed on which subtask); statuses are never written here.
"""

import typing as t

from searx.zjsearch.ai.core.text import raw_args

UPDATE_PLAN_TOOL = "update_plan"

INSTRUCTIONS = """\
The plan is a LIVING hypothesis, not a contract.  FIRST round:
decompose the request into concrete, independent subtasks -- as many as
the question genuinely needs (each answerable by its own focused
research).  Work it EVERY round and keep it TRUE: statuses are yours to
set (done when a subtask's material is gathered), and cross-checking
often proves an earlier assumption wrong -- when evidence reveals a dead
end, a missing facet, an entity the final answer depends on, or a
SURPRISE (an unexpected player, a contradicting number, a facet you had
not considered -- surprises are plan edits, not footnotes), RESEND the
COMPLETE list: add, split, merge, reword or drop subtasks (a dropped
dead end simply leaves the list).  The newest list replaces the card --
never leave a subtask standing that the evidence has already
contradicted.  The research ends when the PLAN closes -- every subtask
done or consciously dropped -- not when you feel done."""
"""The living-plan doctrine -- injected into the system prompt's
<tool_notes> whenever the tool is registered."""


def update_plan_spec() -> dict[str, t.Any]:
    """The living task list (quality/goal): the model decomposes the
    request into subtasks and keeps the plan current -- the client
    renders the list as the task card, and the list drives what gets
    delegated next."""
    return {
        "name": UPDATE_PLAN_TOOL,
        "description": """\
Create or update the SUBTASK LIST for this research -- it is the ONLY
way the plan or its statuses ever change.  The list is rendered to the
user as your research plan, and the coverage tracker records which
sources landed on which subtask (statuses are never written there).
Send the COMPLETE list every time -- the newest call REPLACES the card,
it is not a diff.""",
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True},
        "inputSchema": {
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
                    "description": "The COMPLETE list, sized to the question (a handful for a simple one, more when the facets demand it) -- not a diff; the newest call REPLACES the card.",
                },
            },
            "required": ["items"],
        },
    }


def parse_plan_call(call: dict[str, t.Any]) -> list[dict[str, str]]:
    """The sanitized task list out of a ``update_plan`` call.  No item cap:
    the plan is the model's -- it sizes the list to the question (the
    title/status caps are the only sanitation)."""
    args = raw_args(call)
    items = args.get("items")
    out: list[dict[str, str]] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:200]
        status = str(item.get("status") or "pending").strip().lower()
        if not title:
            continue
        out.append({"title": title, "status": status if status in ("pending", "active", "done") else "pending"})
    return out
