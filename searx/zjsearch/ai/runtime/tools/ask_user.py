# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``ask_user`` tool -- spec.

The mid-research human-in-the-loop escape hatch: the model may stop and
ask instead of guessing.  The wire shape mirrors
``gates.sanitize_questions`` EXACTLY (single/multi + 2-4 options; every
question carries the client's free-text line) -- a type the sanitizer
would downgrade must not be advertised.  The run ends with the
questions; the answers travel back as ``clarifications``.
"""

import typing as t

ASK_TOOL = "ask_user"


def ask_user_spec() -> dict[str, t.Any]:
    """The mid-research human-in-the-loop tool: the model may stop and ask
    instead of guessing -- when the request is genuinely ambiguous, when
    the user's success criteria are unstated, or when the answer's stakes
    make a wrong assumption expensive (forecasts, recommendations with
    money/health/legal consequences).  The run ends with the questions;
    the answers travel back as ``clarifications``.  The wire shape here
    mirrors ``gates.sanitize_questions`` EXACTLY (single/multi + 2-4
    options; every question carries the client's free-text line) -- a
    type the sanitizer would downgrade must not be advertised."""
    return {
        "name": ASK_TOOL,
        "description": (
            "Stop researching and ask the user for direction.  Do NOT plow"
            " ahead on a guess: call this ONCE, as the ONLY call of its"
            " turn, the moment you realize that -- whatever the research"
            " returns -- the answer could miss what the user actually"
            " wants.  Triggers: a genuinely ambiguous subject (an acronym,"
            " code or short name matching several unrelated products); a"
            " scope, target or success criterion only the user can state;"
            " a high-stakes deliverable (a forecast, an investment,"
            " purchase, health or legal question) whose assumptions would"
            " change the answer.  Asking one sharp question beats a full"
            " run on the wrong premise.  Do NOT use it for broad"
            " informational topics (cover their facets instead), for"
            " details live sources can settle, or after the user already"
            " confirmed a direction."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "intro": {"type": "string", "description": "One sentence on why you ask."},
                "questions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "q": {"type": "string", "description": "The question to the user."},
                            "type": {
                                "type": "string",
                                "enum": ["single", "multi"],
                                "description": (
                                    "single = pick one option; multi = pick any."
                                    "  The user can always add free text on"
                                    " every question -- a yes/no question is a"
                                    ' single with options ["Yes", "No"].'
                                ),
                            },
                            "options": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "2-4 short concrete answers to choose from.",
                            },
                        },
                        "required": ["q", "type"],
                    },
                    "description": "At most 3 questions.",
                },
            },
            "required": ["questions"],
        },
    }
