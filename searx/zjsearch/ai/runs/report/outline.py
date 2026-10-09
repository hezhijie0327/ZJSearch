# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The report OUTLINE gate: one structured completion turns the (already
clarified) question into the report's section skeleton.  Fail-open: a
dead transport or a malformed skeleton returns ``None`` and the run
falls back to the single-write answer shape.

The gate also carries the DELIVERABLE-ENTITY heuristic: the skeleton
comes with the entities the final deliverable depends on understanding
but that no section directly researches (the "opportunities for Cytiva"
case -- the report cannot recommend for an actor it never studied), and
:func:`uncovered_entities` screens them against the sections with the
task card's term matcher (zero model cost)."""

import json
import logging
import typing as t

from searx.zjsearch.ai.llm import jsongate
from searx.zjsearch.ai.prompts import report as report_prompts
from searx.zjsearch.ai.prompts import spine
from searx.zjsearch.ai.runs.search.coverage import Coverage

logger = logging.getLogger(__name__)

MAX_SECTIONS = 8
MIN_SECTIONS = 3

MAX_ENTITIES = 6
"""Deliverable entities per outline -- a handful of blind spots, not a
second research plan."""

_ATTACHMENT_HEAD = 3_000
"""Per-attachment head inside the outline gate's user message: the
attachment may BIND the deliverable's structure (a framework, a house
format), so the skeleton editor must see what the question points at."""


def build_outline(  # pylint: disable=too-many-arguments, too-many-positional-arguments
    cfg: dict[str, t.Any],
    question: str,
    lang: str,
    clarified: str,
    gate_usage: list[dict[str, t.Any]],
    attachments: list[dict[str, str]] | None = None,
) -> dict[str, t.Any] | None:
    """The skeleton: ``{title, subtitle, sections: [{id, title, brief,
    key_questions, status}], entities: [{name, why}]}`` -- ids minted
    here (``s1``...), the server-synthesized ``summary`` / ``method``
    sections are NOT part of the gate's contract.  ``attachments`` ride
    as heads (they may bind the deliverable's structure).  ``None`` on
    any failure."""
    system = "\n".join([report_prompts.OUTLINE_SYSTEM, spine.language_directive(lang)])
    user = f"<question>{question[:2000]}</question>"
    if clarified:
        user += f"\n<clarified_direction>{clarified}</clarified_direction>"
    for file in attachments or []:
        text = str(file.get("text") or "")[:_ATTACHMENT_HEAD]
        if not text:
            continue
        name = str(file.get("name") or "attachment")
        user += f'\n<attachment name="{name}">\n{text}\n</attachment>'
    try:
        value, usage = jsongate.json_completion(
            cfg,
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "report_outline",
            report_prompts.OUTLINE_SCHEMA,
        )
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch report: outline gate failed: %r", exc)
        return None
    if usage:
        gate_usage.append(usage)
    return _parse_outline(value, question)


def _parse_outline(value: t.Any, question: str) -> dict[str, t.Any] | None:
    """The shared skeleton validation (free outline + template
    instantiation land here): sections sanitized and id-stamped, the
    deliverable entities capped."""
    if not isinstance(value, dict):
        return None
    raw_sections = value.get("sections")
    if not isinstance(raw_sections, list):
        return None
    sections: list[dict[str, t.Any]] = []
    for raw in raw_sections[:MAX_SECTIONS]:
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or "").strip()[:120]
        brief = str(raw.get("brief") or "").strip()[:300]
        if not title:
            continue
        questions = [str(q).strip()[:200] for q in (raw.get("key_questions") or []) if str(q).strip()][:3]
        sections.append(
            {
                "id": f"s{len(sections) + 1}",
                "title": title,
                "brief": brief,
                "key_questions": questions,
                "status": "pending",
            }
        )
    if len(sections) < MIN_SECTIONS:
        return None
    entities: list[dict[str, str]] = []
    for raw in value.get("entities") or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()[:80]
        if not name:
            continue
        entities.append({"name": name, "why": str(raw.get("why") or "").strip()[:200]})
        if len(entities) >= MAX_ENTITIES:
            break
    return {
        "title": str(value.get("title") or "").strip()[:160] or question[:80],
        "subtitle": str(value.get("subtitle") or "").strip()[:200],
        "sections": sections,
        "entities": entities,
    }


