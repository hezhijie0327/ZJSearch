# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``POST /zjsearch/ai/answer`` endpoint (AI Overview).

THIN: authorize, assemble the messages
(:py:func:`runs.overview.build_answer_messages`), degrade a rejected
multimodal request to text-only, stream.  The ordering/capping business
logic lives in :py:mod:`runs.overview`."""

import logging

import flask

from searx.zjsearch.ai.agent import loop as engine
from searx.zjsearch.ai.api import http
from searx.zjsearch.ai.core.ndjson import PrimedStream as _Ndjson
from searx.zjsearch.ai.core.ndjson import UpstreamDead as _UpstreamDead
from searx.zjsearch.ai.llm import config as llm_config
from searx.zjsearch.ai.runs import overview
from searx.zjsearch.ai.runs.attachments import attach_images

logger = logging.getLogger(__name__)


def _answer() -> flask.Response:  # pylint: disable=too-many-locals
    """AI Overview: the fixed quick task on the shared engine."""
    payload, q, context = http.authorize(
        gate=overview.enabled() and llm_config.configured(llm_config.llm_cfg()), context=True
    )
    cfg = llm_config.llm_cfg()
    context = overview.cap_lines(overview.ordered_context(q, context))
    lang = http.answer_lang(payload)
    image_parts = attach_images(payload, cfg)

    events = engine.run(cfg, overview.build_answer_messages(q, context, lang, image_parts))
    stream = _Ndjson(events)  # type: ignore[assignment]
    try:
        stream.prime()
    except _UpstreamDead:
        if not image_parts:
            return http.upstream_error_response("error", stream.dead_reason or "upstream returned an empty stream")
        # the endpoint rejected the multimodal request (no vision support,
        # or memory pressure) -- degrade to a text-only answer
        logger.warning("zjsearch_ai: image request rejected, retrying text-only")
        events = engine.run(cfg, overview.build_answer_messages(q, context, lang, []))
        stream = _Ndjson(events)
        try:
            stream.prime()
        except _UpstreamDead:
            return http.upstream_error_response("error", stream.dead_reason or "upstream returned an empty stream")
    return http.streaming_response(iter(stream), "application/x-ndjson")


def install(app: flask.Flask) -> None:
    """Register the answer route; chained from the ``searx.zjsearch.ai``
    package install so the theme keeps one webapp.py entry point.  An
    enabled-but-incomplete configuration or a missing SDK package logs a
    warning and the feature stays off."""
    if not llm_config.llm_cfg().get("enabled") or not overview.enabled():
        return
    if not llm_config.configured(llm_config.llm_cfg()):
        logger.warning("zjsearch.ai is enabled but model/base_url are missing -- AI answers stay off")
        return
    from searx.zjsearch.ai.llm import sdk as sdk_registry  # pylint: disable=import-outside-toplevel

    package = sdk_registry.sdk_missing(llm_config.llm_cfg())
    if package is not None:
        logger.warning(
            "zjsearch.ai: the %r transport needs the %r package (see requirements.txt) -- AI answers stay off",
            llm_config.endpoint(llm_config.llm_cfg())[0],
            package,
        )
        return
    app.add_url_rule("/zjsearch/ai/answer", "zjsearch_ai_answer", _answer, methods=["POST"])
