# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The run corpus: the research's own retrievable memory.

Everything a report section might need to cite -- search results, page
full-texts, ledger facts, recorded tables -- lands here as chunks while
the research runs; the synthesizer packs each section's context from a
BM25 retrieval over it (the classic page's CJK tokenizer, one source of
truth with the feed ranking), re-scored by the deployment's rerank
provider when configured, with an embedding-cosine rescue when BM25 has
zero signal.  Every stage fails open: a dead reranker or embedding
leaves the BM25 order standing, and an empty corpus packs nothing (the
section writes from the ledger facts alone).
"""

import logging
import typing as t

import bm25s

from searx.plugins.bm25_reranker import cjk_tokenize
from searx.zjsearch.ai.llm import embed as embed_service
from searx.zjsearch.ai.llm import rerank as rerank_service

logger = logging.getLogger(__name__)

CHUNK_CHARS = 1_200
"""A chunk is roughly one readable paragraph block -- long page texts
are split at line boundaries near this size."""
MAX_CHUNKS = 900
"""The run corpus cap (a 120-round deep run lands around 300-600; the
cap only guards pathological runs -- the OLDEST chunks recycle first,
the ledger facts and tables always survive)."""
RERANK_HEAD = 24
"""How many BM25 hits the rerank model re-scores per pack."""
PACK_BUDGET_DEFAULT = 9_000
"""Default per-section context budget in characters."""
EMBED_RESCUE_LIMIT = 120
"""The embedding rescue embeds at most this many chunk heads (one batch
round trip; the corpus head is where BM25's zero signal lives anyway)."""


class Corpus:
    """The run's chunk store + its retriever."""

    def __init__(self) -> None:
        self._chunks: list[dict[str, t.Any]] = []

    def add(self, text: str, *, ref_n: int = 0, title: str = "", url: str = "", kind: str = "result") -> None:
        """Ingest one material item, split into line-boundary chunks.  ``n``
        is the item's global [n] (0 = uncited, e.g. a ledger fact's
        context).  Tables and facts never split (they are short); a long
        page becomes several chunks sharing one [n]."""
        text = str(text or "").strip()
        if not text:
            return
        if len(text) <= CHUNK_CHARS or kind in ("fact", "table"):
            self._push(text, ref_n, title, url, kind)
            return
        lines = text.split("\n")
        buf: list[str] = []
        size = 0
        for line in lines:
            if size + len(line) > CHUNK_CHARS and buf:
                self._push("\n".join(buf), ref_n, title, url, kind)
                buf, size = [], 0
            buf.append(line)
            size += len(line) + 1
        if buf:
            self._push("\n".join(buf), ref_n, title, url, kind)

    def _push(self, text: str, ref_n: int, title: str, url: str, kind: str) -> None:
        if len(self._chunks) >= MAX_CHUNKS:
            # recycle the OLDEST non-essential chunk (facts/tables/reader
            # full-texts outlive mere result snippets)
            for i, chunk in enumerate(self._chunks):
                if chunk["kind"] == "result":
                    del self._chunks[i]
                    break
            else:
                self._chunks.pop(0)
        self._chunks.append({"n": ref_n, "text": text, "title": title, "url": url, "kind": kind})

    def __len__(self) -> int:
        return len(self._chunks)

    def absorb(self, other: "Corpus") -> None:
        """A settled SUBAGENT's chunks join the parent's corpus -- the
        chunk refs are global [n]s (the shared registry minted them), so
        the merged index stays consistent."""
        self._chunks.extend(other._chunks)  # pylint: disable=protected-access

    def pack(self, query: str, *, k: int = 14, budget: int = PACK_BUDGET_DEFAULT) -> list[str]:
        """The section's key material: the top-k chunks as numbered feed
        lines (``[n] title — text``), most-relevant first, within the
        character budget.  BM25 ranks, the rerank provider re-scores the
        head, the embedding cosine rescues a zero-signal query; any
        failure leaves the previous stage's order standing."""
        if not self._chunks or not query.strip():
            return []
        order = self._bm25_order(query)
        if order is None:
            order = self._embed_rescue(query)
        if order is None:
            order = list(range(len(self._chunks)))
        if rerank_service.configured() and len(order) > 1:
            heads = [self._head(i) for i in order[:RERANK_HEAD]]
            try:
                reranked, _tokens = rerank_service.rerank(query, heads)
            except Exception as exc:  # pylint: disable=broad-except
                logger.warning("zjsearch corpus: rerank failed: %r", exc)
                reranked = None
            if reranked is not None and len(reranked) == len(heads):
                head_idx = [order[slot] for slot in reranked]
                order = head_idx + order[RERANK_HEAD:]
        out: list[str] = []
        used = 0
        seen: set[int] = set()
        for i in order:
            chunk = self._chunks[i]
            line = self._line(chunk)
            if len(line) + used > budget:
                break
            key = chunk["n"] or id(chunk)
            if key in seen and chunk["n"]:
                continue
            seen.add(key)
            out.append(line)
            used += len(line) + 1
            if len(out) >= k:
                break
        return out

    def _bm25_order(self, query: str) -> list[int] | None:
        query_tokens = cjk_tokenize(query)
        if not query_tokens:
            return None
        corpus_tokens = [cjk_tokenize(chunk["text"]) for chunk in self._chunks]
        if sum(1 for tokens in corpus_tokens if tokens) < 2:
            return None
        try:
            retriever = bm25s.BM25()
            retriever.index(corpus_tokens)
            scores = retriever.get_scores(query_tokens)
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch corpus: bm25 failed: %r", exc)
            return None
        if float(scores.max()) <= 0:
            return None
        return [int(i) for i in scores.argsort()[::-1]]

    def _embed_rescue(self, query: str) -> list[int] | None:
        """The zero-signal rescue: cosine between the query and the corpus
        heads (one batch embed; a slow or dead embedding upstream leaves
        the chronological order standing)."""
        if not embed_service.configured():
            return None
        head = self._chunks[:EMBED_RESCUE_LIMIT]
        try:
            batch = embed_service.run_batch([query] + [chunk["text"][:400] for chunk in head])
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch corpus: embed rescue failed: %r", exc)
            return None
        if not batch:
            return None
        vectors = batch[0]
        if len(vectors) != len(head) + 1:
            return None
        probe = vectors[0]
        scored = sorted(range(len(head)), key=lambda i: -embed_service.cosine(vectors[i + 1], probe))
        return scored + list(range(EMBED_RESCUE_LIMIT, len(self._chunks)))

    def _head(self, i: int) -> str:
        chunk = self._chunks[i]
        return f"{chunk['title']}. {chunk['text']}"[:400]

    @staticmethod
    def _line(chunk: dict[str, t.Any]) -> str:
        n = chunk["n"]
        prefix = f"[{n}] " if n else ""
        title = f"{chunk['title']} — " if chunk["title"] and chunk["title"] != chunk["text"][:80] else ""
        return f"{prefix}{title}{chunk['text']}"
