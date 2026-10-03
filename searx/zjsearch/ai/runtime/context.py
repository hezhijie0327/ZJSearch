# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the writer-context assembly -- budget, ordering, eviction.

How the researcher's accumulated source feed becomes the WRITER's
``<context>``: :py:func:`_fit_context` is the BUDGET (whole blocks are
evicted, never a mid-block slice -- a silently cut tail could drop
exactly the source the model was about to cite), and
:py:func:`_relevance_order` is the ORDERING override -- past the
embedding threshold the feed blocks are cosine-ranked against the
question, so the cap then evicts the LEAST RELEVANT material instead of
the newest.  Both sides fail soft: a fitting feed keeps its
chronological order and costs no embedding round trip, and any
embedding failure leaves the chronological eviction standing silently.
"""

from searx.zjsearch.ai.infra.embed import cosine as _cosine
from searx.zjsearch.ai.infra.embed import embed_texts

_RERANK_ABOVE = 24000
"""The feed size past which the writer's context overflow is likely (the
cap sits at 40k): the relevance embedding runs only there -- a fitting
feed keeps its chronological order and costs no embedding round trip."""

_WRITER_CONTEXT_MAX = 40_000
"""Hard cap on the source feed the writer receives (deep research with
page reads lands around 15-25k; the cap only guards abuse).  Over the cap
whole OLDEST feed blocks are evicted first -- a silently cut tail block
(the old hard slice) could drop a source the model was about to cite."""


def _fit_context(feed: list[str], cap: int, relevance: list[int] | None = None) -> list[str]:
    """The writer's source feed under the hard cap: whole blocks are
    evicted, never a mid-block slice -- a silently cut tail could drop
    exactly the source the model was about to cite.  The default fill is
    chronological (the oldest -- broadest -- searches evict first); with
    ``relevance`` (a precomputed block ranking, the embedding cosine
    against the question) the MOST QUESTION-RELEVANT blocks fill first
    and the least relevant are evicted instead.  The eviction notice
    names the drop so the writer does not cite evicted numbers; the
    renderer still fails soft on any that slip through."""
    blocks = [block for block in feed if block]
    if relevance is not None and len(relevance) == len(blocks) and len(blocks) > 1:
        blocks = [blocks[i] for i in relevance if 0 <= i < len(blocks)]
    dropped = 0
    while len(blocks) > 1 and sum(len(block) for block in blocks) > cap:
        blocks.pop(0 if relevance is None else -1)
        dropped += 1
    if dropped:
        blocks.insert(
            0,
            f"[... {dropped} source block(s) were dropped to fit" " the context -- cite only the sources below ...]",
        )
    return blocks or ["The research found no usable sources."]


async def _relevance_order(question: str, feed: list[str]) -> list[int] | None:
    """The feed blocks ranked by embedding cosine against the question --
    the writer's fill order when the context would overflow (the cap then
    keeps the MOST RELEVANT material instead of the newest).  ``None`` on
    any skip: a fitting feed, the embedding feature off, an upstream
    failure -- the chronological eviction stands, silently."""
    blocks = [block for block in feed if block]
    if len(blocks) < 2 or sum(len(block) for block in blocks) <= _RERANK_ABOVE:
        return None
    result = await embed_texts([question] + [block[:600] for block in blocks])
    if not result:
        return None
    vectors = result[0]
    if len(vectors) != len(blocks) + 1:
        return None
    probe = vectors[0]
    order = sorted(range(len(blocks)), key=lambda i: -_cosine(vectors[i + 1], probe))
    return order
