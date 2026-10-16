# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the run-progress machinery.

The model-facing PROGRESS SURFACE of a research run (Vane's
per-iteration awareness, in canonical-messages form): the budget and
context-pressure notes the executor appends to a round's tool results,
and the stall detector the agent loop consults after each executed
round.  Both answer "is this run still going somewhere?" from the two
sides that can act on it -- the notes let the MODEL change course one
turn before the detector would end the research, and the detector ends
it when the rounds stay unproductive.
"""

from __future__ import annotations
import time
import typing as t

from searx.zjsearch.ai.prompts.researcher import STALL_NOTE

if t.TYPE_CHECKING:
    from searx.zjsearch.ai.runs.search.executor import Searches

BUDGET_LAST_ROUND_NOTE = "(budget note: ONE research round remains -- make it cover the most important remaining gaps.)"
"""The executor's budget note, appended to the round before the last:
the next turn reads it with the tool results it describes, so the model
can spend the remaining round where it matters."""

FEED_CONVERGE_NOTE = (
    "(note: the source context is getting large -- start converging:"
    " prefer answering from what you have over opening more pages.)"
)
"""The context-pressure note, appended once when the accumulated feed
crosses the executor's soft limit -- the signal reaches the MODEL (not
only the writer's input shaping)."""

TIME_BUDGET_NOTE = (
    "(budget note: the run's time budget is spent -- wrap up the research"
    " this round: one or two targeted calls at most, then stop calling"
    " tools so the writer can answer.)"
)
"""The wall-clock verdict: the run's ``max_seconds`` elapsed.  One more
turn of grace (the note reaches the model through this round's feeds),
then the time check ends the research regardless of productivity."""


def round_progress(
    state: Searches,
    stall_rounds: int,
    max_seconds: int = 0,
) -> t.Callable[[int], tuple[str, str] | None]:
    """The progress-based termination policy: called by the agent loop
    after each executed round.  A round is PRODUCTIVE when at least one
    fresh query returned results; ``stall_rounds`` consecutive
    unproductive rounds end the research (the returned message explains
    the staleness to the model).  Productive research is UNLIMITED; a
    round of pure bookkeeping (plan writes, memory saves) is neither
    progress nor stall.  ``max_seconds`` (0 = unlimited) is the run's
    wall-clock budget: the FIRST expiry returns the grace note (the
    model wraps up), the second ends the research regardless of
    productivity.  The verdict is a ``(model-facing note, machine
    halt_reason)`` pair -- the reason rides the settle event so the
    client can name WHY the research ended early; ``None`` keeps
    researching."""

    expired = False

    def verdict(_round_no: int) -> tuple[str, str] | None:
        nonlocal expired
        elapsed = time.monotonic() - state.started_at
        if 0 < max_seconds <= elapsed:
            if expired:
                return STALL_NOTE, "stalled"
            expired = True
            return TIME_BUDGET_NOTE, "time_budget"
        if not state.round_gathered:
            return None
        if state.round_new_hits > 0:
            state.stalled_rounds = 0
            return None
        state.stalled_rounds += 1
        if state.stalled_rounds < stall_rounds:
            return None
        return STALL_NOTE, "stalled"

    return verdict


def continuation_note(open_tasks: list[str], open_gaps: list[str]) -> str:
    """The zero-calls continuation: the model stopped calling tools while
    the ledger still carries open items -- ONE nudge naming them (the
    honest exit is spelled out too: close the gap as unanswerable, or
    stop again and the writer reports the residue).  The loop caps the
    nudges (twice) so a model that genuinely has nothing never gets
    trapped in the run."""
    lines = [
        "(progress note: you stopped calling tools, but the research"
        " ledger is not closed -- the question is not fully covered yet.",
    ]
    if open_tasks:
        shown = "; ".join(f'"{title}"' for title in open_tasks[:4])
        lines.append(f"Open subtasks: {shown}.")
    if open_gaps:
        shown = "; ".join(f'"{q}"' for q in open_gaps[:4])
        lines.append(f"Open gaps: {shown}.")
    lines.append(
        "Pick the most important one and run this round against it --"
        " change the keyword angle, read the promising page, or compute"
        " the missing figure.  If the evidence genuinely does not exist,"
        " record that with findings (close_gaps, close_as = the honest"
        " reason) and stop calling tools again -- the writer will report"
        " the residue.  A bare restatement of the question is NOT a"
        " round.)"
    )
    return "\n".join(lines)
