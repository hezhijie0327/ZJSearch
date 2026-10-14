# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The prompt library: the byte-stable text blocks the tasks assemble
their conversations from.  One module per contract surface
(:py:mod:`prompts.spine` the shared answer contract,
:py:mod:`prompts.researcher` the researcher conversation) plus the
gate/verdict instruction texts.  Prompt text lives HERE, never inline
in task logic -- a wording change is a prompts commit."""
