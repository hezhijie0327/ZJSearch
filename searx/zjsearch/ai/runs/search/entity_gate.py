# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The deliverable-ENTITY gate (the single-write counterpart of the
report outline's ``entities`` screen).

A request like "build the recommendation for Cytiva on RCX's pipelines"
decomposes naturally into facets about RCX -- the plan never studies
Cytiva itself, and the answer recommends for an actor it never
researched.  On the FIRST ``task_write`` this gate (fail-open
everywhere) extracts the deliverable entities from question +
attachment heads (one small json completion), screens them against the
plan's subtask titles with the task card's term matcher (zero model
cost), and -- for the uncovered ones -- fills
``state.deliverable_entities`` (the plan_review's ``plan_complete``
question and the next rounds' follow-through read it) and returns a
feed note telling the model to close the gap itself (add subtasks or
delegate ``research_subtask`` -- the harness shows the blind spot, the
model owns the plan)."""

import logging
import time
import typing as t

from searx.zjsearch.ai.llm import decision, jsongate
from searx.zjsearch.ai.runs.search.coverage import Coverage

logger = logging.getLogger(__name__)

MAX_ENTITIES = 4
"""Extraction cap for the single-write pass (the report outline allows
more; a chat-shaped answer rests on fewer external actors)."""

_ATTACH_HEAD = 2_000
"""Per-attachment head inside the extraction prompt."""

_EXTRACT_SYSTEM = (
    "Extract from the research request the DELIVERABLE ENTITIES: up to"
    " 4 named entities the final answer will make claims or"
    " recommendations ABOUT, but that the request does not directly ask"
    " to research -- a counterpart, competitor, customer, technology or"
    " market the recommendations rest on (when the request asks for"
    " \"opportunities for X\", X itself belongs here unless one of the"
    " subtasks already studies X).  Only entities a web search could"
    " profile; skip generic concepts.  Respond with ONLY:"
    ' {"entities": [{"name": "...", "why": "..."}, ...]}'
)

_EXTRACT_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "entities": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "why": {"type": "string"}},
                "required": ["name"],
            },
        }
    },
    "required": ["entities"],
}


def _extract(
    cfg: dict[str, t.Any], question: str, attached_files: list[dict[str, str]], gate_usage: list[dict[str, t.Any]]
) -> list[dict[str, str]]:
    """One small json completion: the deliverable entities of this
    request.  ``[]`` on any failure (fail-open)."""
    user = f"<question>{question[:1500]}</question>"
    for file in attached_files or []:
        text = str(file.get("text") or "")[:_ATTACH_HEAD]
        if text:
            user += f'\n<attachment name="{file.get("name") or "attachment"}">\n{text}\n</attachment>'
    try:
        value, usage = jsongate.json_completion(
            cfg,
            [{"role": "system", "content": _EXTRACT_SYSTEM}, {"role": "user", "content": user}],
            "deliverable_entities",
            _EXTRACT_SCHEMA,
        )
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch entity_gate: extraction failed: %r", exc)
        return []
    if usage:
        gate_usage.append(usage)
    out: list[dict[str, str]] = []
    for raw in (value or {}).get("entities") or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()[:80]
        if name:
            out.append({"name": name, "why": str(raw.get("why") or "").strip()[:200]})
        if len(out) >= MAX_ENTITIES:
            break
    return out


def _uncovered(entities: list[dict[str, str]], task_titles: list[str]) -> list[str]:
    """Entity names no subtask title comes near (the task card's own
    bidirectional-containment matcher -- the same matcher provenance
    uses)."""
    plan_terms: list[str] = []
    for title in task_titles:
        plan_terms.extend(Coverage.match_terms(title))
    out: list[str] = []
    for entity in entities:
        terms = Coverage.match_terms(str(entity.get("name") or ""))
        if not terms:
            continue
        if not any(a in b or b in a for a in terms for b in plan_terms):
            out.append(str(entity.get("name") or ""))
    return out


def run_once(state: t.Any, items: list[dict[str, str]]) -> str | None:
    """The handlers' task_write hook: ONCE per run, extract + screen +
    note.  Returns the feed note for uncovered entities (``None`` when
    everything is covered or the gate is skipped)."""
    if getattr(state, "entity_gate_done", False):
        return None
    state.entity_gate_done = True
    question = str(getattr(state, "question_held", "") or "")
    if not question:
        return None
    started = time.monotonic()
    entities = _extract(state.cfg, question, list(getattr(state, "attached_files", []) or []), state.gate_usage)
    if not entities:
        return None
    uncovered = _uncovered(entities, [str(item.get("title") or "") for item in items])
    state.deliverable_entities = uncovered
    names = [str(entity.get("name") or "") for entity in entities]
    state.judgments.append(
        {
            "purpose": "entity_coverage",
            "question": "Deliverable entities the answer makes claims about; screened against the plan",
            "target": " / ".join(names)[:200],
            "entities": names,
            "uncovered": uncovered,
            "ms": int((time.monotonic() - started) * 1000),
        }
    )
    if not uncovered:
        return None
    return (
        "\n(deliverable coverage: the final answer will make claims about "
        + "; ".join(uncovered[:3])
        + " -- NO subtask researches them. Add a subtask for each via task_write"
        " (or delegate a research_subtask): their basic sourced facts must be"
        " among the gathered sources before the research ends.)"
    )
