# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``POST /zjsearch/ai/decision`` endpoint: a thin, HMAC-gated browser
proxy to the decision-model service (:py:mod:`infra.decision` -- the
engine and its config live there; this module is only the gate +
validation + the call).  Consumers of the System-One primitive (triage,
routing, verification) speak the wire question vocabulary -- ``choice`` /
``score`` / ``noul`` -- verbatim; the route adds no semantics."""

import logging

import flask

from searx.zjsearch.ai.infra import decision, security

logger = logging.getLogger(__name__)

MAX_QUESTIONS = decision.MAX_QUESTIONS


def _decision_view() -> flask.Response:
    # the shared prologue, minus the question: gate (404) then the HMAC
    # token (403) -- http.authorize would 422 on a missing `q`, which a
    # judgment does not have
    if not decision.enabled() or not decision.configured():
        flask.abort(404)
    payload = flask.request.get_json(silent=True) or {}
    if not security.check_token(str(payload.get("tk") or "")):
        flask.abort(403)
    state = payload.get("state")
    questions = payload.get("questions")
    if state is None or not isinstance(questions, dict) or not questions or len(questions) > MAX_QUESTIONS:
        return (
            flask.jsonify({"error": f"state plus 1..{MAX_QUESTIONS} questions (choice / score / noul) are required"}),
            422,
        )
    result = decision.judge(state, questions)
    if result is None:
        return flask.jsonify({"error": "decision upstream failed"}), 502
    return flask.jsonify(result)


def install(app: flask.Flask) -> None:
    """Register the decision route; chained from the ``searx.zjsearch.ai``
    package install.  Silent when not configured."""
    if not decision.enabled() or not decision.configured():
        return
    app.add_url_rule("/zjsearch/ai/decision", "zjsearch_ai_decision", _decision_view, methods=["POST"])
