# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``past_research`` tool's name constant.

The tool itself is a capability: the spec (``past_research_spec``), the
entry parser and the ranking live in
:py:mod:`searx.zjsearch.ai.capabilities.past_research`.  The name lives
here beside the other tool names so the timeline rows and the
executor's branch reference the registered string, never a literal.
"""

PAST_RESEARCH_TOOL = "past_research"
