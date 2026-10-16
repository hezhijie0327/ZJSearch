# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The run host's live channels: ``POST /zjsearch/ask/run/attach`` (the
REATTACH endpoint -- replay a run's event buffer after ``after_seq`` and
follow the live tail; the SAME run, never a restart), ``POST
/zjsearch/ask/run/control`` (the inbound control plane -- stop /
steer / preempt / wrap / template), ``POST /zjsearch/ask/run/keepalive``
(the backgrounded tab's heartbeat -- the detach grace counts from the
last beat, so a living tab whose fetch the OS dropped keeps its run
alive) and ``POST /zjsearch/ask/run/journal`` (the LATE COLLECTOR -- a
settled run's durable shadow: the journaled wire lines after
``after_seq``, serving windows the host's memory buffers cannot --
beyond the terminal TTL and across process restarts).  These are the
stack's client-to-server live channels beside the browser takeover
input: the run's NDJSON stays one-way server-to-client, these are the
upstream lanes.

The ``attach`` stream ends when the driver finishes -- the settle AND
the late tail (related/memory/usage) flow through, so a reattaching
client sees exactly what a first-connection client would have.  The
``journal`` stream ends after its stored lines -- the run is OVER; the
settle rides inside them.
"""

import json
import logging
import sqlite3
import typing as t

import flask

from searx.zjsearch.ai.api import http
from searx.zjsearch.ai.llm import config as llm_config
from searx.zjsearch.ai.runs import host as run_host
from searx.zjsearch.ai.runs import journal as run_journal
from searx.zjsearch.ai.runs.profile import enabled

logger = logging.getLogger(__name__)


_MAX_TEXT = 2000
"""One steering message's character budget."""

_SHAPE_STEER: dict[str, dict[str, str]] = {
    # the shape flip's canonical steer notice (server-worded -- the UI is
    # a toggle, never a text box): tells the RESEARCHER how its remaining
    # rounds should adapt; the gathered material itself need not be redone
    "deck": {
        "zh": "输出格式已切换为演示文稿:接下来若仍在调研,请侧重可直接上页面的要点、"
        "数字对比与适合图表化的素材;已收集的材料不必重做。",
        "en": "The output format switched to a presentation deck: for any remaining"
        " research, favor slide-ready points, numeric comparisons and chart-able"
        " material; gathered material need not be redone.",
    },
    "report": {
        "zh": "输出格式已切换为书面报告:接下来若仍在调研,请侧重论据链、机制与因果的叙述素材;"
        "已收集的材料不必重做。",
        "en": "The output format switched to a written report: for any remaining"
        " research, favor narrative evidence -- argument chains, mechanisms and"
        " cause-effect material; gathered material need not be redone.",
    },
}


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
    elif action == "template":
        # the rail's 输出结构 control: ONE pending template the write
        # boundary consumes -- the synthesizer re-mints the outline from
        # it before the first section streams (writer-not-started only by
        # construction: the control carries nothing once the write phase
        # owns the loop, and a consumed slot is a no-op).  An ABSENT
        # template payload CLEARS a previous pick (the unified two-step
        # picker's free options withdraw the template and re-open the
        # free outline).
        from searx.zjsearch.ai.runs.report import outline as report_outline

        if payload.get("template") is None:
            handle.control.clear_template()
        else:
            template = report_outline.parse_template(payload.get("template"))
            if template is None:
                error = "template payload failed validation"
            else:
                handle.control.set_template(template)
    elif action == "shape":
        # the rail's 输出结构 SHAPE flip (报告|演示文稿), TWO lanes one
        # action: the pending shape rebinds the synthesizer's dialect at
        # the write boundary, and -- the same moment -- a canonical steer
        # notice joins the guide queue so the RESEARCHER adapts its
        # remaining rounds (slide-ready points / narrative evidence).
        # Latest flip wins; a no-op flip (same pending shape) does not
        # burn a guide slot.
        shape = str(payload.get("shape") or "")
        if shape not in ("report", "deck"):
            error = "shape must be report / deck"
        elif handle.control.set_shape(shape):
            # best-effort: a full guide queue must not block the flip --
            # the write boundary honors the pending shape either way
            handle.control.steer(
                _SHAPE_STEER[shape]["zh" if str(payload.get("lang") or "").strip().lower().startswith("zh") else "en"],
                preempt=False,
            )
    else:
        error = "action must be stop / steer / preempt / wrap / template / shape"
    if error:
        return flask.jsonify({"ok": False, "error": error}), 422
    return flask.jsonify({"ok": True})


