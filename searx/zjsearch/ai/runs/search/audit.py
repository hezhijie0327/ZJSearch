# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

"""AI Search: the LEDGER's consistency scan -- is a new finding at odds
with what the run already established?

:py:func:`finding_conflict` -- a new ledger fact vs the established ones
(embedding nearest-neighbour recall above a similarity floor, then one
consistency noul).  Fail-open (``None`` on any skip): the scan is a
lens, not a dependency.  The PROVIDER calls ride :py:mod:`llm.embed`
+ :py:mod:`llm.decision` directly (no tools, no model turns).

(The per-citation POST-WRITE audit that once lived here -- the writer's
[n] marks graded against their sources -- was removed with its phase:
the PRE-WRITE evidence check already gates what the writer leans on,
and a verdict that arrives after the answer can only badge, never fix.)
"""

import logging

from searx.zjsearch.ai.llm import decision as decision_service
from searx.zjsearch.ai.llm import embed as embed_service

logger = logging.getLogger(__name__)

AUDIT_TIMEOUT = 5.0
"""One conflict call's budget (the decision model answers in ~100ms)."""

CONFLICT_SIMILARITY = 0.82
"""The embedding similarity above which two facts are ABOUT the same
thing -- only there does a consistency judgment mean anything."""

DEDUP_SIMILARITY = 0.92
"""The near-duplicate floor (the memory-dedup threshold): two ledger
facts this alike read as one fact rephrased -- the second is dropped and
its refs merge into the survivor."""


def near_duplicate(text: str, established: list[str]) -> int | None:
    """The established fact ``text`` duplicates (its 0-based index), or
    ``None``: embedding nearest-neighbour above :py:data:`DEDUP_SIMILARITY`
    -- the small-model pathology where one fact is rephrased three ways
    ends here instead of tripling the ledger.  Embedding-only (no
    decision call), fail-open."""
    if not (text and established and embed_service.enabled() and embed_service.configured()):
        return None
    try:
        batch = embed_service.run_batch([text] + list(established), timeout=8.0)
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch_audit: ledger dedup embed failed: %s", exc)
        return None
    if not batch or len(batch[0]) != len(established) + 1:
        return None
    vectors = batch[0]
    probe = vectors[0]
    best = max(range(len(established)), key=lambda i: embed_service.cosine(probe, vectors[i + 1]))
    if embed_service.cosine(probe, vectors[best + 1]) < DEDUP_SIMILARITY:
        return None
    return best


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
        out = decision_service.judge(
            {"new_fact": fact_text, "established_fact": established[best]},
            {
                "consistent": {
                    "type": "noul",
                    "instructions": ("Are the new fact and the established fact consistent (both can be true)?"),
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
