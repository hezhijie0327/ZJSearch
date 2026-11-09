# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The prompt library: the byte-stable text blocks the tasks assemble
their conversations from.  One module per contract surface -- every
model-facing word lives HERE (or in a tool package's own INSTRUCTIONS),
never inline in task logic: a wording change is a prompts commit.

Modules:
- ``spine`` -- the shared fragments + the answer spine + the tier
  shape ladder (the product voice).
- ``researcher`` -- the lead researcher's conversation opener.
- ``subagent`` -- the delegated subagent's persona + spend caps.
- ``notes`` -- the run-level honesty/progress notes the machinery
  appends mid-run.
- ``report`` / ``deck`` -- the two document output shapes.
- ``extractor`` -- the post-run json_completions prompts.

Consumers import through this package root (the re-exports below are
the stable surface, mirroring ``tools.__init__``); adding a module is
one file plus one export line, never an edit to the importers."""

from searx.zjsearch.ai.prompts import (
    deck,
    extractor,
    notes,
    report,
    researcher,
    spine,
    subagent,
)
from searx.zjsearch.ai.prompts.notes import (
    BUDGET_NOTE,
    RESUME_NOTE,
    RESUME_NOTE_WRITE,
    STALL_NOTE,
)
from searx.zjsearch.ai.prompts.researcher import initial_messages
from searx.zjsearch.ai.prompts.spine import (
    AGENT_PERSONA_NAME,
    answer_contract,
    block,
    citation_rules,
    language_directive,
    markdown_surface,
    shape_ladder,
)
from searx.zjsearch.ai.prompts.subagent import (
    SUB_ROUNDS,
    SUB_STALL_ROUNDS,
    subagent_messages,
)

__all__ = [
    "AGENT_PERSONA_NAME",
    "BUDGET_NOTE",
    "RESUME_NOTE",
    "RESUME_NOTE_WRITE",
    "STALL_NOTE",
    "SUB_ROUNDS",
    "SUB_STALL_ROUNDS",
    "answer_contract",
    "block",
    "citation_rules",
    "deck",
    "extractor",
    "initial_messages",
    "language_directive",
    "markdown_surface",
    "notes",
    "report",
    "researcher",
    "shape_ladder",
    "spine",
    "subagent",
    "subagent_messages",
]
