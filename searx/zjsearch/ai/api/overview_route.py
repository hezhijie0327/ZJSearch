# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``POST /zjsearch/ai/answer`` endpoint (AI Overview).

THIN: authorize, assemble the messages
(:py:func:`runs.overview.build_answer_messages`), degrade a rejected
multimodal request to text-only, stream.  The ordering/capping business
logic lives in :py:mod:`runs.overview`."""

import logging
import typing as t

import flask

from searx.zjsearch.ai.agent import loop as engine
from searx.zjsearch.ai.api import http
from searx.zjsearch.ai.core.ndjson import PrimedStream as _Ndjson
from searx.zjsearch.ai.core.ndjson import UpstreamDead as _UpstreamDead
from searx.zjsearch.ai.llm import config as llm_config
from searx.zjsearch.ai.llm.accounts import ModelAccount
from searx.zjsearch.ai.runs import overview
from searx.zjsearch.ai.runs.attachments import attach_images

logger = logging.getLogger(__name__)


def _merge_spend(events: t.Iterable[dict[str, t.Any]], account: t.Any) -> t.Iterator[dict[str, t.Any]]:
    """The ordering pass's model spend folded into the settle's usage --
    GENERIC over the account's buckets, the same merge the search
    settle's tail does -- so the client's footer renders the whole
    flow."""
    for event in events:
        buckets = account.buckets()
        if event.get("e") == "settle" and buckets:
            usage = event.get("usage")
            usage = usage if isinstance(usage, dict) else {}
            for kind, bucket in buckets.items():
                usage[kind] = {"calls": int(bucket["calls"]), "tokens": int(bucket.get("tokens") or 0)}
            event = {**event, "usage": usage}
        yield event


def _answer() -> flask.Response:  # pylint: disable=too-many-locals
    """AI Overview: the fixed quick task on the shared engine."""
    payload, q, context = http.authorize(
        gate=overview.enabled() and llm_config.configured(llm_config.llm_cfg()), context=True
    )
    cfg = llm_config.llm_cfg()
    account = ModelAccount()
    context = overview.cap_lines(overview.ordered_context(q, context, account))
    lang = http.answer_lang(payload)
    image_parts = attach_images(payload, cfg)

    events = _merge_spend(engine.run(cfg, overview.build_answer_messages(q, context, lang, image_parts)), account)
    stream = _Ndjson(events)  # type: ignore[assignment]
    try:
        stream.prime()
    except _UpstreamDead:
        if not image_parts:
            return http.upstream_error_response("error", stream.dead_reason or "upstream returned an empty stream")
        # the endpoint rejected the multimodal request (no vision support,
        # or memory pressure) -- degrade to a text-only answer
        logger.warning("zjsearch_ai: image request rejected, retrying text-only")
        events = _merge_spend(engine.run(cfg, overview.build_answer_messages(q, context, lang, [])), account)
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
