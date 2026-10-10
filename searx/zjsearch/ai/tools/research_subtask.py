# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``research_subtask`` tool (v2.1 R3) and its FOLLOW-UP channel
``message_subtask``: one subagent per delegation -- a nested research
loop with its OWN context window -- that stays ADDRESSABLE after it
settles.

The delegation contract is the four-field shape Anthropic's multi-agent
lessons converged on (objective / output format / tool guidance /
boundaries): without it subagents duplicate work or miss the point; the
parent registry is SHARED so an overlapping search settles as
``duplicate`` mechanically.  The subagent reports a COMPRESSED digest
(facts + gaps + the source lines) -- the compression is the point: the
lead keeps the conclusions, the child's raw reads never reach it.

The digest's ``【子任务 Sn】`` tag is the subagent's stable handle: the
lead's ``message_subtask(id, message)`` resumes THAT subagent -- its
conversation (sources, ledger, reads) is kept verbatim -- with a
correction, a new angle or a gap-closing instruction, and a fresh
digest comes back.  Re-delegation would re-search the facet from zero;
the follow-up spends turns, not a new context.
"""

import typing as t

from searx.zjsearch.ai.core.text import raw_args

RESEARCH_SUBTASK_TOOL = "research_subtask"
MESSAGE_SUBTASK_TOOL = "message_subtask"

SUB_ROUNDS = 6
"""A subagent's round budget (one round = one parallel batch)."""

SUB_STALL_ROUNDS = 2
"""The subagent's stall detector: two unproductive rounds end it (the
lead's run keeps its own budget -- the subagent is a spend cap, not a
research goal)."""

FOLLOWUP_MAX = 4
"""Follow-up messages one subagent may receive per run -- the resume
channel's spend cap (each resume re-runs up to SUB_ROUNDS rounds on
its own)."""


def research_subtask_spec() -> dict[str, t.Any]:
    """The delegation tool's spec: the four-field contract plus the
    title the timeline row carries."""
    return {
        "name": RESEARCH_SUBTASK_TOOL,
        "description": (
            "Delegate ONE independent research subtask to a subagent -- a"
            " nested researcher with its own context window that searches"
            " and reads pages, then reports a compressed digest back to"
            " you.  Use it when a question has INDEPENDENT facets worth"
            " parallel depth (a delegation round), not for a quick lookup"
            " you can search yourself.  Brief it like a colleague: objective"
            " (what to establish), output_format (what the digest must"
            " contain), tool_guidance (where to look, what to skip),"
            " boundaries (what is OUT of scope).  One call = one subagent;"
            " batch independent subtasks in one round to run them in"
            " parallel.  Every digest opens with its 【子任务 Sn】 tag -- Sn"
            " is that subagent's id for the rest of the run: message_subtask"
            " sends it follow-ups inside the context it already built."
        ),
        "parameters": {
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


def parse_research_subtask_call(call: dict[str, t.Any]) -> dict[str, str]:
    """The sanitized delegation out of a ``research_subtask`` call."""
    args = raw_args(call)
    parsed: dict[str, str] = {}
    for field in ("title", "objective", "output_format", "tool_guidance", "boundaries"):
        parsed[field] = str(args.get(field) or "").strip()[:600]
    if not parsed["title"]:
        parsed["title"] = parsed["objective"][:60]
    return parsed


def message_subtask_spec() -> dict[str, t.Any]:
    """The follow-up tool's spec: a message to an ALREADY-delegated
    subagent, resumed inside the context it built."""
    return {
        "name": MESSAGE_SUBTASK_TOOL,
        "description": (
            "Send a FOLLOW-UP to a subagent you already delegated to (its"
            " digest's 【子任务 Sn】 tag is the id).  It resumes with its"
            " full research context still in place -- the sources it"
            " numbered, its findings ledger, the pages it read -- works"
            " your message (a correction, a refinement of the digest, a"
            " gap it reported) and reports a FRESH digest.  Use it when a"
            " digest was close but not what you need; delegate a NEW"
            " research_subtask when the facet is independent (a follow-up"
            " costs turns, a new subagent costs a whole context)."
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


def subagent_messages(parsed: dict[str, str], lang: str, today: str) -> list[dict[str, t.Any]]:
    """The SUBAGENT's conversation opener: a compact researcher -- the
    delegation contract verbatim, the shared discipline (wide then
    narrow, read what carries numbers, cite [n]) and the report-back
    contract.  No task list, no ask, no memory writes: those are the
    LEAD's surfaces."""
    system = (
        "<role>\nYou are a research SUBAGENT. A lead researcher delegated"
        " one subtask to you; you have your own context window and report"
        " a compressed digest back.  Research ONLY your subtask.\n</role>\n"
        f"<today>\n{today}\n</today>\n"
        "<delegation>\n"
        f"<title>{parsed['title']}</title>\n"
        f"<objective>{parsed['objective']}</objective>\n"
        f"<output_format>{parsed['output_format']}</output_format>\n"
        f"<tool_guidance>{parsed['tool_guidance']}</tool_guidance>\n"
        f"<boundaries>{parsed['boundaries']}</boundaries>\n"
        "</delegation>\n"
        "<discipline>\n"
        "- Start WIDE (short broad queries), read the landscape, then"
        " narrow; 3-10 tool calls is a normal subtask.\n"
        "- READ the pages that carry the key numbers (web_reader), don't"
        " trust snippets for figures.\n"
        "- Cite every fact with its [n]; never present a number without"
        " one.\n"
        "- RECORD each established fact with the learnings tool as you"
        " find it ([n] cited) -- your ledger IS your digest; a fact"
        " never recorded never reaches the lead.\n"
        "- Use the calculator for any non-trivial derived figure.\n"
        f"- Write your final digest in {lang}.\n"
        "</discipline>\n"
        "<report>\nYour FINAL message is the digest the lead reads -- it"
        " is your entire deliverable.  Follow output_format; lead with the"
        " established facts (each with [n]), then the open questions your"
        " sources could NOT settle.  Keep it under ~400 words: the lead"
        " aggregates many digests.\n</report>"
        "\n<followups>\nThe lead may send LATER messages (wrapped in"
        " <lead_followup>) after your digest -- a correction, a new angle,"
        " a gap to close.  Each one continues THIS subtask: your sources,"
        " ledger and reads are all still yours -- build on them instead of"
        " starting over, then report a fresh digest in the same shape.\n"
        "</followups>"
    )
    user = f"<subtask>\n{parsed['objective']}\n</subtask>"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
