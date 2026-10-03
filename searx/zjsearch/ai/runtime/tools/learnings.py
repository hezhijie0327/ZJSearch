# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``learnings`` tool -- spec and call parsing.

The findings ledger (dzhng's learnings, as a tool): the model records
what the sources ESTABLISHED as it goes -- the distilled record the
writer reads alongside the raw sources, and the run's visible evidence
trail.  Plans and next steps belong to ``task_write``; narration
belongs to the step notes.
"""

import typing as t

from searx.zjsearch.ai.runtime.tools.args import raw_args

LEARNINGS_TOOL = "learnings"

_LEARNING_MAX_CHARS = 400
"""One recorded finding's cap -- a finding is one self-contained sentence,
not a paragraph (the writer reads them alongside the full sources)."""


def learnings_spec() -> dict[str, t.Any]:
    """The findings ledger (dzhng's learnings, as a tool): the model
    records what the sources ESTABLISHED as it goes -- the distilled
    record the writer reads alongside the raw sources, and the run's
    visible evidence trail.  Plans and next steps belong to
    ``task_write``; narration belongs to the step notes."""
    return {
        "name": LEARNINGS_TOOL,
        "description": (
            "Record what the sources ESTABLISHED as durable findings of"
            " this research -- the running evidence ledger the writer"
            " reads alongside your sources.  One call, up to 6 facts,"
            " whenever a round settled something real; each fact is ONE"
            " self-contained sentence with its [n] citations where they"
            " apply (\"DeepSeek-V4 ships a 256k context window [4]\")."
            "  Never record plans, next steps or questions (the task list"
            " owns those), never restate the query -- and never record a"
            " fact no source supports."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "facts": {
                    "type": "array",
                    "items": {"type": "string", "description": "One self-contained finding, [n]-cited."},
                    "description": "1-6 NEW findings from this round (duplicates are dropped silently).",
                },
            },
            "required": ["facts"],
        },
    }


def parse_learnings_call(call: dict[str, t.Any]) -> list[str]:
    """The sanitized findings out of a ``learnings`` call: trimmed, capped,
    empty strings dropped."""
    args = raw_args(call)
    facts = args.get("facts")
    out: list[str] = []
    for fact in (facts if isinstance(facts, list) else [])[:8]:
        text = " ".join(str(fact or "").split())[:_LEARNING_MAX_CHARS]
        if text and text not in out:
            out.append(text)
    return out
