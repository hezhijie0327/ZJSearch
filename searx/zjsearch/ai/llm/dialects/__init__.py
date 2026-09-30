# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The wire-dialect registry: ``zjsearch.ai.sdk`` value -> dialect module.

The streaming bridge and the structured-object gate look their dialect
up here (:py:func:`searx.zjsearch.ai.llm.config.endpoint` resolves the
kind).  One SDK = one module under this package + one entry below.
"""

from . import anthropic, gemini, openai_chat, openai_responses

DIALECTS = {
    openai_chat.KIND: openai_chat,
    openai_responses.KIND: openai_responses,
    anthropic.KIND: anthropic,
    gemini.KIND: gemini,
}
