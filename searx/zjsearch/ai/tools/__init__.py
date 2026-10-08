# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The tool registry: ONE package per tool family, centrally re-exported.

Every entry the model sees (``web_search``, ``web_reader``,
``task_write``, ``learnings``, ...) is one package here carrying its
spec (the dialect-neutral llm shape), the sanitizers that turn
untrusted call arguments into executed / displayed values, and the
service that backs it (Vane's researcher/actions split, Morphic's
lib/tools -- schema, description, parsing and execution live WITH the
tool).  The shared text guard is :py:mod:`core.text` (``raw_args``);
the ``calls``-event row builders are :py:mod:`rows`.

Consumers (``runs.search.executor``, ``api.routes``,
``prompts.researcher``) import from the package root -- the re-exports
below are the stable surface: adding a family is one package plus one
registry entry, never an edit to the importers."""

from searx.zjsearch.ai.core.text import raw_args
from searx.zjsearch.ai.tools.ask_user import ASK_TOOL, ask_user_spec
from searx.zjsearch.ai.tools.calculator import CALCULATOR_TOOL, calculator_spec, parse_calculator_call
from searx.zjsearch.ai.tools.extract import EXTRACT_TOOL, extract_spec, parse_extract_call
from searx.zjsearch.ai.tools.judge import DECISION_TOOL, decision_row, parse_system_one_call, system_one_spec
from searx.zjsearch.ai.tools.learnings import LEARNINGS_TOOL, learnings_spec, parse_learnings_call
from searx.zjsearch.ai.tools.memory import USER_MEMORY_TOOL, user_memory_spec
from searx.zjsearch.ai.tools.research_subtask import (
    RESEARCH_SUBTASK_TOOL,
    parse_research_subtask_call,
    research_subtask_spec,
)
from searx.zjsearch.ai.tools.past_research import (
    PAST_RESEARCH_TOOL,
    parse_query,
    past_research_spec,
)
from searx.zjsearch.ai.tools.rows import display_item
from searx.zjsearch.ai.tools.tasks import TASK_TOOL, parse_task_call, task_write_spec
from searx.zjsearch.ai.tools.view_image import VIEW_IMAGE_TOOL, parse_view_image_call, view_image_spec
from searx.zjsearch.ai.tools.web_browser import WEB_BROWSER_TOOL, parse_web_browser_call, web_browser_spec
from searx.zjsearch.ai.tools.web_reader import PAGE_TOOL, parse_page_call, page_spec
from searx.zjsearch.ai.tools.web_search import SEARCH_CATEGORIES, TOOL_NAME, parse_call, tool_spec

__all__ = [
    "ASK_TOOL",
    "RESEARCH_SUBTASK_TOOL",
    "CALCULATOR_TOOL",
    "DECISION_TOOL",
    "EXTRACT_TOOL",
    "LEARNINGS_TOOL",
    "PAGE_TOOL",
    "WEB_BROWSER_TOOL",
    "PAST_RESEARCH_TOOL",
    "SEARCH_CATEGORIES",
    "TASK_TOOL",
    "VIEW_IMAGE_TOOL",
    "TOOL_NAME",
    "USER_MEMORY_TOOL",
    "ask_user_spec",
    "calculator_spec",
    "decision_row",
    "display_item",
    "extract_spec",
    "learnings_spec",
    "page_spec",
    "research_subtask_spec",
    "parse_call",
    "parse_calculator_call",
    "parse_extract_call",
    "parse_learnings_call",
    "parse_page_call",
    "parse_query",
    "parse_system_one_call",
    "parse_research_subtask_call",
    "parse_task_call",
    "parse_view_image_call",
    "parse_web_browser_call",
    "past_research_spec",
    "raw_args",
    "system_one_spec",
    "task_write_spec",
    "view_image_spec",
    "web_browser_spec",
    "tool_spec",
    "user_memory_spec",
]
