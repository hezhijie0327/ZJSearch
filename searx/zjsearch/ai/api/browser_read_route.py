# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""POST /zjsearch/browser/read: MANUAL full-page reads from the knowledge
base's directory -- the same read lane the agent's browse tool uses (the
Camoufox render, the URL guards, the readability extraction, the TTL
cache), HMAC-gated like every AI endpoint.  The knowledge base's source
rows carry only snippets until a user crawls one in full."""

import flask

from searx.extended_types import sxng_request
from searx.zjsearch.ai.api import http
from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.tools.browse import read as browse_read


def install(app: flask.Flask) -> None:
    def read_view():
        payload = http.token_payload(gate=browse_read.configured() and browser_config.ready())
        url = str(payload.get("url") or "").strip()
        if not url:
            flask.abort(422)
        try:
            title, text = browse_read.read_page(url)
        except browse_read.PageReadError as exc:
            return flask.jsonify({"error": str(exc)}), 502
        return flask.jsonify({"title": title, "markdown": text})

    app.add_url_rule("/zjsearch/browser/read", "zjs_browser_read", read_view, methods=["POST"])