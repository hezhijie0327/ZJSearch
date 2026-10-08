# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The run host's live channels: ``POST /zjsearch/ai/run/attach`` (the
REATTACH endpoint -- replay a run's event buffer after ``after_seq`` and
follow the live tail; the SAME run, never a restart) and
``POST /zjsearch/ai/run/control`` (the inbound control plane -- the stop
instruction today; steering/preempt/wrap land in v2.1 R2).  Both are
the stack's client-to-server live channels beside the browser takeover
input: the run's NDJSON stays one-way server-to-client, these are the
upstream lanes.

The ``attach`` stream ends when the driver finishes -- the settle AND
the late tail (related/memory/usage) flow through, so a reattaching
client sees exactly what a first-connection client would have.
"""

import logging
import typing as t

import flask

from searx.zjsearch.ai.api import http
from searx.zjsearch.ai.llm import config as llm_config
from searx.zjsearch.ai.runs import host as run_host
from searx.zjsearch.ai.runs.profile import enabled

logger = logging.getLogger(__name__)


_MAX_TEXT = 2000
"""One steering message's character budget."""


def _gate() -> bool:
    return enabled() and llm_config.configured(llm_config.llm_cfg())


def _attach_view() -> t.Any:
    payload = http.token_payload(gate=_gate())
    handle = run_host.get(str(payload.get("run_key") or ""))
    if handle is None:
        # an unknown (or TTL-swept) run: the client falls back to the
        # knowledge base's replay -- the storage question it always was
        flask.abort(404)
    try:
        after_seq = min(abs(int(payload.get("after_seq"))), 1_000_000)
    except (TypeError, ValueError):
        after_seq = 0
    return http.streaming_response(handle.stream(after_seq), "application/x-ndjson")


def _control_view() -> t.Any:
    payload = http.token_payload(gate=_gate())
    handle = run_host.get(str(payload.get("run_key") or ""))
    if handle is None:
        return flask.jsonify({"ok": False, "error": "unknown run"}), 404
    action = str(payload.get("action") or "")
    error = ""
    if action == "stop":
        handle.control.stop()
    elif action in ("steer", "preempt"):
        text = str(payload.get("text") or "").strip()
        if not text:
            error = "text is required"
        elif not handle.control.steer(text[:_MAX_TEXT], preempt=action == "preempt"):
            error = "the steer queue is full"
    elif action == "wrap":
        # the graceful end (收尾): the run finishes its round, then walks
        # into the writer with the material gathered -- the same halt the
        # detach grace uses
        handle.wrap()
    else:
        error = "action must be stop / steer / preempt / wrap"
    if error:
        return flask.jsonify({"ok": False, "error": error}), 422
    return flask.jsonify({"ok": True})


def install(app: flask.Flask) -> None:
    """Register the run host's channels; silent unless AI search itself
    is enabled and fully configured (the same gate as the search route --
    these channels exist to serve its runs)."""
    if not _gate():
        return
    app.add_url_rule("/zjsearch/ai/run/attach", "zjsearch_ai_run_attach", _attach_view, methods=["POST"])
    app.add_url_rule("/zjsearch/ai/run/control", "zjsearch_ai_run_control", _control_view, methods=["POST"])
