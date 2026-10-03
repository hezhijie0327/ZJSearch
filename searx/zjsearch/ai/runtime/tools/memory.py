# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``user_memory`` tool's name constant.

The tool itself is a capability: the spec (``user_memory_spec``), the
search/save evaluator and the post-run extractor live in
:py:mod:`searx.zjsearch.ai.capabilities.user_memory`.  The name lives
here beside the other tool names so the researcher prompt's
``<user_memory>`` block and the timeline rows reference the registered
string, never a literal.
"""

USER_MEMORY_TOOL = "user_memory"
