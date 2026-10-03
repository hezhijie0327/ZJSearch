# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``calculator`` tool's name constant.

The calculator is a CAPABILITY, not a runtime tool family: its spec
(``calculator_spec``) and its evaluator (``evaluate_call``) live in
:py:mod:`searx.zjsearch.ai.capabilities.calculator`.  The name lives
here beside the other tool names so the researcher prompt's
``<calculator>`` block and the timeline rows speak the registered
string, never a literal -- one rename touches one line.
"""

CALCULATOR_TOOL_NAME = "calculator"
