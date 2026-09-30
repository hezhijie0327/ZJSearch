# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the standalone thread page (``GET /ai/thread/<uuid>``).

The SERVER owns nothing but the identity: the thread lives in the
browser's storage keyed by the uuid in the url -- this route renders the
slim shell (fresh page-data capability tokens included) and the client
restores the conversation from its own store (see AiThreadPage /
threadStore).  Decoupled from the /search render on purpose (LobeHub's
conversation shape): an AI session has its own address, survives a
reload, and never depends on a search page lifecycle.
"""

import logging
import re

import flask

from searx.extended_types import sxng_request
from searx.zjsearch.ai import llm
from searx.zjsearch.ai.search.config import enabled

logger = logging.getLogger(__name__)

THEME = "zjsearch"

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def thread_page(thread_id: str) -> flask.Response:
    """Render the slim AI thread shell: the uuid validates, the theme is ours
    and the transport is configured -- everything else is client-side (the
    browser store holds the conversation; the endpoint stays stateless)."""
    if not enabled() or not llm.configured(llm.ai_cfg()):
        flask.abort(404)
    if sxng_request.preferences.get_value("theme") != THEME or not _UUID_RE.match(thread_id or ""):
        flask.abort(404)
    from searx import webapp  # pylint: disable=import-outside-toplevel,cyclic-import

    return webapp.render("ai_thread.html", ai_thread=thread_id.lower())


def install(app: flask.Flask) -> None:
    """Register the thread-page route (gated like the search route: a
    disabled feature or an unconfigured transport never registers)."""
    if not enabled() or not llm.configured(llm.ai_cfg()):
        return
    if llm.sdk_missing(llm.ai_cfg()) is not None:
        return
    app.add_url_rule("/ai/thread/<thread_id>", "zjs_ai_thread", thread_page, methods=["GET"])
