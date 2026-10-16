# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``message_subtask`` tool: the FOLLOW-UP channel to an
already-delegated subagent.

The digest's ``[Subtask Sn]`` tag is the subagent's stable handle: the
lead's ``message_subtask(id, message)`` resumes THAT subagent -- its
conversation (sources, ledger, reads) is kept verbatim -- with a
correction, a new angle or a gap-closing instruction, and a fresh
digest comes back.  Re-delegation would re-search the facet from zero;
the follow-up spends turns, not a new context."""

import typing as t

from searx.zjsearch.ai.core.text import raw_args

MESSAGE_SUBTASK_TOOL = "message_subtask"

FOLLOWUP_MAX = 4
"""Follow-up messages one subagent may receive per run -- the resume
channel's spend cap (each resume re-runs up to the subagent's round
budget on its own)."""


def message_subtask_spec() -> dict[str, t.Any]:
    """The follow-up tool's spec: a message to an ALREADY-delegated
    subagent, resumed inside the context it built."""
    return {
        "name": MESSAGE_SUBTASK_TOOL,
        "description": (
            "Send a FOLLOW-UP to a subagent you already delegated to (its"
            " digest's [Subtask Sn] tag is the id).  It resumes with its"
            " full research context still in place -- the sources it"
            " numbered, its findings ledger, the pages it read -- works"
            " your message (a correction, a refinement of the digest, a"
            " gap it reported) and reports a FRESH digest.  Use it when a"
            " digest was close but not what you need; open a NEW"
            " delegation (delegate_research) when the facet is independent"
            " (a follow-up costs turns, a new subagent costs a whole"
            " context)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "The subagent's id from its digest tag (S1, S2, ...).",
                },
                "message": {
                    "type": "string",
                    "description": "What to do next: the correction, the missing piece,"
                    " the angle to re-check -- self-contained enough that the"
                    " subagent need not guess.",
                },
            },
            "required": ["id", "message"],
        },
    }


def parse_message_subtask_call(call: dict[str, t.Any]) -> dict[str, str]:
    """The sanitized follow-up out of a ``message_subtask`` call."""
    args = raw_args(call)
    return {
        "id": str(args.get("id") or "").strip().upper()[:16],
        "message": str(args.get("message") or "").strip()[:2000],
    }
