# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``evaluate`` tool (the decision model) -- spec, call parsing, row.

The decision-model delegation tool: ONE forward pass answers
NAMED judgment questions about a state -- the tie-breaker for torn
calls (which of two sources is more authoritative, does this snippet
satisfy the subtask, is the claim supported), with a probability
distribution per answer instead of a guess.  It judges ONLY the state
handed to it (it cannot search and knows no facts) and never carries
facts the sources must cite; the model-facing forward pass itself lives
in :py:mod:`searx.zjsearch.ai.llm.decision`.
"""

import typing as t

from searx.zjsearch.ai.core.text import raw_args
from searx.zjsearch.ai.llm import decision

EVALUATE_TOOL = "evaluate"

INSTRUCTIONS = """\
Reach for it when YOU are torn or a call is borderline: which of two
sources better matches the subtask, whether a snippet is really about
X, whether the evidence supports a claim, a tie-break between
candidates.  It judges ONLY the state you hand it -- it cannot search
and knows no facts: never use it to find information, and cite sources
for facts regardless of its verdict.  Hand it COMPACT state (a few
hundred words at most): a title plus snippet, the two options side by
side, the claim plus the passage that supports it."""


def evaluate_spec() -> dict[str, t.Any]:
    """The decision-model delegation tool: ONE forward pass
    answers NAMED judgment questions about a state -- the tie-breaker for
    torn calls (which of two sources is more authoritative, does this
    snippet satisfy the subtask, is the claim supported), with a
    probability distribution per answer instead of a guess.  It is NOT a
    search substitute (it knows nothing beyond the state handed to it)
    and never carries facts the sources must cite.  The question
    vocabulary is the wire's own: ``choice`` (criteria = option name ->
    description, add an ``other`` fallback), ``score`` (criteria = an
    ordered legend array, 3-7 levels), ``noul`` (criteria optionally
    {"true": ..., "false": ...})."""
    return {
        "name": EVALUATE_TOOL,
        "description": """\
Delegate ONE structured judgment to a fast decision model (no text
generation, one forward pass): pick between candidates (choice), grade
something on an ordered scale (score), or answer a yes/no question
about the material (noul) -- each with probabilities.""",
        "annotations": {"readOnlyHint": True},
        "inputSchema": {
            "type": "object",
            "properties": {
                "state": {
                    "type": "string",
                    "description": (
                        "The material to judge, COMPACT (a few hundred words"
                        " at most): a source's title + snippet, the two"
                        " candidate options side by side, the claim plus the"
                        " passage that supports it."
                    ),
                },
                "images": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Optional image URLs from the gathered material for a"
                        " VISUAL judgment (a result's thumbnail, a picture the"
                        " question is about) -- http/https or data URLs, max"
                        " 4.  Each is fetched server-side and attached as"
                        " image-1..image-N in the order given; reference them"
                        " in the state or instructions by those plain names"
                        ' ("does image-1 show visible damage?").'
                    ),
                },
                "questions": {
                    "type": "array",
                    "description": "1-4 named judgment questions.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {
                                "type": "string",
                                "description": 'Short id for the answer, e.g. "more_authoritative".',
                            },
                            "type": {
                                "type": "string",
                                "enum": ["choice", "score", "noul"],
                            },
                            "instructions": {
                                "type": "string",
                                "description": "What to judge and by what standard.",
                            },
                            "criteria": {
                                "description": (
                                    "choice: option name -> short description"
                                    ' (include an "other" fallback); score:'
                                    " ordered legend array, 3-7 levels from"
                                    " low to high; noul: optional"
                                    ' {"true": ..., "false": ...}.'
                                )
                            },
                        },
                        "required": ["name", "type"],
                    },
                },
            },
            "required": ["state", "questions"],
        },
    }


def parse_evaluate_call(
    call: dict[str, t.Any],
) -> tuple[str, dict[str, dict[str, t.Any]], list[str]] | None:
    """``(state, wire questions, image urls)`` off the raw call arguments,
    or ``None`` when unusable: the questions arrive as the spec's array
    OR as the wire's named-question dict (models echo both shapes -- both
    normalize), types are whitelisted, the state and question caps keep
    the forward pass fast (images cap at the service's own ceiling)."""
    try:
        args = raw_args(call)
    except Exception:  # pylint: disable=broad-except
        return None
    state = str(args.get("state") or "").strip()
    raw_questions = args.get("questions")
    if isinstance(raw_questions, dict):
        raw_questions = [{**(q if isinstance(q, dict) else {}), "name": name} for name, q in raw_questions.items()]
    if not state or not isinstance(raw_questions, list):
        return None
    raw_images = args.get("images")
    images = (
        [str(url).strip() for url in raw_images if str(url or "").strip()][: decision.MAX_IMAGES]
        if isinstance(raw_images, (list, tuple))
        else []
    )
    questions: dict[str, dict[str, t.Any]] = {}
    for raw in raw_questions[:4]:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()[:64]
        qtype = str(raw.get("type") or "").strip()
        if not name or qtype not in ("choice", "score", "noul"):
            continue
        question: dict[str, t.Any] = {"type": qtype}
        instructions = str(raw.get("instructions") or "").strip()[:400]
        if instructions:
            question["instructions"] = instructions
        criteria = raw.get("criteria")
        if isinstance(criteria, (dict, list)) and criteria:
            question["criteria"] = criteria
        questions[name] = question
    if not questions:
        return None
    return state[:6000], questions, images


def decision_row(idx: int, call: dict[str, t.Any]) -> dict[str, t.Any]:
    """The ``evaluate`` timeline row: the label is the judgment STANDARD
    (the questions' instructions -- model-written, usually the user's own
    language), never the raw question ids ("most_worth_first_choice");
    the raw table rides the debug pane."""
    try:
        decision_args = raw_args(call)
    except Exception:  # pylint: disable=broad-except
        decision_args = {}
    raw_questions = decision_args.get("questions")
    instructions, names = [], []
    if isinstance(raw_questions, list):
        for question in raw_questions:
            if not isinstance(question, dict):
                continue
            if str(question.get("name") or ""):
                names.append(str(question["name"]))
            if str(question.get("instructions") or "").strip():
                instructions.append(str(question["instructions"]).strip())
    return {
        "id": idx,
        "tool": EVALUATE_TOOL,
        "q": (" / ".join(instructions) or " / ".join(names))[:120],
        "args": decision_args,
    }
