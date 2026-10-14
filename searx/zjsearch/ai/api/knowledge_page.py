# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The knowledge-base page (``GET /zjsearch/knowledge``).

Like the thread page, the SERVER owns nothing but the shell: the
knowledge base lives entirely in the browser's PGlite store -- this
route renders the slim frame (fresh page-data capability tokens
included) and the client renders the library from its own database.
Gated like every AI route: a disabled feature or an unconfigured
transport never registers (the header button hides with the tokens)."""

import flask

from searx.extended_types import sxng_request
from searx.zjsearch.ai.llm import config as llm_config
from searx.zjsearch.ai.llm import sdk as sdk_registry
from searx.zjsearch.ai.runs.profile import enabled

THEME = "zjsearch"


def knowledge_page() -> flask.Response:
    """Render the knowledge-base shell: the theme is ours and the
    transport is configured -- everything else is client-side."""
    if not enabled() or not llm_config.configured(llm_config.llm_cfg()):
        flask.abort(404)
    if sxng_request.preferences.get_value("theme") != THEME:
        flask.abort(404)
    from searx import webapp  # pylint: disable=import-outside-toplevel,cyclic-import

    return webapp.render("knowledge.html")


def install(app: flask.Flask) -> None:
    """Register the knowledge-page route (gated like the thread page)."""
    if not enabled() or not llm_config.configured(llm_config.llm_cfg()):
        return
    if sdk_registry.sdk_missing(llm_config.llm_cfg()) is not None:
        return
    app.add_url_rule("/zjsearch/knowledge", "zjs_knowledge", knowledge_page, methods=["GET"])
