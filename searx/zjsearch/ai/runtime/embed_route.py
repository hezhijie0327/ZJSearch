# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``POST /zjsearch/ai/embed`` endpoint: a thin, HMAC-gated browser
proxy to the embedding service (:py:mod:`infra.embed` -- the engine and
its config live there; this module is only the gate + validation + the
shared-loop call).
"""

import logging
import typing as t

import flask

from searx.zjsearch.ai.infra import config as llm_config
from searx.zjsearch.ai.infra import embed, security

logger = logging.getLogger(__name__)


def _embed_view() -> flask.Response:
    # the shared prologue, minus the question: gate (404) then the HMAC
    # token (403) -- http.authorize would 422 on a missing `q`, which a
    # batch of texts does not have
    if not embed.enabled() or not embed.configured():
        flask.abort(404)
    payload = flask.request.get_json(silent=True) or {}
    if not security.check_token(str(payload.get("tk") or "")):
        flask.abort(403)
    texts = payload.get("texts")
    if not isinstance(texts, list) or not texts or len(texts) > embed.MAX_BATCH:
        return (
            flask.jsonify({"error": "texts must be a non-empty list of at most 16 strings"}),
            422,
        )
    result = embed.run_batch([str(text) for text in texts])
    if result is None:
        return flask.jsonify({"error": "embedding upstream failed"}), 502
    vectors, model, usage = result
    return flask.jsonify({"embeddings": vectors, "model": model, "usage": usage})


def capability() -> dict[str, t.Any] | None:
    """The page-data ``embedding`` payload (delegates to the service)."""
    return embed.capability()


def install(app: flask.Flask) -> None:
    """Register the embed route; chained from the ``searx.zjsearch.ai``
    package install.  Silent when not configured."""
    if not llm_config.llm_cfg().get("enabled") or not embed.enabled():
        return
    if embed.cfg().get("dimensions") is not None:
        logger.warning(
            "zjsearch.embedding: the top-level `dimensions` key is gone -- put the"
            " width in params (openai `params.dimensions` / gemini"
            " `params.output_dimensionality`); the bare key is ignored"
        )
    if not embed.configured():
        logger.warning(
            "zjsearch.embedding is enabled but base_url/model/api_key are missing -- history search stays off"
        )
        return
    kind = embed.sdk()
    package = embed.sdk_missing()
    if package is not None:
        logger.warning(
            "zjsearch.embedding: the %r sdk needs the %r package -- history search stays off",
            kind,
            package,
        )
        return
    app.add_url_rule("/zjsearch/ai/embed", "zjsearch_ai_embed", _embed_view, methods=["POST"])