def parse_template(payload: t.Any) -> dict[str, t.Any] | None:
    """The sanitized report TEMPLATE out of the request payload (the
    client carries presets AND user-defined templates in the body -- the
    server stays stateless): ``{name, sections: [{title, brief?,
    key_questions?, optional?}]}``, 2-10 sections.  ``None`` on any
    malformed shape (the run falls back to the free outline)."""
    if not isinstance(payload, dict):
        return None
    raw_sections = payload.get("sections")
    if not isinstance(raw_sections, list) or not (2 <= len(raw_sections) <= 10):
        return None
    sections: list[dict[str, t.Any]] = []
    for raw in raw_sections:
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or "").strip()[:120]
        if not title:
            continue
        sections.append(
            {
                "title": title,
                "brief": str(raw.get("brief") or "").strip()[:300],
                "key_questions": [str(q).strip()[:200] for q in (raw.get("key_questions") or []) if str(q).strip()][:3],
                "optional": bool(raw.get("optional")),
            }
        )
    if len(sections) < 2:
        return None
    return {
        "name": str(payload.get("name") or "").strip()[:80] or "template",
        "sections": sections,
    }


def build_outline_from_template(  # pylint: disable=too-many-arguments, too-many-positional-arguments
    cfg: dict[str, t.Any],
    question: str,
    lang: str,
    clarified: str,
    template: dict[str, t.Any],
    gate_usage: list[dict[str, t.Any]],
    attachments: list[dict[str, str]] | None = None,
) -> dict[str, t.Any] | None:
    """The TEMPLATE instantiation gate: one structured completion adapts
    the fixed skeleton to THIS question (entity names into the titles,
    briefs sharpened, optional sections dropped) -- the structure is the
    user's contract, the wording is the desk's.  Same fail-open + same
    output shape as :func:`build_outline`."""
    system = "\n".join([report_prompts.TEMPLATE_ADAPT_SYSTEM, spine.language_directive(lang)])
    user = f"<question>{question[:2000]}</question>"
    if clarified:
        user += f"\n<clarified_direction>{clarified}</clarified_direction>"
    template_json = json.dumps({"name": template["name"], "sections": template["sections"]}, ensure_ascii=False)
    user += f"\n<template name=\"{template['name']}\">\n{template_json[:6000]}\n</template>"
    for file in attachments or []:
        text = str(file.get("text") or "")[:_ATTACHMENT_HEAD]
        if not text:
            continue
        user += f'\n<attachment name="{file.get("name") or "attachment"}">\n{text}\n</attachment>'
    try:
        value, usage = jsongate.json_completion(
            cfg,
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "report_outline_template",
            report_prompts.OUTLINE_SCHEMA,
        )
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch report: template outline gate failed: %r", exc)
        return None
    if usage:
        gate_usage.append(usage)
    return _parse_outline(value, question)


def uncovered_entities(outline: dict[str, t.Any]) -> list[str]:
    """The outline's deliverable entities NO section covers -- the
    task card's own bidirectional-containment matcher applied to
    entity-vs-section (title + brief + key_questions) terms, zero model
    cost.  An entity whose name light up any section's text counts as
    covered (the section will research it)."""
    sections = outline.get("sections") or []
    section_terms: list[str] = []
    for sec in sections:
        section_terms.extend(
            Coverage.match_terms(" ".join([str(sec.get("title") or ""), str(sec.get("brief") or ""), *[
                str(q) for q in (sec.get("key_questions") or [])
            ]]))
        )
    uncovered: list[str] = []
    for entity in outline.get("entities") or []:
        name = str(entity.get("name") or "")
        if not name:
            continue
        terms = Coverage.match_terms(name)
        if not terms:
            continue
        hit = any(a in b or b in a for a in terms for b in section_terms)
        if not hit:
            uncovered.append(name)
    return uncovered
