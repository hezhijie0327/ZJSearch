# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``user_memory`` tool's model-facing surface.

The name and the spec live here; the search/save evaluator and the
post-run extractor are the capability --
:py:mod:`searx.zjsearch.ai.capabilities.user_memory`.  The researcher
prompt's ``<user_memory>`` block and the timeline rows reference the
registered string, never a literal.
"""

import typing as t

USER_MEMORY_TOOL = "user_memory"


def user_memory_spec() -> dict[str, t.Any]:
    """The ``user_memory`` tool spec."""
    return {
        "name": USER_MEMORY_TOOL,
        "description": (
            "Remember durable facts about the user across sessions"
            " (action=save) or look up what is already stored"
            " (action=search).  Save ONLY lasting facts -- the user's"
            " city, occupation, standing preferences (answer style,"
            ' source preferences) -- e.g. {"action": "save", "content":'
            ' "用户常住杭州"} -- NEVER one-off conversation details.  The'
            " facts the user already has stored are listed in the"
            " <user_memory> context block: search is for checking before"
            " a save that might duplicate, not for re-reading what you"
            " can already see."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["search", "save"],
                    "description": "search = look up stored facts; save = store one new fact.",
                },
                "query": {
                    "type": "string",
                    "description": "search: keywords for the facts you are looking for.",
                },
                "content": {
                    "type": "string",
                    "description": (
                        "save: ONE self-contained fact in the user's language"
                        ' (e.g. "用户常住杭州, 关注本地房产政策").'
                    ),
                },
            },
            "required": ["action"],
        },
    }
