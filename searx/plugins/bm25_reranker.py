# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
# pylint: disable=missing-module-docstring

import logging
import re
import typing as t

import bm25s
from flask_babel import gettext

from . import Plugin, PluginInfo

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Request  # pylint: disable=ungrouped-imports
    from searx.plugins import PluginCfg  # pylint: disable=ungrouped-imports
    from searx.search import SearchWithPlugins

logger = logging.getLogger("searx.plugins.bm25_reranker")

TOKEN_RE = re.compile(r"[a-z0-9_]+|[\u2e80-\u9fff\uff00-\uffef]")
"""CJK-aware tokenization: each CJK character counts on its own (word
boundaries do not exist in han text), latin/digit runs stay words -- the
same rule the theme's client-side embedder uses."""

TITLE_WEIGHT = 2
"""Title tokens are repeated this many times in the indexed document (a
match in the title is worth more than one in the body)."""

RRF_K = 60
"""RRF constant (the standard value from Cormack et al.) -- dampens the
head of the two rankings before fusion."""


def cjk_tokenize(text: str) -> list[str]:
    tokens = []
    for match in TOKEN_RE.finditer(text.lower()):
        tokens.append(match.group())
    return tokens


def _field(result: t.Any, field: str, default: t.Any = None) -> t.Any:
    """One result field, safe across both result shapes: MainResult is a
    msgspec Struct (bracket access, no ``.get``), LegacyResult is a dict.
    Unset fields return the default."""
    try:
        value = result[field]
    except (KeyError, IndexError, TypeError):
        return getattr(result, field, default)
    return default if value is None else value


def _doc_text(result: t.Any) -> str:
    """The indexed text of one result: title tokens (weighted) + content
    tokens."""
    title = " ".join(cjk_tokenize(str(_field(result, "title", ""))))
    content = " ".join(cjk_tokenize(str(_field(result, "content", ""))))
    return " ".join([title] * TITLE_WEIGHT + [content])


def _get_positions(result: t.Any) -> list[int]:
    positions = _field(result, "positions", [])
    return positions if positions else [1]


class SXNGPlugin(Plugin):
    """Rerank the merged results by BM25 text relevance (bm25s), fused
    with the engines' own ranking through reciprocal rank fusion."""

    id = "bm25_reranker"

    def __init__(self, plg_cfg: PluginCfg) -> None:
        super().__init__(plg_cfg)
        self.info = PluginInfo(
            id=self.id,
            name=gettext("BM25 Reranker"),
            description=gettext("Reranks search results using BM25 text relevance scoring with RRF fusion."),
            preference_section="general",
        )

    def post_search(self, request: SXNG_Request, search: SearchWithPlugins) -> None:
        """Runs after the engine fan-out and BEFORE the result container
        closes: rewriting each result's ``positions`` here feeds the score
        formula (``weight / position``), so the final order blends the
        engines' ranking with BM25's text relevance.  Results without any
        text keep their engine order."""
        results_map = search.result_container.main_results_map
        if len(results_map) < 2:
            return None
        query = search.search_query.query
        if not query or not query.strip():
            return None
        try:
            self._rerank(query, list(results_map.values()))
        except Exception:  # pylint: disable=broad-except
            logger.exception("BM25 reranking failed -- keeping the engine order")
        return None

    def _rerank(self, query: str, results: list[t.Any]) -> None:
        query_tokens = cjk_tokenize(query)
        if not query_tokens:
            return None

        # corpus: one pre-tokenized document per result (title weighted)
        corpus_tokens = [cjk_tokenize(_doc_text(result)) for result in results]
        non_empty = [i for i, tokens in enumerate(corpus_tokens) if tokens]
        if len(non_empty) < 2:
            return None

        retriever = bm25s.BM25()
        retriever.index(corpus_tokens)
        scores = retriever.get_scores(cjk_tokenize(" ".join(query_tokens)))

        # no query term matches any result: BM25 has no signal and the
        # engines' order stands (rewriting on noise would shuffle)
        if float(scores.max()) <= 0:
            return None  # engine order stands

        # rankings as (result index) lists, best first: BM25's score order
        # DOMINATES the fusion (1.0 vs 0.5) -- a reranker that only ties
        # the engines' order would never fix an off-topic first result;
        # the engine ranking breaks ties and keeps multi-engine consensus
        # alive for the tail
        bm25_ranking = sorted(non_empty, key=lambda i: float(scores[i]), reverse=True)
        fused = _rrf([bm25_ranking, list(non_empty)], [1.0, 0.25], RRF_K)
        for new_position, result_index in enumerate(fused, start=1):
            result = results[result_index]
            n_positions = max(len(_get_positions(result)), 1)
            result["positions"] = [new_position] * n_positions
        logger.debug("BM25 reranked %d results for: %s", len(fused), query[:50])
        return None


def _rrf(rankings: list[list[int]], weights: list[float], k: int = RRF_K) -> list[int]:
    """Weighted reciprocal rank fusion: score(doc) =
    Σ weight_i / (k + rank_i).  Ties resolve toward the earlier (dominant)
    ranking via the stable sort."""
    scores: dict[int, float] = {}
    for ranking, weight in zip(rankings, weights):
        for rank, doc in enumerate(ranking):
            scores[doc] = scores.get(doc, 0.0) + weight / (k + rank + 1)
    return sorted(scores.keys(), key=lambda doc: scores[doc], reverse=True)
