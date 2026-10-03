# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The tool registry: ONE module per tool family, centrally re-exported.

Every entry the model sees (``web_search``, ``web_reader``,
``task_write``, ``learnings``, ...) is one module here carrying its
spec function (the dialect-neutral llm shape) plus the sanitizers that
turn untrusted call arguments into executed / displayed values (Vane's
researcher/actions split, Morphic's lib/tools -- schema, description
and parsing live with the tool).  The SHARED infrastructure (the
raw-args reader, :py:mod:`args`, and the ``calls``-event dispatch,
:py:mod:`rows`) lives beside the families; the capabilities that are
full tool implementations elsewhere (``calculator``, ``user_memory``,
``past_research``) contribute their name constants so prompt and rows
speak the registered strings, never literals.

Consumers (``runtime.executor``, ``runtime.route``,
``runtime.researcher``) import from the package root -- the re-exports
below are the stable surface: adding a family is one module plus its
executor branch, never an edit to the importers.
"""

from searx.zjsearch.ai.runtime.tools.args import raw_args
from searx.zjsearch.ai.runtime.tools.ask_user import ASK_TOOL, ask_user_spec
from searx.zjsearch.ai.runtime.tools.calculator import CALCULATOR_TOOL_NAME
from searx.zjsearch.ai.runtime.tools.judge import DECISION_TOOL, decision_row, parse_system_one_call, system_one_spec
from searx.zjsearch.ai.runtime.tools.learnings import LEARNINGS_TOOL, learnings_spec, parse_learnings_call
from searx.zjsearch.ai.runtime.tools.memory import USER_MEMORY_TOOL
from searx.zjsearch.ai.runtime.tools.past_research import PAST_RESEARCH_TOOL
from searx.zjsearch.ai.runtime.tools.rows import display_item
from searx.zjsearch.ai.runtime.tools.tasks import TASK_TOOL, parse_task_call, task_write_spec
from searx.zjsearch.ai.runtime.tools.web_reader import PAGE_TOOL, parse_page_call, page_spec
from searx.zjsearch.ai.runtime.tools.web_search import SEARCH_CATEGORIES, TOOL_NAME, parse_call, tool_spec

__all__ = [
    "ASK_TOOL",
    "CALCULATOR_TOOL_NAME",
    "DECISION_TOOL",
    "LEARNINGS_TOOL",
    "PAGE_TOOL",
    "PAST_RESEARCH_TOOL",
    "SEARCH_CATEGORIES",
    "TASK_TOOL",
    "TOOL_NAME",
    "USER_MEMORY_TOOL",
    "ask_user_spec",
    "decision_row",
    "display_item",
    "learnings_spec",
    "page_spec",
    "parse_call",
    "parse_learnings_call",
    "parse_page_call",
    "parse_system_one_call",
    "parse_task_call",
    "raw_args",
    "system_one_spec",
    "task_write_spec",
    "tool_spec",
]
