# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Overview: the ``POST /zjsearch/ai/answer`` endpoint.

NOT a separate feature design -- the FIXED QUICK TASK of the shared
engine: the client assembles the numbered source context from the page
payload it already has, and the run is a single WRITE turn over that
context (the zero-tool case of :py:func:`framework.loop.run`, the same
shape a speed-mode run's final phase takes).  The stream is the SAME
timeline NDJSON the search endpoint speaks -- ``think`` deltas fold,
``answer`` deltas are the answer, one ``settle`` carries finish/usage.

Thin route: authorize, assemble the messages, degrade a rejected
multimodal request to text-only, stream.
"""

import logging
import re
import typing as t

import flask

from searx.zjsearch.ai.capabilities.images import attach_images
from searx.zjsearch.ai.framework import loop as engine
from searx.zjsearch.ai.framework import wire
from searx.zjsearch.ai.infra import config as llm_config
from searx.zjsearch.ai.infra import http
from searx.zjsearch.ai.infra.embed import cosine, run_batch
from searx.zjsearch.ai.infra import rerank as rerank_service
from searx.zjsearch.ai.runtime import spine

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


def _ordered_context(question: str, context: str) -> str:
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


def _cap_lines(context: str) -> str:
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
            " sources provided.\n</role>",
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


def _answer() -> flask.Response:
    """AI Overview: the fixed quick task on the shared engine."""
    payload, q, context = http.authorize(
        gate=llm_config.feature_enabled("overview") and llm_config.configured(llm_config.llm_cfg()), context=True
    )
    cfg = llm_config.llm_cfg()
    context = _cap_lines(_ordered_context(q, context))
    lang = http.answer_lang(payload)
    image_parts = attach_images(payload, cfg)

    events = engine.run(cfg, build_answer_messages(q, context, lang, image_parts))
    stream = _Ndjson(events)
    try:
        stream.prime()
    except _UpstreamDead:
        if not image_parts:
            return http.upstream_error_response("error", stream.dead_reason or "upstream returned an empty stream")
        # the endpoint rejected the multimodal request (no vision support,
        # or memory pressure) -- degrade to a text-only answer
        logger.warning("zjsearch_ai: image request rejected, retrying text-only")
        events = engine.run(cfg, build_answer_messages(q, context, lang, []))
        stream = _Ndjson(events)
        try:
            stream.prime()
        except _UpstreamDead:
            return http.upstream_error_response("error", stream.dead_reason or "upstream returned an empty stream")
    return http.streaming_response(iter(stream), "application/x-ndjson")


class _UpstreamDead(Exception):
    """The run settled as an error before any content event."""


class _Ndjson:  # pylint: disable=too-few-public-methods
    """The timeline ops as NDJSON lines, primed before streaming so a dead
    upstream answers 502."""

    def __init__(self, events: t.Iterator[dict[str, t.Any]]) -> None:
        self.events = events
        self.buffer: list[str] = []
        self.rest: t.Iterator[str] | None = None
        self.dead_reason: str | None = None

    def prime(self) -> None:
        for event in self.events:
            kind = event.get("e")
            if kind == "settle":
                if str(event.get("status") or "") == "error":
                    self.dead_reason = str(event.get("halt") or "upstream returned an empty stream")
                    raise _UpstreamDead(self.dead_reason)
                self.buffer.append(wire.encode(event))
                self.rest = iter(())
                return
            self.buffer.append(wire.encode(event))
            if kind in ("open", "think", "answer"):
                self.rest = self._rest()
                return

    def _rest(self) -> t.Iterator[str]:
        for event in self.events:
            yield wire.encode(event)

    def __iter__(self) -> t.Iterator[str]:
        if self.rest is None:
            self.prime()
        yield from self.buffer
        if self.rest is not None:
            yield from self.rest


def install(app: flask.Flask) -> None:
    """Register the answer route; chained from the ``searx.zjsearch.ai``
    package install so the theme keeps one webapp.py entry point.  An
    enabled-but-incomplete configuration or a missing SDK package logs a
    warning and the feature stays off."""
    if not llm_config.llm_cfg().get("enabled") or not enabled():
        return
    if not llm_config.configured(llm_config.llm_cfg()):
        logger.warning("zjsearch.ai is enabled but model/base_url are missing -- AI answers stay off")
        return
    from searx.zjsearch.ai.infra import sdk as sdk_registry  # pylint: disable=import-outside-toplevel

    package = sdk_registry.sdk_missing(llm_config.llm_cfg())
    if package is not None:
        logger.warning(
            "zjsearch.ai: the %r transport needs the %r package (see requirements.txt) -- AI answers stay off",
            llm_config.endpoint(llm_config.llm_cfg())[0],
            package,
        )
        return
    app.add_url_rule("/zjsearch/ai/answer", "zjsearch_ai_answer", _answer, methods=["POST"])
