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

import typing as t

from searx.zjsearch.ai.runtime.researcher import STALL_NOTE

if t.TYPE_CHECKING:
    from searx.zjsearch.ai.runtime.executor import Searches

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


def round_progress(state: Searches, stall_rounds: int) -> t.Callable[[int], str | None]:
    """The progress-based termination policy: called by the agent loop
    after each executed round.  A round is PRODUCTIVE when at least one
    fresh query returned results; ``stall_rounds`` consecutive
    unproductive rounds end the research (the returned message explains
    the staleness to the model).  Productive research is UNLIMITED; a
    round of pure bookkeeping (plan writes, memory saves) is neither
    progress nor stall."""

    def verdict(_round_no: int) -> str | None:
        if not state.round_gathered:
            return None
        if state.round_new_hits > 0:
            state.stalled_rounds = 0
            return None
        state.stalled_rounds += 1
        if state.stalled_rounds < stall_rounds:
            return None
        return STALL_NOTE

    return verdict