def _keepalive_view() -> t.Any:
    """The backgrounded tab's heartbeat (the worker beats even when the
    window's timers are throttled): the detach clock restarts, so a run
    whose fetch the OS dropped in a LIVING tab keeps streaming to its
    buffer until the user returns -- a closed tab stops beating and the
    grace wrap takes over as before."""
    payload = http.token_payload(gate=_gate())
    handle = run_host.get(str(payload.get("run_key") or ""))
    if handle is None:
        return flask.jsonify({"ok": False, "error": "unknown run"}), 404
    alive = handle.touch()
    return flask.jsonify({"ok": True, "alive": alive})


def _journal_view() -> t.Any:
    """The late collector: a settled run's JOURNALED wire lines after
    ``after_seq``, NDJSON, then the stream ends -- the run is over, the
    settle rides inside the replay.  Addressed EITHER by ``run_key``
    (the starting client's reattach handle) OR by ``thread`` -- the uuid
    in the url -- for a reloaded page whose LOCAL store came up empty:
    the thread index resolves the run, and the response's FIRST line is
    the run's metadata (``{"journal": {run_key, q, mode}}``) so the
    client can seed the timeline it is about to replay.  An unknown or
    expired journal is the storage question it always was (404 -- the
    client keeps its local interrupted state and the continue path)."""
    payload = http.token_payload(gate=_gate())
    run_key = str(payload.get("run_key") or "")
    meta: dict[str, t.Any] | None = None
    if not run_key:
        thread = str(payload.get("thread") or "").strip()[:64]
        if not thread:
            flask.abort(404)
        # FAIL-OPEN: a broken journal IS the unknown journal -- 404, the
        # client keeps its local interrupted state and the continue path.
        try:
            found = run_journal.journal().latest_for_thread(thread)
        except sqlite3.Error:
            logger.warning("zjsearch run host: journal thread lookup failed", exc_info=True)
            found = None
        if found is None:
            flask.abort(404)
        run_key, q, mode = found
        meta = {"journal": {"run_key": run_key, "thread": thread, "q": q, "mode": mode}}
    try:
        after_seq = min(abs(int(payload.get("after_seq"))), 1_000_000)
    except (TypeError, ValueError):
        after_seq = 0
    try:
        lines = run_journal.journal().tail(run_key, after_seq)
    except sqlite3.Error:
        logger.warning("zjsearch run host: journal replay failed", exc_info=True)
        lines = []
    if not lines:
        flask.abort(404)
    if meta is not None:
        lines = [json.dumps(meta, ensure_ascii=False) + "\n", *lines]
    return http.streaming_response(iter(lines), "application/x-ndjson")


def install(app: flask.Flask) -> None:
    """Register the run host's channels; silent unless AI search itself
    is enabled and fully configured (the same gate as the search route --
    these channels exist to serve its runs)."""
    if not _gate():
        return
    app.add_url_rule("/zjsearch/ask/run/attach", "zjsearch_ask_run_attach", _attach_view, methods=["POST"])
    app.add_url_rule("/zjsearch/ask/run/control", "zjsearch_ask_run_control", _control_view, methods=["POST"])
    app.add_url_rule("/zjsearch/ask/run/keepalive", "zjsearch_ask_run_keepalive", _keepalive_view, methods=["POST"])
    app.add_url_rule("/zjsearch/ask/run/journal", "zjsearch_ask_run_journal", _journal_view, methods=["POST"])
