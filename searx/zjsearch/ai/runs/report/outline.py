# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The report OUTLINE gate: one structured completion turns the (already
clarified) question into the report's section skeleton.  Fail-open: a
dead transport or a malformed skeleton returns ``None`` and the run
falls back to the single-write answer shape."""

import logging
import typing as t

from searx.zjsearch.ai.llm import jsongate
from searx.zjsearch.ai.prompts import report as report_prompts
from searx.zjsearch.ai.prompts import spine

logger = logging.getLogger(__name__)

MAX_SECTIONS = 8
MIN_SECTIONS = 3


def build_outline(
    cfg: dict[str, t.Any], question: str, lang: str, clarified: str, gate_usage: list[dict[str, t.Any]]
) -> dict[str, t.Any] | None:
    """The skeleton: ``{title, subtitle, sections: [{id, title, brief,
    key_questions, status}]}`` -- ids minted here (``s1``...), the
    server-synthesized ``summary`` / ``method`` sections are NOT part of
    the gate's contract.  ``None`` on any failure."""
    system = "\n".join([report_prompts.OUTLINE_SYSTEM, spine.language_directive(lang)])
    user = f"<question>{question[:2000]}</question>"
    if clarified:
        user += f"\n<clarified_direction>{clarified}</clarified_direction>"
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
    return {
        "title": str(value.get("title") or "").strip()[:160] or question[:80],
        "subtitle": str(value.get("subtitle") or "").strip()[:200],
        "sections": sections,
    }
