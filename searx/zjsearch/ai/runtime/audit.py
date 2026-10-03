# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

"""AI Search: the audit phase's strategies -- the run's TRUST surface.

Three judgments, all fail-open (``None``/empty on any skip -- the audit
is a lens, not a dependency):

- :py:func:`citation_verdicts` -- the writer's [n] citations checked
  against their sources (the rerank cross-encoder pre-filters the pairs
  a decision call is worth; the survivors grade
  supports/contradicts/says_nothing with confidence);
- :py:func:`finding_conflict` -- a new ledger fact vs the established
  ones (embedding nearest-neighbour recall above a similarity floor,
  then one consistency noul);
- :py:func:`subtask_gaps` -- the completeness read: which open subtasks
  the ANSWER actually covered (one noul per task over the answer text)
  -- the re-entry loop's input.

The PROVIDER calls ride :py:mod:`infra.rerank` + :py:mod:`infra.decision`
directly (no tools, no model turns): the audit is mechanical
infrastructure like the ranking cascade -- it fixes the verdicts ABOUT
things already shown, it never researches.
"""

import concurrent.futures
import logging
import re
import typing as t

from searx.zjsearch.ai.infra import decision as decision_service
from searx.zjsearch.ai.infra import embed as embed_service
from searx.zjsearch.ai.infra import rerank as rerank_service

logger = logging.getLogger(__name__)

CITE_RE = re.compile(r"\[(\d{1,3})\]")
"""The citation mark: the answer grammar's global [n]."""

_SENTENCE_RE = re.compile(r"(?<=[.。！？!?])\s+")
"""Sentence split for the claim extraction (CJK periods included)."""

CLAIM_MAX = 12
"""Citations audited per run -- the load-bearing head, not every mark."""

AUDIT_TIMEOUT = 5.0
"""One audit call's budget (the decision model answers in ~100ms)."""

CONFLICT_SIMILARITY = 0.82
"""The embedding similarity above which two facts are ABOUT the same
thing -- only there does a consistency judgment mean anything."""

_AUTO_ACCEPT = 0.50
"""Confidence floor: at/above it the verdict stands on its own, below it
the citation renders as ``unverified`` (the model was torn)."""


def _has_cjk(text: str) -> bool:
    return bool(re.search(r"[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f]", text))


def _relation_question(is_zh: bool) -> dict[str, t.Any]:
    """The citation relation's choice question, in the answer's own
    language (the decision model grades best in the material's)."""
    if is_zh:
        return {
            "type": "choice",
            "instructions": "这段话是否被来源支持？",
            "criteria": {
                "supports": "来源明确陈述或支持该说法",
                "contradicts": "来源与该说法相矛盾",
                "says_nothing": "来源未谈及该说法",
            },
        }
    return {
        "type": "choice",
        "instructions": "Is the claim supported by this source passage?",
        "criteria": {
            "supports": "The passage states or supports the claim",
            "contradicts": "The passage contradicts the claim",
            "says_nothing": "The passage does not address the claim",
        },
    }


def _passes_prefloor(claim: str, passage: str) -> bool:
    """The cross-encoder pre-floor: does the source passage even loosely
    match the claim?  A pair the reranker cannot match at all never
    addressed the claim -- graded ``unsupported`` WITHOUT spending a
    decision call.  ``True`` when the rerank service is unconfigured
    (no pre-floor -- every pair goes to the judge)."""
    if not rerank_service.configured():
        return True
    try:
        order, _tokens = rerank_service.rerank(claim, [passage])
    except Exception:  # pylint: disable=broad-except
        return True
    return order == [1]


def _grade_relation(claim: str, passage: str, is_zh: bool) -> tuple[str, float] | None:
    """One claim-vs-passage ``choice`` judgment ->
    ``(verdict, confidence)``; ``None`` on any failure (the citation
    simply goes unaudited -- no badge, no invented verdict)."""
    try:
        out = decision_service.judge(
            {"claim": claim, "source": passage},
            {"relation": _relation_question(is_zh)},
            timeout=AUDIT_TIMEOUT,
        )
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch_audit: citation judgment failed: %s", exc)
        return None
    answers = out.get("answers") if isinstance(out, dict) else None
    relation = answers.get("relation") if isinstance(answers, dict) else None
    if not isinstance(relation, dict) or not relation.get("choice"):
        return None
    confidence = float(relation.get("confidence") or 0.0)
    if confidence < _AUTO_ACCEPT:
        return "unverified", confidence
    verdict = {
        "supports": "verified",
        "contradicts": "contradicted",
        "says_nothing": "unsupported",
    }.get(str(relation["choice"]), "unverified")
    return verdict, confidence


