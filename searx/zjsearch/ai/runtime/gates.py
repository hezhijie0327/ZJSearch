# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the small structured completions ("gates") around the run.

Each is ONE ``llm.json_completion`` call with a narrow JSON schema and a
FAIL-OPEN contract -- a broken gate must never block research: the
pre-flight research gate, the clarify round-trip, the follow-up rewrite
and the post-``end`` related-questions fallback (Vane's classifier /
suggestions layer).  ``sanitize_questions`` is shared with the wire
layer: the mid-run ``ask_user`` tool arguments are the same untrusted
shape.
"""

import typing as t

from searx.zjsearch.ai.infra import jsongate

UsageOut = list[dict[str, t.Any]] | None
"""A gate's token account lands HERE (the route's collector list) -- the
gates are real completions and their spend joins the run's usage."""
_CLARIFY_SCHEMA: dict[str, t.Any] = {
    "type": "object",
    "properties": {
        "ask": {"type": "boolean"},
        "intro": {"type": "string"},
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "q": {"type": "string"},
                    "type": {"type": "string", "enum": ["single", "multi"]},
                    "options": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["q", "type", "options"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["ask", "intro", "questions"],
    "additionalProperties": False,
}

_RELATED_SCHEMA: dict[str, t.Any] = {
    "type": "object",
    "properties": {"questions": {"type": "array", "items": {"type": "string"}}},
    "required": ["questions"],
    "additionalProperties": False,
}

_STANDALONE_SCHEMA: dict[str, t.Any] = {
    "type": "object",
    "properties": {"question": {"type": "string"}},
    "required": ["question"],
    "additionalProperties": False,
}

_RESEARCH_SCHEMA: dict[str, t.Any] = {
    "type": "object",
    "properties": {"research": {"type": "boolean"}},
    "required": ["research"],
    "additionalProperties": False,
}


def sanitize_questions(raw_items: t.Any) -> list[dict[str, t.Any]]:
    """The wire shape of clarify questions: q + single/multi + 2-4 short
    options, capped at 3 questions -- shared by the clarify gate and the
    mid-run ask_user tool (untrusted model output on both paths)."""
    questions: list[dict[str, t.Any]] = []
    for raw in (raw_items or [])[:3]:
        if not isinstance(raw, dict) or not str(raw.get("q") or "").strip():
            continue
        options = [str(o).strip()[:80] for o in (raw.get("options") or []) if str(o).strip()][:4]
        questions.append(
            {
                "q": str(raw.get("q")).strip()[:200],
                "type": "multi" if str(raw.get("type") or "").strip() == "multi" else "single",
                "options": options,
            }
        )
    return questions


def research_gate(cfg: dict[str, t.Any], question: str, usage_out: UsageOut = None) -> bool:
    """The pre-flight gate (Vane's skipSearch, narrowed to our contract):
    False only for requests where NO answer detail can benefit from live
    web sources -- greetings and small talk, creative writing (poems,
    stories, emails), pure translation or arithmetic, rewriting of the
    user's own text.  Every factual question researches, however well
    known (the engine's contract is live, cited answers).  Fail-open: a
    broken gate must never block research."""
    messages = [
        {
            "role": "system",
            "content": (
                "You are the research gate of an AI search engine: decide"
                " whether the request needs live web research.  Answer false"
                " ONLY when nothing in a good answer could benefit from"
                " current web sources: greetings and small talk, creative"
                " writing (poems, stories, emails, essays), pure translation,"
                " arithmetic, or reworking of the user's own text."
                "  Everything else -- every factual question, however simple"
                " or well known -- needs research: this engine always answers"
                " with live, cited sources.  Output ONLY a JSON object, no"
                ' prose, no code fences: {"research": true} or {"research":'
                ' false}.'
            ),
        },
        {"role": "user", "content": f"<q>{question}</q>"},
    ]
    value, usage = jsongate.json_completion(cfg, messages, "research_gate", _RESEARCH_SCHEMA)
    if usage_out is not None and usage:
        usage_out.append(usage)
    if not value or not isinstance(value.get("research"), bool):
        return True
    return value["research"]


def standalone_question(
    cfg: dict[str, t.Any], question: str, history: list[dict[str, str]], lang: str, usage_out: UsageOut = None
) -> str:
    """The follow-up rewrite (Vane's standalone follow-up): one small
    completion turns a thread-relative question into a self-contained one
    ("How do they work?" -> "How do heat pumps work?").  The REWRITTEN
    question drives the research and the writer; the thread still shows
    the user's own wording.  Empty on any failure -- fail-open."""
    convo = "\n".join(f"Q: {turn.get('q') or ''}\nA: {(turn.get('a') or '')[:400]}" for turn in history)
    messages = [
        {
            "role": "system",
            "content": (
                "Rewrite the user's follow-up question as ONE self-contained"
                " question that can be researched WITHOUT the conversation."
                "  Resolve pronouns and ellipsis using the conversation;"
                " never answer it, never add facts.  Output ONLY a JSON"
                " object, no prose, no code fences:"
                ' {"question": "<the rewritten question>"} -- or'
                ' {"question": ""} when it is already self-contained.'
                f"  Write in {lang}."
            ),
        },
        {"role": "user", "content": f"<conversation>\n{convo}\n</conversation>\n<follow_up>{question}</follow_up>"},
    ]
    value, usage = jsongate.json_completion(cfg, messages, "standalone_question", _STANDALONE_SCHEMA)
    if usage_out is not None and usage:
        usage_out.append(usage)
    return str((value or {}).get("question") or "").strip()[:300]


def clarify_gate(
    cfg: dict[str, t.Any], question: str, lang: str, mode: str, usage_out: UsageOut = None
) -> dict[str, t.Any] | None:
    """The pre-research human-in-loop gate: one small completion decides
    whether the run should ask the user for direction first (quality:
    only on a genuinely ambiguous request; goal: prefers asking when the
    goal statement lacks a target).  Answers the sanitized question set,
    or None on any failure or a ``no`` -- the run then researches
    directly (fail-open: a broken gate must never block research)."""
    posture = (
        " The request reads as a GOAL the user wants reached: prefer asking"
        " when the target, constraints or success criteria are unstated."
        if mode == "goal"
        else " Ask ONLY when the research direction genuinely depends on the"
        " user's intent and guessing wrong would waste the whole run."
    )
    messages = [
        {
            "role": "system",
            "content": (
                "You are the clarification gate of a deep-research search"
                " engine: decide whether the request needs the user's"
                " direction BEFORE any research begins." + posture + " Broad"
                " informational topics (\"searxng\", \"how do solar panels"
                " work\") do NOT need clarification -- cover their facets"
                " instead.  Ask at most 3 questions; each carries 2-4 short"
                " options (\"single\" = pick one, \"multi\" = pick any) and"
                " the user can always add free text.  Output ONLY a JSON"
                " object, no prose, no code fences: {\"ask\": true, \"intro\":"
                " \"<one sentence on why you ask>\", \"questions\": [{\"q\":"
                " \"<question>\", \"type\": \"single\", \"options\": [\"<short"
                " option>\", ...]}]}  -- or {\"ask\": false} when research can"
                f" start directly.  Write in {lang}."
            ),
        },
        {"role": "user", "content": f"<q>{question}</q>"},
    ]
    value, usage = jsongate.json_completion(cfg, messages, "clarify_gate", _CLARIFY_SCHEMA)
    if usage_out is not None and usage:
        usage_out.append(usage)
    if not value or not value.get("ask"):
        return None
    questions = sanitize_questions(value.get("questions"))
    if not questions:
        return None
    return {"intro": str(value.get("intro") or "").strip()[:200], "questions": questions}


def related_questions(
    cfg: dict[str, t.Any], question: str, answer: str, lang: str, usage_out: UsageOut = None
) -> list[str]:
    """Three follow-up questions for the Related section -- one small
    structured completion after the answer settles; empty on any
    failure."""
    messages = [
        {
            "role": "system",
            "content": (
                "Suggest follow-up questions for a search session. Output ONLY a"
                " JSON object, no prose, no markdown, no code fences:"
                ' {"questions": ["<question 1>", "<question 2>",'
                ' "<question 3>"]} -- exactly 3 short question strings.'
            ),
        },
        {
            "role": "user",
            "content": (
                f"Question: {question}\n\nAnswer given:\n{answer[:1200]}\n\n" f"Language for the questions: {lang}"
            ),
        },
    ]
    value, usage = jsongate.json_completion(cfg, messages, "related_questions", _RELATED_SCHEMA)
    if usage_out is not None and usage:
        usage_out.append(usage)
    items = (value or {}).get("questions")
    if not isinstance(items, list):
        return []
    return [str(item).strip()[:200] for item in items if isinstance(item, str) and item.strip()][:3]
