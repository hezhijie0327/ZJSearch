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

from searx.zjsearch.ai.llm import jsongate

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

_EXTEND_SCHEMA: dict[str, t.Any] = {
    "type": "object",
    "properties": {
        "extend": {"type": "boolean"},
        "rounds": {"type": "integer"},
        "reason": {"type": "string"},
    },
    "required": ["extend"],
    "additionalProperties": False,
}


def extend_budget_gate(
    cfg: dict[str, t.Any],
    question: str,
    rounds: int,
    facts: list[dict[str, t.Any]],
    gaps: list[dict[str, t.Any]],
    account: t.Any = None,
) -> tuple[int, str]:
    """The budget tail's extension gate -- the model-judged OTHER END of
    the depth probe: the probe sizes the run at START from the question's
    apparent complexity, this one judges at the TAIL from what the
    research actually found.  ONE structured completion over the ledger's
    live state: genuinely mid-flight research with material open gaps
    earns more rounds; a closed ledger (or one the gathered facts already
    answer) wraps to the writer.  Returns ``(extra_rounds, reason)`` --
    ``(0, "")`` on any skip/failure: fail-open wraps the run, never
    blocks it.  The caller clamps ``extra`` by mode."""
    open_gaps = [str(g.get("q") or "").strip() for g in gaps if g.get("status") == "open" and g.get("q")]
    active_facts = sum(1 for f in facts if f.get("status") == "active")
    gap_lines = "\n".join(f"- gap: {gap}" for gap in open_gaps) or "- (no open gaps)"
    ledger = f"{gap_lines}\n- established facts: {active_facts}\n- research rounds spent: {rounds}"
    messages = [
        {
            "role": "system",
            "content": (
                "You are the budget gate of an AI research run: the run's"
                " research budget just ran out and you decide whether it"
                " extends.  Extend ONLY when the ledger's open gaps are"
                " genuinely material to the question AND live searching is"
                " visibly mid-flight (recent rounds kept yielding new"
                " sources) -- more rounds must buy real answer quality, not"
                " polish.  Wrap (extend=false) when the gathered facts"
                " already answer the question, the gaps are nice-to-have,"
                " or the rounds have gone stale.  When extending, size the"
                " grant to what the gaps actually need (a couple of rounds"
                " per material gap, never a blanket doubling).  Output ONLY"
                ' a JSON object: {"extend": true, "rounds": <int>,'
                ' "reason": "<one line>"} or {"extend": false, "reason":'
                ' "<one line>"}.'
            ),
        },
        {"role": "user", "content": f"<q>{question}</q>\n<ledger>\n{ledger}\n</ledger>"},
    ]
    value, _usage = jsongate.json_completion(cfg, messages, "extend_budget", _EXTEND_SCHEMA, account=account)
    if not value or not isinstance(value.get("extend"), bool) or not value["extend"]:
        return 0, ""
    try:
        extra = int(value.get("rounds") or 0)
    except (TypeError, ValueError):
        return 0, ""
    return max(1, min(extra, 24)), str(value.get("reason") or "").strip()[:300]


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


def research_gate(cfg: dict[str, t.Any], question: str, account: t.Any = None) -> bool:
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
                " with live, cited sources.  A request that points at the"
                " user's OWN saved material (their knowledge base, their past"
                " research, an uploaded file) ALSO needs research: the"
                " research loop carries the recall tools that reach it."
                "  Output ONLY a JSON object, no"
                ' prose, no code fences: {"research": true} or {"research":'
                ' false}.'
            ),
        },
        {"role": "user", "content": f"<q>{question}</q>"},
    ]
    value, _usage = jsongate.json_completion(cfg, messages, "research_gate", _RESEARCH_SCHEMA, account=account)
    if not value or not isinstance(value.get("research"), bool):
        return True
    return value["research"]


def standalone_question(
    cfg: dict[str, t.Any], question: str, history: list[dict[str, str]], lang: str, account: t.Any = None
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
    value, _usage = jsongate.json_completion(cfg, messages, "standalone_question", _STANDALONE_SCHEMA, account=account)
    return str((value or {}).get("question") or "").strip()[:300]


def clarify_gate(
    cfg: dict[str, t.Any],
    question: str,
    lang: str,
    account: t.Any = None,
    attachments_note: str = "",
) -> dict[str, t.Any] | None:
    """The pre-research human-in-loop gate: one small completion decides
    whether the run should ask the user for direction first (ask ONLY when
    the direction genuinely depends on the user's intent, and ALWAYS on a
    high-stakes deliverable whose assumptions change the answer).  Answers
    the sanitized question set, or None on any failure or a ``no`` -- the
    run then researches directly (fail-open: a broken gate must never
    block research)."""
    posture = (
        " Ask ONLY when the research direction genuinely depends on the"
        " user's intent and guessing wrong would waste the whole run."
    )
    messages = [
        {
            "role": "system",
            "content": (
                "You are the clarification gate of a deep-research search"
                " engine: decide whether the request needs the user's"
                " direction BEFORE any research begins." + posture + " One"
                " class always justifies asking: a HIGH-STAKES deliverable"
                " whose assumptions change the answer -- a forecast, an"
                " investment, purchase, health or legal question -- where"
                " the user's situation (timeline, risk appetite, existing"
                " holdings) is unknowable from the question alone.  Broad"
                ' informational topics ("how do solar panels work",'
                ' "history of jazz") do NOT need clarification -- cover'
                " their facets"
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
        {"role": "user", "content": f"<q>{question}</q>{attachments_note}"},
    ]
    value, _usage = jsongate.json_completion(cfg, messages, "clarify_gate", _CLARIFY_SCHEMA, account=account)
    if not value or not value.get("ask"):
        return None
    questions = sanitize_questions(value.get("questions"))
    if not questions:
        return None
    return {"intro": str(value.get("intro") or "").strip()[:200], "questions": questions}


def generate_title(
    cfg: dict[str, t.Any],
    question: str,
    answer: str,
    lang: str,
    outline_title: str | None = None,
    account: t.Any = None,
) -> str | None:
    """The settle-tail's TITLE generation (the fallback when the writer's
    own fence title is missing or failed the decision gate): one small
    completion returns a short noun phrase -- ``None`` on any failure
    (the client keeps its mechanical derive)."""
    hint = f"\nThe report document is titled: {outline_title} (stay consistent with it)." if outline_title else ""
    messages = [
        {
            "role": "system",
            "content": (
                "Name a research thread. Output ONLY a JSON object, no prose,"
                " no markdown, no code fences:"
                ' {"title": "<title>"} -- ONE short noun phrase (8-20'
                " characters) in the question's language, specific to the"
                ' subject: not generic ("research report", "survey"), not a'
                " question, no quotes, no trailing punctuation."
            ),
        },
        {
            "role": "user",
            "content": f"Question: {question}\n\nAnswer head:\n{answer[:800]}{hint}\n\nLanguage: {lang}",
        },
    ]
    try:
        value, _usage = jsongate.json_completion(cfg, messages, "thread_title", {"type": "object"}, account=account)
    except Exception:  # pylint: disable=broad-except
        return None
    title = str((value or {}).get("title") or "").strip().strip('"“”')
    return title[:40] or None


def related_questions(cfg: dict[str, t.Any], question: str, answer: str, lang: str, account: t.Any = None) -> list[str]:
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
    value, _usage = jsongate.json_completion(cfg, messages, "related_questions", _RELATED_SCHEMA, account=account)
    items = (value or {}).get("questions")
    if not isinstance(items, list):
        return []
    return [str(item).strip()[:200] for item in items if isinstance(item, str) and item.strip()][:3]
