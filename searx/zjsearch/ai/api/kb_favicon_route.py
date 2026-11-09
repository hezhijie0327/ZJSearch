# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""POST /zjsearch/knowledge/favicon: the THEME's favicon channel (the
url keeps its knowledge birth home) -- the same machinery the classic
results wear (searx.favicons.proxy: the resolver preference, the
server cache, the data-URL fast path, the signed proxy route).  The
consumers' hosts never pass the template serialization -- the
knowledge store rows, and the citation panels' page-read / browser /
recalled sources that ride the wire with favicon:"" -- so the client
asks per host (HMAC page token like every theme route)."""

import flask

from searx.zjsearch.ai.api import http


def install(app: flask.Flask) -> None:
    def favicon_view():
        payload = http.token_payload(gate=True)
        host = str(payload.get("host") or "").strip()
        if not host:
            flask.abort(422)
        from searx.favicons.proxy import favicon_url  # pylint: disable=import-outside-toplevel

        return flask.jsonify({"favicon": favicon_url(host) or ""})

    app.add_url_rule("/zjsearch/knowledge/favicon", "zjs_knowledge_favicon", favicon_view, methods=["POST"])
