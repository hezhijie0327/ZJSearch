# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``POST /zjsearch/browser/input`` endpoint: the Lightbox
takeover's input forwarding -- the user's clicks/wheel/keys on the live
mirror land here and are executed on the interactive session's page
(viewport-space coordinates; the SSRF gate already guards any navigation
these inputs trigger, model actions and user actions share it).  The
stack's first client-to-server live channel: the run's NDJSON stays
one-way server-to-client."""

import logging

import flask

from searx.zjsearch.ai.api import http
from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.browser import session

logger = logging.getLogger(__name__)

_MAX_TEXT = 500
"""One forwarded typing's character budget -- the keyboard bar sends
short field fills, not essays."""


def _browser_input_view() -> flask.Response:
    payload = http.token_payload(gate=browser_config.ready())
    kind = str(payload.get("type") or "")
    # the takeover is the LEAD session's surface (v2.1 R3B): a subagent
    # session's tab is a read-only mirror -- the human's hands drive the
    # lane the run blocks on
    session_id = str(payload.get("session") or "lead")
    if session_id != "lead":
        return flask.jsonify({"error": "the takeover drives the lead session only"}), 422
    if kind == "done":
        session.finish_wait(session_id)
        return flask.jsonify({"ok": True})
    if kind not in ("click", "drag", "wheel", "type", "key", "back", "forward", "reload"):
        return (
            flask.jsonify({"error": "type must be click / drag / wheel / type / key / back / forward / reload"}),
            422,
        )
    try:
        session.session_input(
            session_id,
            kind,
            x=int(payload.get("x") or 0),
            y=int(payload.get("y") or 0),
            delta_y=int(payload.get("deltaY") or 0),
            text=str(payload.get("text") or "")[:_MAX_TEXT],
            key=str(payload.get("key") or "")[:24],
            x2=int(payload.get("x2") or 0),
            y2=int(payload.get("y2") or 0),
        )
    except session.SessionError as exc:
        return flask.jsonify({"error": str(exc)}), 502
    # every forwarded input returns a FRESH frame: between the model's
    # settlements the takeover would otherwise stare at the stale prior
    # frame (fatally so for back/forward/reload, whose whole effect IS the
    # new page) -- the client overlays it locally until the next wire
    # frame supersedes it.  A failed capture still answers ok (the action
    # ran; the stale frame stays the truth it was).
    try:
        return flask.jsonify({"ok": True, "frame": session.frame(session_id)})
    except Exception:  # pylint: disable=broad-exception-caught
        logger.warning("zjsearch_browser_input: post-action frame capture failed", exc_info=True)
        return flask.jsonify({"ok": True})


def install(app: flask.Flask) -> None:
    """Register the input route; chained from the ``searx.zjsearch.ai``
    package install.  Silent when the built-in browser is not ready."""
    if not browser_config.ready():
        return
    app.add_url_rule("/zjsearch/browser/input", "zjsearch_browser_input", _browser_input_view, methods=["POST"])
