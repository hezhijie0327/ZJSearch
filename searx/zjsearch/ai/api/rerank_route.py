# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``POST /zjsearch/ai/rerank`` endpoint: a thin, HMAC-gated browser
proxy to the rerank service (:py:mod:`llm.rerank` -- the provider wires
and their config live there; this module is only the gate + validation +
the call).  The knowledge base's recall is the consumer: its hybrid
BM25+vector fusion narrows the corpus, and ONE cross-encoder pass over
the fused head re-orders it by query-conditioned relevance -- the model
funnel's middle tier, browser-side.
"""

import logging
import typing as t

import flask

from searx.zjsearch.ai.api import http
from searx.zjsearch.ai.core import security
from searx.zjsearch.ai.llm import config as llm_config
from searx.zjsearch.ai.llm import rerank

logger = logging.getLogger(__name__)

MAX_DOCUMENTS = 32
"""Documents per rerank call -- the recall fusion hands over its fused
head (2x the requested limit); 32 is generous for every read path."""

MAX_DOC_CHARS = 2000
"""Per-document truncation -- the recall sends title + body head, the
shape the ranking cascade itself ranks by."""


def _rerank_view() -> flask.Response:
    payload = http.token_payload(gate=rerank.enabled() and rerank.configured())
    query = payload.get("query")
    documents = payload.get("documents")
    if not isinstance(query, str) or not query.strip():
        return flask.jsonify({"error": "query must be a non-empty string"}), 422
    if (
        not isinstance(documents, list)
        or len(documents) < 2
        or len(documents) > MAX_DOCUMENTS
        or not all(isinstance(doc, str) and doc.strip() for doc in documents)
    ):
        return (
            flask.jsonify({"error": f"documents must be a list of 2..{MAX_DOCUMENTS} non-empty strings"}),
            422,
        )
    order, tokens = rerank.rerank(query.strip(), [doc[:MAX_DOC_CHARS] for doc in documents])
    if order is None:
        return flask.jsonify({"error": "rerank upstream failed"}), 502
    return flask.jsonify({"order": order, "tokens": tokens})


def capability() -> dict[str, t.Any] | None:
    """The page-data ``rerank`` payload (delegates to the service)."""
    if not rerank.enabled() or not rerank.configured():
        return None
    return {"tk": security.issue_token(), "model": str(rerank.cfg().get("model"))}


def install(app: flask.Flask) -> None:
    """Register the rerank route; chained from the ``searx.zjsearch.ai``
    package install.  Silent when not configured."""
    if not llm_config.llm_cfg().get("enabled") or not rerank.enabled():
        return
    if not rerank.configured():
        logger.warning(
            "zjsearch.rerank is enabled but base_url/model are missing -- recall reranking stays off"
        )
        return
    app.add_url_rule("/zjsearch/ai/rerank", "zjsearch_ai_rerank", _rerank_view, methods=["POST"])
