# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``web_search`` feed's ranking cascade.

Bocha's two-stage ranking cascade applied to the live web results the
researcher's feed is cut from: :py:func:`bm25_order` fuses the engines'
order with BM25 text relevance (the classic page's ``bm25_reranker``
plugin shares its tokenizer and fusion -- one source of truth), then
:py:func:`rerank_order` re-scores the head with the deployment's rerank
model (``zjsearch.rerank``, the Cohere-shaped ``/rerank`` endpoint).
Ranking happens BEFORE the reveal, never as a model tool: the model
cannot ask for a rerank of results it was never shown, so the cascade is
mechanical infrastructure like Bocha's Semantic Reranker stage.  Every
stage fails open -- no signal or any error leaves the previous order
standing.
"""

import logging
import typing as t

import bm25s
import httpx

from searx.plugins.bm25_reranker import RRF_K, _doc_text, _field, _rrf, cjk_tokenize
from searx.zjsearch.ai.infra import config as llm_config

logger = logging.getLogger(__name__)

RERANK_HEAD = 20
"""How many BM25-ranked results the rerank model re-scores -- a reranker
is a head-precision instrument; the tail keeps its BM25 order behind it."""

RERANK_SNIPPET_CHARS = 400
"""The per-document text sent to the rerank model: title + snippet head
(the same shape the feed line carries -- the model ranks what the model
will read)."""

_RERANK_TIMEOUT = httpx.Timeout(connect=2.0, read=4.0, write=2.0, pool=2.0)
"""One search's rerank call sits on the research round's critical path:
a dead endpoint must cost seconds, not the round."""


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


def rerank_order(query: str, docs: list[str]) -> tuple[list[int] | None, int]:  # pylint: disable=too-many-branches
    """The rerank-model leg: the deployment's ``zjsearch.rerank`` endpoint
    re-scores ``docs`` against ``query``.  RETURNS ``(order, tokens)`` --
    ``order`` maps rank position -> doc index (a full permutation: results
    the endpoint dropped trail in their incoming order) and ``tokens`` is
    the response's prompt-token count for the run's account (0 when the
    response carries none).  ``(None, 0)`` on any skip -- the feature
    unconfigured, a timeout, a non-200, a malformed body -- and the
    previous order stands (fail-open, one debug line)."""
    cfg = llm_config.rerank_cfg()
    if not cfg.get("enabled") or not cfg.get("base_url") or not cfg.get("model"):
        return None, 0
    if len(docs) < 2:
        return None, 0
    key = llm_config.rerank_key(cfg)
    url = str(cfg["base_url"]).rstrip("/") + "/rerank"
    body: dict[str, t.Any] = {"model": str(cfg["model"]), "query": query, "documents": docs, "top_n": len(docs)}
    extra_body = llm_config.extra_body(cfg)
    if extra_body:
        body.update(extra_body)
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    extra_headers = llm_config.extra_headers(cfg)
    if extra_headers:
        headers.update(extra_headers)
    try:
        response = httpx.post(url, json=body, headers=headers, timeout=_RERANK_TIMEOUT)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch rerank: endpoint failed, keeping the previous order: %r", exc)
        return None, 0
    ranked = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(ranked, list) or not ranked:
        logger.debug("zjsearch rerank: malformed response, keeping the previous order")
        return None, 0
    order: list[int] = []
    for item in ranked:
        try:
            index = int(item["index"])
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= index < len(docs) and index not in order:
            order.append(index)
    if not order:
        logger.debug("zjsearch rerank: no usable indices, keeping the previous order")
        return None, 0
    order += [i for i in range(len(docs)) if i not in set(order)]
    tokens = 0
    usage = payload.get("usage")
    if isinstance(usage, dict):
        try:
            tokens = int(usage.get("prompt_tokens") or 0)
        except (TypeError, ValueError):
            tokens = 0
    return order, tokens
