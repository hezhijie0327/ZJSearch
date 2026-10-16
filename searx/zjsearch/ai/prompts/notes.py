# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The run-level NOTES the machinery whispers to the model mid-run.

The honesty/progess prose lives in ONE place so the model-facing voice
stays auditable: the stall verdict, the budget-exhausted note, the
context-pressure and last-round nudges, and the CONTINUE contract's
resume notes.  These are PLAIN strings (no XML wrapper) -- they arrive
as appended turns or parenthetical round notes, not as system-prompt
blocks.  The agent ENGINE's own notes (loop/compact) stay next to their
mechanism by design; this module is the run layer's set.
"""

STALL_NOTE = """\
The research went STALE and ended early: the latest rounds only repeated
earlier queries or returned nothing new.  Where the sources are silent,
apply the grounding rule above."""
"""The stall detector's verdict, handed to the writer as the research
note: the gathering ended on unproductive rounds (the honest framing --
the writer answers from what exists and names the gaps)."""

BUDGET_NOTE = """\
The research budget ended the gathering early -- the sources above are
everything that was found."""
"""The writer's research note when the run spent its round budget
without stalling (the loop's own halt message covers the reason; this is
the plain budget-exhausted case)."""

RESUME_NOTE = """\
<resume_note>The transcript above is your own research from a previous
process that died mid-run -- it is complete up to the last tool results
shown. Continue it where it stands: re-affirm your task ledger
(update_plan) and findings ledger (record_findings) first if they are not
current in this transcript, do NOT repeat searches or page reads whose
results already appear above (their sources keep their [n] numbers),
then continue the open ledger items. The user experiences this as the
same run resuming, not a restart.</resume_note>"""
"""The CONTINUE contract's mid-research note, appended after the replayed
conversation (an honest note -- the model never sees machine keys)."""

RESUME_NOTE_WRITE = """\
<resume_note>The transcript above is your own research from a previous
process that died during the WRITING phase -- the gathering is DONE and
the findings ledger above is complete. Do NOT run new searches or page
reads and do NOT re-open the task list: close with what you have (wrap
up without tool calls) so the report/deck is written from the material
above. Only if a RED-LINE gap makes the deliverable impossible may you
run at most one targeted search. The user experiences this as the same
run resuming straight into the writer.</resume_note>"""
"""The CONTINUE contract's write-phase note: the gathering is done, the
writer closes from the material on hand."""