def citation_verdicts(
    answer: str,
    sources: dict[int, dict[str, str]],
) -> dict[int, dict[str, t.Any]]:
    """Every cited [n]'s verdict against its source: the claim (the
    sentence carrying the mark) rides the rerank pre-floor, the
    survivors get one ``choice`` judgment (supports / contradicts /
    says_nothing).  Returns ``{n: {verdict, confidence}}`` with verdict
    in ``verified | contradicted | unsupported | unverified``; an empty
    dict on any skip (both models off -- the badges simply do not
    render)."""
    if not answer or not sources:
        return {}
    if not decision_service.enabled() or not decision_service.configured():
        return {}
    claims: dict[int, str] = {}
    for sentence in _SENTENCE_RE.split(answer):
        for match in CITE_RE.finditer(sentence):
            n = int(match.group(1))
            if n in sources and n not in claims:
                claims[n] = sentence.strip()[:400]
    is_zh = _has_cjk(answer)
    verdicts: dict[int, dict[str, t.Any]] = {}
    for n, claim in list(claims.items())[:CLAIM_MAX]:
        source = sources[n]
        passage = f"{source.get('title', '')} - {source.get('snippet', '')}"[:800]
        if not _passes_prefloor(claim, passage):
            verdicts[n] = {"verdict": "unsupported", "confidence": 0.0}
            continue
        graded = _grade_relation(claim, passage, is_zh)
        if graded is not None:
            verdicts[n] = {"verdict": graded[0], "confidence": graded[1]}
    return verdicts


def _nearest_fact(fact_text: str, established: list[str]) -> int | None:
    """The established fact most similar to the new one (its index), or
    ``None`` below the similarity floor -- distant facts cannot
    conflict, so no judgment is spent on them."""
    batch = embed_service.run_batch([fact_text] + list(established), timeout=8.0)
    if not batch or len(batch[0]) != len(established) + 1:
        return None
    vectors = batch[0]
    probe = vectors[0]
    best = max(range(len(established)), key=lambda i: embed_service.cosine(probe, vectors[i + 1]))
    if embed_service.cosine(probe, vectors[best + 1]) < CONFLICT_SIMILARITY:
        return None
    return best


def finding_conflict(fact_text: str, established: list[str]) -> int | None:
    """The established fact this NEW fact most likely contradicts (its
    0-based index), or ``None``: embedding recall finds the nearest
    neighbour, then ONE consistency noul decides.  The caller records
    the ⚡ pair on the findings card."""
    gates = (
        bool(fact_text)
        and bool(established)
        and embed_service.enabled()
        and embed_service.configured()
        and decision_service.enabled()
        and decision_service.configured()
    )
    if not gates:
        return None
    try:
        best = _nearest_fact(fact_text, established)
        if best is None:
            return None
        is_zh = _has_cjk(fact_text)
        out = decision_service.judge(
            {"new_fact": fact_text, "established_fact": established[best]},
            {
                "consistent": {
                    "type": "noul",
                    "instructions": (
                        "新说法与已有事实是否一致（可以同真）？"
                        if is_zh
                        else "Are the new fact and the established fact consistent (both can be true)?"
                    ),
                }
            },
            timeout=AUDIT_TIMEOUT,
        )
        answers = out.get("answers") if isinstance(out, dict) else None
        consistent = answers.get("consistent") if isinstance(answers, dict) else None
        # conflict = the consistency noul firmly NEGATIVE; anything else
        # (torn, failed, malformed) leaves the ledger unflagged
        if isinstance(consistent, dict) and float(consistent.get("noul") or 1.0) < 0.35:
            return best
        return None
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch_audit: conflict scan failed: %s", exc)
        return None


def subtask_gaps(answer: str, open_tasks: list[str]) -> list[str]:
    """The open subtasks the ANSWER does not actually cover (one noul per
    task over the answer text, judged in parallel threads) -- the
    re-entry loop's缺口清单.  Unjudgable tasks (upstream failure) count
    as covered: the audit never invents work."""
    if not answer or not open_tasks:
        return []
    if not decision_service.enabled() or not decision_service.configured():
        return []
    is_zh = _has_cjk(answer)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        judged = list(
            pool.map(
                lambda task: _covered(answer, task, is_zh),
                open_tasks[:6],
            )
        )
    return [task for task, covered in zip(open_tasks[:6], judged) if not covered]


def _covered(answer: str, task: str, is_zh: bool) -> bool:
    """One subtask's coverage noul (``True`` = the answer covers it; a
    failed judgment counts as covered -- fail-open)."""
    try:
        out = decision_service.judge(
            {"answer_head": answer[:6000], "subtask": task},
            {
                "covered": {
                    "type": "noul",
                    "instructions": (
                        "这份回答是否实质回应了该子课题（给出了事实、数据或明确结论）？"
                        if is_zh
                        else "Does this answer substantively address the subtask (facts, data, or a clear conclusion)?"
                    ),
                }
            },
            timeout=AUDIT_TIMEOUT,
        )
        answers = out.get("answers") if isinstance(out, dict) else None
        covered = answers.get("covered") if isinstance(answers, dict) else None
        if not isinstance(covered, dict):
            return True
        return float(covered.get("noul") or 1.0) >= 0.45
    except Exception:  # pylint: disable=broad-except
        return True
