# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``POST /zjsearch/ai/browser/input`` endpoint: the Lightbox
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
    if kind == "done":
        session.finish_wait()
        return flask.jsonify({"ok": True})
    if kind not in ("click", "wheel", "type", "key"):
        return flask.jsonify({"error": "type must be click / wheel / type / key"}), 422
    try:
        session.session_input(
            kind,
            x=int(payload.get("x") or 0),
            y=int(payload.get("y") or 0),
            delta_y=int(payload.get("deltaY") or 0),
            text=str(payload.get("text") or "")[:_MAX_TEXT],
            key=str(payload.get("key") or "")[:24],
        )
    except session.SessionError as exc:
        return flask.jsonify({"error": str(exc)}), 502
    return flask.jsonify({"ok": True})


def install(app: flask.Flask) -> None:
    """Register the input route; chained from the ``searx.zjsearch.ai``
    package install.  Silent when the built-in browser is not ready."""
    if not browser_config.ready():
        return
    app.add_url_rule("/zjsearch/ai/browser/input", "zjsearch_ai_browser_input", _browser_input_view, methods=["POST"])
