# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``task_write`` tool -- spec and call parsing.

The living task list (quality/goal): the model decomposes the request
into subtasks and keeps their statuses current -- the client renders
the list as the task card, and the list drives what gets researched
next (the coverage tracker marks a subtask done only when real source
titles matched it).
"""

import typing as t

from searx.zjsearch.ai.runtime.tools.args import raw_args

TASK_TOOL = "task_write"


def task_write_spec() -> dict[str, t.Any]:
    """The living task list (quality/goal): the model decomposes the
    request into subtasks and keeps their statuses current -- the client
    renders the list as the task card, and the list drives what gets
    delegated next."""
    return {
        "name": TASK_TOOL,
        "description": (
            "Create or update the SUBTASK LIST for this research -- it is"
            " the ONLY way the plan or its statuses ever change.  First"
            " round: decompose the request into 2-4 concrete, independent"
            " subtasks (each answerable by its own focused research)."
            " EVERY round afterwards: keep the list TRUE -- set a subtask"
            ' to {"status": "done"} the moment its sources are gathered,'
            ' "active" while researching it, and APPEND new subtasks whenever'
            " the findings reveal an important facet you had not planned"
            " for.  THE RESEARCH IS NOT COMPLETE while any subtask is"
            " pending or active: finish it, or hand over only once every"
            " subtask is done.  The list is rendered to the user as your"
            " research plan -- keep it current."
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
    args = raw_args(call)
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
