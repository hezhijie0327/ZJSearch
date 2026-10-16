# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The tool registry: ONE package per tool family, centrally re-exported.

Every entry the model sees (``search_web``, ``browse``,
``update_plan``, ``record_findings``, ...) is one file here carrying
its spec (the dialect-neutral llm shape), the sanitizers that turn
untrusted call arguments into executed / displayed values, and the
service that backs it (Vane's researcher/actions split, Morphic's
lib/tools -- schema, description, parsing and execution live WITH the
tool).  ``browse`` is the one package (the session/reader machinery),
``mcp`` the external-server bridge, ``rows`` the calls-event row
builders; the shared text guard is :py:mod:`core.text` (``raw_args``).

Consumers (``runs.search.executor``, ``api.routes``,
``prompts.researcher``) import from the package root -- the re-exports
below are the stable surface: adding a family is one file plus one
registry entry, never an edit to the importers.

THE INSTRUCTIONS CHANNEL (the MCP server-instructions pattern for
internal tools): every tool package may carry an ``INSTRUCTIONS``
constant -- the usage doctrine and discipline (how to search like a
human, when a ledger call is worth making, the delegation batching
rules).  The prompt builders inject the registered tools' instructions
as the system prompt's ``<tool_notes>`` (byte-stable per toolset, so
the prefix cache survives), while the spec's ``description`` keeps only
the call semantics -- one doctrine, one home, and it disappears from
the prompt exactly when the tool leaves the surface."""

from searx.zjsearch.ai.core.text import raw_args
from searx.zjsearch.ai.tools.ask_user import ASK_USER_TOOL, ask_user_spec
from searx.zjsearch.ai.tools.build_table import (
    BUILD_TABLE_TOOL,
    build_table_spec,
    parse_build_table_call,
)
from searx.zjsearch.ai.tools.calculate import (
    CALCULATE_TOOL,
    INSTRUCTIONS as CALCULATE_INSTRUCTIONS,
    calculate_spec,
    parse_calculate_call,
)
from searx.zjsearch.ai.tools.delegate_research import (
    DELEGATE_RESEARCH_TOOL,
    INSTRUCTIONS as DELEGATE_INSTRUCTIONS,
    delegate_research_spec,
    parse_delegate_research_call,
)
from searx.zjsearch.ai.tools.evaluate import (
    EVALUATE_TOOL,
    decision_row,
    evaluate_spec,
    parse_evaluate_call,
)
from searx.zjsearch.ai.tools.list_engines import (
    LIST_ENGINES_TOOL,
    list_engines_spec,
    run_call as list_engines_run,
)
from searx.zjsearch.ai.tools.memory import MEMORY_TOOL, INSTRUCTIONS as MEMORY_INSTRUCTIONS, memory_spec
from searx.zjsearch.ai.tools.message_subtask import (
    MESSAGE_SUBTASK_TOOL,
    message_subtask_spec,
    parse_message_subtask_call,
)
from searx.zjsearch.ai.tools.recall_history import (
    RECALL_HISTORY_TOOL,
    parse_query,
    recall_history_spec,
)
from searx.zjsearch.ai.tools.record_findings import (
    RECORD_FINDINGS_TOOL,
    INSTRUCTIONS as RECORD_FINDINGS_INSTRUCTIONS,
    parse_record_findings_call,
    record_findings_spec,
)
from searx.zjsearch.ai.tools.rows import display_item
from searx.zjsearch.ai.tools.search_web import (
    INSTRUCTIONS as SEARCH_WEB_INSTRUCTIONS,
    SEARCH_CATEGORIES,
    SEARCH_WEB_TOOL,
    paid_bangs,
    paid_engines,
    parse_call,
    search_web_spec,
)
from searx.zjsearch.ai.tools.update_plan import (
    UPDATE_PLAN_TOOL,
    INSTRUCTIONS as UPDATE_PLAN_INSTRUCTIONS,
    parse_plan_call,
    update_plan_spec,
)
from searx.zjsearch.ai.tools.inspect_image import (
    INSPECT_IMAGE_TOOL,
    inspect_image_spec,
    parse_inspect_image_call,
)
from searx.zjsearch.ai.tools.browse import (
    BROWSE_TOOL,
    INSTRUCTIONS as BROWSE_INSTRUCTIONS,
    browse_spec,
    parse_browse_call,
)

TOOL_INSTRUCTIONS: dict[str, str] = {
    SEARCH_WEB_TOOL: SEARCH_WEB_INSTRUCTIONS,
    BROWSE_TOOL: BROWSE_INSTRUCTIONS,
    CALCULATE_TOOL: CALCULATE_INSTRUCTIONS,
    UPDATE_PLAN_TOOL: UPDATE_PLAN_INSTRUCTIONS,
    RECORD_FINDINGS_TOOL: RECORD_FINDINGS_INSTRUCTIONS,
    DELEGATE_RESEARCH_TOOL: DELEGATE_INSTRUCTIONS,
    MEMORY_TOOL: MEMORY_INSTRUCTIONS,
}
"""Tool name -> its INSTRUCTIONS doctrine (the tools with strategy or
discipline beyond their call semantics).  The prompt builders collect
it IN REGISTRATION ORDER for the run's toolset and render it as the
system prompt's ``<tool_notes>`` -- a tool absent from the surface
carries no doctrine, so the gate can never drift.  Tools whose
description already says everything (ask_user, evaluate, list_engines,
recall_history, message_subtask, inspect_image, build_table) have no
entry."""

__all__ = [
    "ASK_USER_TOOL",
    "BROWSE_TOOL",
    "BUILD_TABLE_TOOL",
    "CALCULATE_TOOL",
    "DELEGATE_RESEARCH_TOOL",
    "EVALUATE_TOOL",
    "INSPECT_IMAGE_TOOL",
    "LIST_ENGINES_TOOL",
    "MEMORY_TOOL",
    "MESSAGE_SUBTASK_TOOL",
    "RECALL_HISTORY_TOOL",
    "RECORD_FINDINGS_TOOL",
    "SEARCH_CATEGORIES",
    "SEARCH_WEB_TOOL",
    "TOOL_INSTRUCTIONS",
    "UPDATE_PLAN_TOOL",
    "paid_bangs",
    "paid_engines",
    "ask_user_spec",
    "browse_spec",
    "build_table_spec",
    "calculate_spec",
    "decision_row",
    "delegate_research_spec",
    "display_item",
    "evaluate_spec",
    "inspect_image_spec",
    "list_engines_run",
    "list_engines_spec",
    "memory_spec",
    "message_subtask_spec",
    "parse_browse_call",
    "parse_build_table_call",
    "parse_calculate_call",
    "parse_call",
    "parse_delegate_research_call",
    "parse_evaluate_call",
    "parse_inspect_image_call",
    "parse_message_subtask_call",
    "parse_plan_call",
    "parse_query",
    "parse_record_findings_call",
    "raw_args",
    "recall_history_spec",
    "record_findings_spec",
    "search_web_spec",
    "update_plan_spec",
]
