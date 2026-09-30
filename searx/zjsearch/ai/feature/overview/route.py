# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Overview: the ``POST /ai/answer`` endpoint.

Thin route (the search/route.py shape): authorize, assemble the zero-tool
single-turn run, degrade a rejected multimodal request to text-only, and
stream the raw-text answer with the ``<think>`` markers rendered around
the framework's shared ThinkGate state.
"""

import json
import logging
import typing as t

import flask

from searx.zjsearch.ai import agent, http, llm
from searx.zjsearch.ai.capabilities.images import attach_images
from searx.zjsearch.ai.feature.overview.config import enabled
from searx.zjsearch.ai.feature.overview.prompts import build_answer_messages

logger = logging.getLogger(__name__)

_CONTEXT_MAX_CHARS = 16000
"""Hard cap on the client-assembled context (deep 5 + shallow 15 + infobox
lands around 7k; the cap only guards abuse)."""


def capability() -> dict[str, str] | None:
    """The page-data ``ai`` payload (token + model label); ``None`` when the
    overview feature is switched off or the transport is unconfigured -- the
    client hides its AI Overview entry point then."""
    return llm.feature_capability("overview")


def _answer() -> flask.Response:
    """AI Overview: the client assembles the numbered source context from the
    page payload it already has, this view streams the answer.  Reasoning
    deltas are relayed wrapped in ``<think>...</think>`` so the client can
    fold them away."""
    payload, q, context = http.authorize(
        gate=llm.feature_enabled("ai_overview") and llm.configured(llm.ai_cfg()), context=True
    )
    cfg = llm.ai_cfg()
    context = context[:_CONTEXT_MAX_CHARS]
    lang = http.answer_lang(payload)

    image_parts = attach_images(payload, llm.ai_cfg())

    def open_run(with_images: bool) -> t.Iterator[tuple[str, t.Any]]:
        # the zero-tool single-turn case of the agent framework
        return agent.run_agent(cfg, build_answer_messages(q, context, lang, image_parts if with_images else []))

    events = open_run(bool(image_parts))
    try:
        first_kind, first = next(events)
    except StopIteration:
        first_kind, first = "end", None
    if first_kind == "error" and image_parts:
        # the endpoint rejected the multimodal request (no vision support,
        # or memory pressure) -- degrade to a text-only answer
        logger.warning("zjsearch_ai: image request rejected, retrying text-only")
        events = open_run(False)
        try:
            first_kind, first = next(events)
        except StopIteration:
            first_kind, first = "end", None
    if first_kind not in ("delta", "think") or not first:
        return http.upstream_error_response(first_kind, first)

    def generate():
        # the raw-text wire adapter: <think> markers rendered around the
        # framework's shared ThinkGate state
        gate = agent.ThinkGate()
        kind, text = first_kind, first
        while kind in ("delta", "think"):
            if kind == "think":
                state = gate.reasoning()
                if state == "open":
                    yield "<think>"
                if state != "drop":
                    yield text or ""
            else:
                if gate.opened and not gate.closed:
                    yield "</think>"
                gate.content()
                yield text or ""
            kind, text = next(events, ("end", None))
        if gate.opened and not gate.closed:
            yield "</think>"
        # the run's consolidated transport meta (finish reason + usage +
        # the API-reported model) rides the stream TAIL as a sentinel line
        # the client strips before rendering -- the raw-text wire's own
        # <think>-style control channel
        if kind == "finish" and isinstance(text, dict):
            meta = {"finish": text.get("finish"), "model": text.get("model"), "usage": text.get("usage")}
            yield f"\n<<<zjs-meta:{json.dumps(meta, ensure_ascii=False)}>>>"

    return http.streaming_response(generate(), "text/plain")


def install(app: flask.Flask) -> None:
    """Register the answer route; chained from the ``searx.zjsearch.ai``
    package install so the theme keeps one webapp.py entry point.  An
    enabled-but-incomplete configuration or a missing SDK package logs a
    warning and the feature stays off."""
    if not llm.ai_cfg().get("enabled") or not enabled():
        return
    if not llm.configured(llm.ai_cfg()):
        logger.warning("zjsearch.ai is enabled but model/base_url are missing -- AI answers stay off")
        return
    package = llm.sdk_missing(llm.ai_cfg())
    if package is not None:
        logger.warning(
            "zjsearch.ai: the %r transport needs the %r package (see requirements.txt) -- AI answers stay off",
            llm.endpoint(llm.ai_cfg())[0],
            package,
        )
        return
    app.add_url_rule("/ai/answer", "zjsearch_ai_answer", _answer, methods=["POST"])
