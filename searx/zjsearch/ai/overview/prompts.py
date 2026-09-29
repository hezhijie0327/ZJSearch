# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Overview: the prompts.

The system prompt is the SHARED answer spine
(:py:func:`searx.zjsearch.ai.prompts.answer_contract` -- the same
block sequence the search writer speaks) with the overview's own role;
the images note is appended only when multimodal parts actually ride
along.
"""

import typing as t

from searx.zjsearch.ai import prompts

_ANSWER_USER_PROMPT = "<q>{q}</q>\n<sources>\n{context}\n</sources>"


def build_answer_messages(
    query: str, context: str, lang: str, image_parts: list[dict[str, t.Any]]
) -> list[dict[str, t.Any]]:
    """The zero-tool single-turn conversation: the shared answer spine
    (plus the images note when attachments ride) and the user turn with
    the client-assembled source context."""
    system = "\n".join(
        prompts.answer_contract(
            lang,
            "<role>\nYou are the \"AI Overview\" feature of a search engine:"
            " answer the user's question directly, grounded in the numbered"
            " sources provided.\n</role>",
        )
    )
    if image_parts:
        system += (
            "\n<images>\nImages are attached after this text; they come from"
            " the numbered sources and may carry relevant visual"
            " information.\n</images>"
        )
    user_text = _ANSWER_USER_PROMPT.format(q=query, context=context)
    return prompts.build_messages(system, prompts.user_message(user_text, image_parts))
