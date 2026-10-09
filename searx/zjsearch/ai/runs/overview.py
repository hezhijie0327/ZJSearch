# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Overview: the ``POST /zjsearch/ai/answer`` endpoint.

NOT a separate feature design -- the FIXED QUICK TASK of the shared
engine: the client assembles the numbered source context from the page
payload it already has, and the run is a single WRITE turn over that
context (the zero-tool case of :py:func:`agent.loop.run`, the same
shape a speed-mode run's final phase takes).  The stream is the SAME
timeline NDJSON the search endpoint speaks -- ``think`` deltas fold,
``answer`` deltas are the answer, one ``settle`` carries finish/usage.

Thin route: authorize, assemble the messages, degrade a rejected
multimodal request to text-only, stream.
"""

import logging
import re
import typing as t

from searx.zjsearch.ai.core.ndjson import PrimedStream as _Ndjson
from searx.zjsearch.ai.core.ndjson import UpstreamDead as _UpstreamDead
from searx.zjsearch.ai.llm import config as llm_config
from searx.zjsearch.ai.llm.embed import cosine, run_batch
from searx.zjsearch.ai.llm import rerank as rerank_service
from searx.zjsearch.ai.prompts import spine

logger = logging.getLogger(__name__)

_CONTEXT_MAX_CHARS = 16000
"""Hard cap on the client-assembled context (deep 5 + shallow 15 + infobox
lands around 7k; the cap only guards abuse)."""

_OVERVIEW_RERANK_ABOVE = 12_000
"""Context size past which the numbered source lines are re-ordered by
embedding cosine against the question -- the cap sits at 16k, so past
this point the least relevant lines sit in the cap's shadow and the
model reads noise before the goods.  A fitting context keeps the
engine's relevance order (fresh, already reranked by the bm25 plugin)
and costs no embedding round trip.  Silent degradation: embedding off /
slow / dead -> original order."""

_NUMBERED_LINE_RE = re.compile(r"^\[\d+\] ")
_EMBED_TIMEOUT = 4.0
"""The ordering embed's wall clock -- a quick-answer endpoint must not
stall on a slow embedding upstream; past it the original order ships."""


def ordered_context(question: str, context: str) -> str:
    """The numbered source lines ordered most-question-relevant-first --
    the model funnel's middle tier first (ONE rerank call over the line
    heads, the query-conditioned signal), the embedding cosine as the
    fallback.  The [n] labels travel with their lines, so the client's
    citation grammar is untouched; below the threshold, with too few
    numbered lines, or on any model failure the context returns
    unchanged."""
    lines = context.split("\n")
    numbered = [i for i, line in enumerate(lines) if _NUMBERED_LINE_RE.match(line)]
    if len(numbered) < 4 or len(context) <= _OVERVIEW_RERANK_ABOVE:
        return context
    heads = [lines[i][:600] for i in numbered]
    if rerank_service.configured():
        # the cross-encoder wins whenever it answers (its own fail-open
        # returns (None, 0) -- the embedding fallback stands)
        try:
            order, _tokens = rerank_service.rerank(question, heads)
        except Exception:  # pylint: disable=broad-except
            order = None
        if order is not None and len(order) == len(numbered):
            result = list(lines)
            for slot, k in enumerate(order):
                result[numbered[slot]] = lines[numbered[k]]
            return "\n".join(result)
    batch = run_batch([question] + heads, timeout=_EMBED_TIMEOUT)
    if not batch:
        return context
    vectors = batch[0]
    if len(vectors) != len(numbered) + 1:
        return context
    probe = vectors[0]
    order = sorted(range(len(numbered)), key=lambda k: -cosine(vectors[k + 1], probe))
    result = list(lines)
    for slot, k in enumerate(order):
        result[numbered[slot]] = lines[numbered[k]]
    return "\n".join(result)


def cap_lines(context: str) -> str:
    """The hard cap at a LINE boundary -- a raw string slice could cut a
    source line in half and leave the model citing a truncated [n]."""
    if len(context) <= _CONTEXT_MAX_CHARS:
        return context
    cut = context.rfind("\n", 0, _CONTEXT_MAX_CHARS)
    return context[: cut if cut > 0 else _CONTEXT_MAX_CHARS]


_ANSWER_USER_PROMPT = "<q>{q}</q>\n<sources>\n{context}\n</sources>"


def build_answer_messages(
    query: str, context: str, lang: str, image_parts: list[dict[str, t.Any]]
) -> list[dict[str, t.Any]]:
    """The zero-tool single-turn conversation: the shared answer spine
    (plus the images note when attachments ride) and the user turn with
    the client-assembled source context."""
    system = "\n".join(
        spine.answer_contract(
            lang,
            "<role>\nYou are the \"AI Overview\" feature of a search engine:"
            " answer the user's question directly, grounded in the numbered"
            " sources provided.  Synthesize ACROSS the sources -- never one"
            " summary per source, never a source list; keep it short (a few"
            " sentences unless the question genuinely demands more), and"
            " lead with the answer.\n</role>",
        )
    )
    if image_parts:
        system += (
            "\n<images>\nImages are attached after this text; they come from"
            " the numbered sources and may carry relevant visual"
            " information.\n</images>"
        )
    user_text = _ANSWER_USER_PROMPT.format(q=query, context=context)
    return spine.build_messages(system, spine.user_message(user_text, image_parts))


def capability() -> dict[str, str] | None:
    """The page-data ``ai`` payload (token + model label); ``None`` when the
    overview feature is switched off or the transport is unconfigured -- the
    client hides its AI Overview entry point then."""
    return llm_config.feature_capability("overview")


def enabled() -> bool:
    """The overview feature flag: ``zjsearch.feature.ai_overview.enabled`` --
    ``True`` unless explicitly switched off."""
    return llm_config.feature_enabled("overview")
