# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``POST /zjsearch/ask/decision`` endpoint: a thin, HMAC-gated browser
proxy to the decision-model service (:py:mod:`llm.decision` -- the
engine and its config live there; this module is only the gate +
validation + the call).  Consumers of the decision primitive (triage,
routing, verification) speak the wire question vocabulary -- ``choice`` /
``score`` / ``noul`` -- verbatim; the route adds no semantics."""

import logging

import flask

from searx.zjsearch.ai.api import http
from searx.zjsearch.ai.llm import decision

logger = logging.getLogger(__name__)

MAX_QUESTIONS = decision.MAX_QUESTIONS


def _decision_view() -> flask.Response:
    payload = http.token_payload(gate=decision.enabled() and decision.configured())
    state = payload.get("state")
    questions = payload.get("questions")
    images = payload.get("images")
    if state is None or not isinstance(questions, dict) or not questions or len(questions) > MAX_QUESTIONS:
        return (
            flask.jsonify({"error": f"state plus 1..{MAX_QUESTIONS} questions (choice / score / noul) are required"}),
            422,
        )
    if images is not None and not (isinstance(images, list) and all(isinstance(url, str) for url in images)):
        return flask.jsonify({"error": "images must be a list of urls"}), 422
    result = decision.judge(state, questions, timeout=15.0, images=images)
    if result is None:
        return flask.jsonify({"error": "decision upstream failed"}), 502
    return flask.jsonify(result)


def capability() -> dict[str, str] | None:
    """The page-data ``decision`` payload (delegates to the service)."""
    return decision.capability()


def install(app: flask.Flask) -> None:
    """Register the decision route; chained from the ``searx.zjsearch.ai``
    package install.  Silent when not configured."""
    if not decision.enabled() or not decision.configured():
        return
    app.add_url_rule("/zjsearch/ask/decision", "zjsearch_ask_decision", _decision_view, methods=["POST"])
