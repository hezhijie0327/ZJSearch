# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The delegated SUBAGENT's contract: the conversation opener the lead's
delegation machinery builds, and the subagent's spend caps.

One subagent per delegation -- a nested research loop with its OWN
context window -- that reports a COMPRESSED digest back to the lead
(facts + gaps + the source lines).  The compression is the point: the
lead keeps the conclusions, the child's raw reads never reach it.  The
digest's ``[Subtask Sn]`` tag is the subagent's stable handle for the
run (see ``message_subtask``).  The persona lives in the prompts layer
(tools -> prompts is the legal edge) because it is conversation
material, not tool surface: it composes the same XML-block language as
every other builder here."""

import typing as t

from searx.zjsearch.ai.prompts import spine as shared

SUB_ROUNDS = 6
"""A subagent's round budget (one round = one parallel batch)."""

SUB_STALL_ROUNDS = 2
"""The subagent's stall detector: two unproductive rounds end it (the
lead's run keeps its own budget -- the subagent is a spend cap, not a
research goal)."""


def subagent_messages(
    parsed: dict[str, str],
    lang: str,
    today: str,
    tool_notes: list[tuple[str, str]] | None = None,
) -> list[dict[str, t.Any]]:
    """The SUBAGENT's conversation opener: a compact researcher -- the
    delegation contract verbatim, the shared discipline (wide then
    narrow, the digest is the deliverable) and the report-back contract.
    The child's registered tools carry their doctrine in ``tool_notes``
    (the same <tool_notes> channel the lead researcher speaks); the
    discipline here keeps only what spans the tools.  No task list, no
    ask, no memory writes: those are the LEAD's surfaces."""
    system_parts = [
        shared.block(
            "role",
            """\
            You are a research SUBAGENT. A lead researcher delegated one
            subtask to you; you have your own context window and report a
            compressed digest back.  Research ONLY your subtask.""",
        ),
        shared.block("today", today),
        shared.block(
            "delegation",
            f"""\
            <title>{parsed['title']}</title>
            <objective>{parsed['objective']}</objective>
            <output_format>{parsed['output_format']}</output_format>
            <tool_guidance>{parsed['tool_guidance']}</tool_guidance>
            <boundaries>{parsed['boundaries']}</boundaries>""",
        ),
        shared.block(
            "discipline",
            f"""\
            - Start WIDE (short broad queries), read the landscape, then
            narrow; 3-10 tool calls is a normal subtask.
            - Cite every fact with its [n]; never present a number without
            one.
            - Write your final digest in {lang}.""",
        ),
        shared.block(
            "report",
            """\
            Your FINAL message is the digest the lead reads -- it is your
            entire deliverable.  Follow output_format; lead with the
            established facts (each with [n]), then the open questions your
            sources could NOT settle.  Keep it under ~400 words: the lead
            aggregates many digests.""",
        ),
        shared.block(
            "follow_ups",
            """\
            The lead may send LATER messages (wrapped in <lead_followup>)
            after your digest -- a correction, a new angle, a gap to close.
            Each one continues THIS subtask: your sources, ledger and reads
            are all still yours -- build on them instead of starting over,
            then report a fresh digest in the same shape.""",
        ),
    ]
    if tool_notes:
        sections = "\n\n".join(f"[{name}]\n{text}" for name, text in tool_notes)
        system_parts.append(
            "<tool_notes>\nEach registered tool carries its usage doctrine"
            " below -- how to work it well (the schemas say when to call"
            f" it):\n\n{sections}\n</tool_notes>"
        )
    user = f"<subtask>\n{parsed['objective']}\n</subtask>"
    return [
        {"role": "system", "content": "\n".join(system_parts)},
        {"role": "user", "content": user},
    ]
