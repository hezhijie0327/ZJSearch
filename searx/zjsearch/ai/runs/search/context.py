# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

"""AI Search: the writer-context assembly -- budget, ordering, eviction.

How the researcher's accumulated source feed becomes the WRITER's
``<context>``: :py:func:`_fit_context` is the BUDGET (whole blocks are
evicted, never a mid-block slice -- a silently cut tail could drop
exactly the source the model was about to cite), and
:py:func:`_relevance_order` is the ORDERING override -- past the
threshold the feed blocks are ranked against the question by the model
funnel's middle tier (the rerank cross-encoder -- a query-conditioned
relevance signal the bi-encoder cannot match), falling back to the
embedding cosine when the rerank service is unconfigured.  The cap then
evicts the LEAST RELEVANT material instead of the newest.  Both sides
fail soft: a fitting feed keeps its chronological order and costs no
model round trip, and any ranking failure leaves the chronological
eviction standing silently.
"""

import typing as t

from searx.zjsearch.ai.llm.embed import cosine as _cosine
from searx.zjsearch.ai.llm.embed import embed_texts
from searx.zjsearch.ai.llm import rerank as rerank_service

_RERANK_ABOVE = 24000

# the writer relevance order's embed fallback budget -- the codebase's
# standard 8s embed spend (rank/memory/synth); ``None`` used to wait
# unbounded on a hung endpoint INSIDE the write boundary's bridge
_WRITE_EMBED_TIMEOUT = 8.0
"""The feed size past which the writer's context overflow is likely (the
cap sits at 40k/96k by mode): the relevance ranking runs only there -- a
fitting feed keeps its chronological order and costs no model round
trip."""

CONTEXT_MAX: dict[str, int] = {"deep": 96_000}
"""The per-mode writer-context caps: the deep run earned its material
through the gates (every block passed relevance + evidence judgment on
the way in), so the long run's writer gets the long context; every
other mode keeps the 40k guard."""

_WRITER_CONTEXT_DEFAULT = 40_000
"""Hard cap on the source feed the writer receives outside the deep
modes (research with page reads lands around 15-25k; the cap only
guards abuse).  Over the cap whole OLDEST feed blocks are evicted first
-- a silently cut tail block (the old hard slice) could drop a source
the model was about to cite."""


def writer_context_max(mode: str) -> int:
    """The mode's writer-context cap (``CONTEXT_MAX``, default
    :py:data:`_WRITER_CONTEXT_DEFAULT`)."""
    return CONTEXT_MAX.get(mode, _WRITER_CONTEXT_DEFAULT)


_SINGLE_BLOCK_FLOOR = 24_000
"""One source block that ALONE exceeds the writer cap gets split at a
line boundary (head kept) down to this floor -- a single huge page read
used to ride whole (the eviction loop stops at one block), pushing the
writer context past its cap by itself.  The corpus and the client's
reading pane keep the FULL text; only the writer's block slims."""


def _split_oversized(block: str) -> str:
    """The head of one oversized block, cut at the last line boundary
    that fits the floor (never mid-sentence by intent; a pathological
    no-newline dump takes the hard cut)."""
    if len(block) <= _SINGLE_BLOCK_FLOOR:
        return block
    cut = block.rfind("\n", 0, _SINGLE_BLOCK_FLOOR)
    if cut < _SINGLE_BLOCK_FLOOR // 2:
        cut = _SINGLE_BLOCK_FLOOR
    return block[:cut] + "\n[... the rest of this source was dropped to fit the context ...]"


def _fit_context(feed: list[str], cap: int, relevance: list[int] | None = None) -> list[str]:
    """The writer's source feed under the hard cap: whole blocks are
    evicted, never a mid-block slice -- a silently cut tail could drop
    exactly the source the model was about to cite.  The default fill is
    chronological (the oldest -- broadest -- searches evict first); with
    ``relevance`` (a precomputed block ranking) the MOST
    QUESTION-RELEVANT blocks fill first and the least relevant are
    evicted instead.  The eviction notice names the drop so the writer
    does not cite evicted numbers; the renderer still fails soft on any
    that slip through.  ONE exception to the no-slice rule: a single
    block that ALONE exceeds the cap is split head-first (a 200k page
    read cannot be "evicted around" when it is the only block)."""
    blocks = [block for block in feed if block]
    if relevance is not None and len(relevance) == len(blocks) and len(blocks) > 1:
        blocks = [blocks[i] for i in relevance if 0 <= i < len(blocks)]
    # the single-huge-block split runs FIRST (a block bigger than the
    # whole cap would defeat the eviction loop's len(blocks) > 1 guard)
    # and AGAIN after the eviction -- the survivor the loop stops on can
    # itself be the oversized one
    if len(blocks) == 1 and len(blocks[0]) > cap:
        blocks[0] = _split_oversized(blocks[0])
    dropped = 0
    while len(blocks) > 1 and sum(len(block) for block in blocks) > cap:
        blocks.pop(0 if relevance is None else -1)
        dropped += 1
    if len(blocks) == 1 and len(blocks[0]) > cap:
        blocks[0] = _split_oversized(blocks[0])
    if dropped:
        blocks.insert(
            0,
            f"[... {dropped} source block(s) were dropped to fit" " the context -- cite only the sources below ...]",
        )
    return blocks or ["The research found no usable sources."]


async def _relevance_order(question: str, feed: list[str], account: t.Any = None) -> list[int] | None:
    """The feed blocks ranked against the question -- the writer's fill
    order when the context would overflow (the cap then keeps the MOST
    RELEVANT material instead of the newest).  The funnel's middle tier
    ranks first (the rerank cross-encoder, ONE call over the block
    heads); the embedding cosine is the fallback when the rerank service
    is unconfigured.  ``account`` (the run's spend ledger) takes
    the rerank leg's spend -- a discarded
    bucket undercounts the model-stats card.  ``None`` on any skip: a
    fitting feed, both models off, an upstream failure -- the
    chronological eviction stands, silently."""
    blocks = [block for block in feed if block]
    if len(blocks) < 2 or sum(len(block) for block in blocks) <= _RERANK_ABOVE:
        return None
    heads = [block[:600] for block in blocks]
    if rerank_service.configured():
        # the cross-encoder: query-conditioned relevance, the signal the
        # bi-encoder approximates -- its order wins whenever it answers
        try:
            order, _tokens = rerank_service.rerank(question, heads, account=account)
        except Exception:  # pylint: disable=broad-except
            order = None
        if order is not None and len(order) == len(blocks):
            return order
    result = await embed_texts([question] + heads, timeout=_WRITE_EMBED_TIMEOUT)
    if not result:
        return None
    vectors = result[0]
    if len(vectors) != len(blocks) + 1:
        return None
    probe = vectors[0]
    return sorted(range(len(blocks)), key=lambda i: -_cosine(vectors[i + 1], probe))
