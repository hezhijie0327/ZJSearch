# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``web_search`` feed's ranking cascade.

Bocha's two-stage ranking cascade applied to the live web results the
researcher's feed is cut from: :py:func:`bm25_order` fuses the engines'
order with BM25 text relevance (the classic page's ``bm25_reranker``
plugin shares its tokenizer and fusion -- one source of truth), then
:py:func:`rerank_order` re-scores the head with the deployment's rerank
provider (``infra.rerank`` -- ``zjsearch.rerank``, ``sdk`` picks the
wire).  Ranking happens BEFORE the reveal, never as a model tool: the
model cannot ask for a rerank of results it was never shown, so the
cascade is mechanical infrastructure like Bocha's Semantic Reranker
stage.  Every stage fails open -- no signal or any error leaves the
previous order standing.  The PROVIDER legs (the Cohere-shaped HTTP wire
and the native DashScope TextReRank) live in :py:mod:`infra.rerank`;
this module is the strategy."""

import logging
import typing as t

import bm25s

from searx.plugins.bm25_reranker import RRF_K, _doc_text, _field, _rrf, cjk_tokenize
from searx.zjsearch.ai.llm import embed as embed_service
from searx.zjsearch.ai.llm import rerank as rerank_service

logger = logging.getLogger(__name__)

RERANK_HEAD = 20
"""How many BM25-ranked results the rerank model re-scores -- a reranker
is a head-precision instrument; the tail keeps its BM25 order behind it."""

RERANK_SNIPPET_CHARS = 400
"""The per-document text sent to the rerank model: title + snippet head
(the same shape the feed line carries -- the model ranks what the model
will read)."""


def bm25_order(query: str, results: list[t.Any]) -> list[int] | None:
    """The BM25 leg: ``results`` ranked by bm25s text relevance, RRF-fused
    with the engine order (BM25 dominates 1.0 vs 0.25 -- the plugin's own
    weights).  Returns a FULL permutation (text-less results keep their
    engine order at the tail) or ``None`` when there is nothing to rank:
    fewer than two documents with text, no query tokens, zero signal."""
    if len(results) < 2:
        return None
    query_tokens = cjk_tokenize(query)
    if not query_tokens:
        return None
    corpus_tokens = [cjk_tokenize(_doc_text(result)) for result in results]
    non_empty = [i for i, tokens in enumerate(corpus_tokens) if tokens]
    if len(non_empty) < 2:
        return None
    retriever = bm25s.BM25()
    retriever.index(corpus_tokens)
    scores = retriever.get_scores(query_tokens)
    # no query term matches any result: BM25 has no signal and the
    # engines' order stands (rewriting on noise would shuffle)
    if float(scores.max()) <= 0:
        return None
    bm25_ranking = sorted(non_empty, key=lambda i: float(scores[i]), reverse=True)
    fused = _rrf([bm25_ranking, list(non_empty)], [1.0, 0.25], RRF_K)
    ranked = set(fused)
    return fused + [i for i in range(len(results)) if i not in ranked]


def rerank_doc(result: t.Any) -> str:
    """One result's document text for the rerank model."""
    title = str(_field(result, "title", "") or "")
    content = str(_field(result, "content", "") or "")
    return f"{title} - {content[:RERANK_SNIPPET_CHARS]}"


def rerank_order(query: str, docs: list[str]) -> tuple[list[int] | None, int]:
    """The rerank-model leg (POLICY): the deployment's rerank provider
    (``infra.rerank`` -- ``zjsearch.rerank``, ``sdk`` picks the wire)
    re-scores ``docs`` against ``query``.  RETURNS ``(order, tokens)`` --
    ``order`` maps rank position -> doc index (a full permutation:
    results the provider dropped trail in their incoming order) and
    ``tokens`` is the billed prompt-token count for the run's account
    (0 when the response carries none).  ``(None, 0)`` on any skip -- the
    feature unconfigured, fewer than two docs -- and the engine order
    stands (fail-open)."""
    if len(docs) < 2:
        return None, 0
    return rerank_service.rerank(query, docs)


# ---------------------------------------------------------------- funnel
# v5's third model joins the cascade: EMBEDDING prunes near-duplicates
# (the one signal a cross-encoder cannot see -- similarity IS its score).
# The per-candidate DECISION gate that once followed was removed with the
# sources_gate feature -- ranking is mechanical, the decision model's
# quality judgments live where the model can invoke them.  Every stage
# fails open.


def diverse_order(docs: list[str], threshold: float) -> list[int] | None:
    """The embedding diversity stage: near-duplicate results (syndicated
    copies, reworded aggregators) cluster away -- a document survives only
    when its best cosine against the ALREADY-KEPT heads stays under
    ``threshold``.  Returns the kept indices in incoming (rerank) order,
    or ``None`` on any skip/failure (unconfigured embedding, empty
    vectors -- the unpruned order stands)."""
    if len(docs) < 2:
        return None
    try:
        batch = embed_service.run_batch(docs, timeout=8.0)
        if not batch:
            return None
        vectors = batch[0]
        if len(vectors) != len(docs) or not vectors[0]:
            return None
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_rank: diversity stage failed: %s", exc)
        return None
    kept: list[int] = []
    reps: list[list[float]] = []
    for index, vector in enumerate(vectors):
        if all(embed_service.cosine(vector, rep) < threshold for rep in reps):
            kept.append(index)
            reps.append(vector)
    return kept
