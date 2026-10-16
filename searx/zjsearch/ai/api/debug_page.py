# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The AI stack's DEBUG STAGE shells
(``GET /zjsearch/debug/{thread,overview}``).

Two QA surfaces served as page shells -- the payloads are just page
identities, the fixture streams run client-side (AiDebugStage).  They
live under their own ``/debug`` namespace ON PURPOSE: these are QA
tools, not product surface, and grouping them keeps the production
namespaces (``/ask/*``) free of test addresses.  Gated like the
production pages."""

import flask

from searx.extended_types import sxng_request
from searx.zjsearch.ai.llm import config as llm_config
from searx.zjsearch.ai.llm import sdk as sdk_registry
from searx.zjsearch.ai.runs.profile import enabled

THEME = "zjsearch"


def _gated() -> bool:
    """The production pages' gate: the feature on, the transport
    configured, our theme active."""
    if not enabled() or not llm_config.configured(llm_config.llm_cfg()):
        return False
    return sxng_request.preferences.get_value("theme") == THEME


def thread_debug_page() -> flask.Response:
    """The thread debug stage's shell: renders ``thread.html`` with the
    literal ``debug`` thread id -- the client diverts on the payload and
    streams the fixture scripts."""
    if not _gated():
        flask.abort(404)
    from searx import webapp  # pylint: disable=import-outside-toplevel

    return webapp.render("thread.html", ai_thread="debug")


def overview_debug_page() -> flask.Response:
    """The AI Overview debug stage's shell: the payload is just the page
    identity (the overview fixture streams live client-side)."""
    if not _gated():
        flask.abort(404)
    from searx import webapp  # pylint: disable=import-outside-toplevel

    return webapp.render("debug_overview.html")


def install(app: flask.Flask) -> None:
    """Register the debug-stage routes (gated like the production
    pages)."""
    if not enabled() or not llm_config.configured(llm_config.llm_cfg()):
        return
    if sdk_registry.sdk_missing(llm_config.llm_cfg()) is not None:
        return
    app.add_url_rule("/zjsearch/debug/thread", "zjs_debug_thread", thread_debug_page, methods=["GET"])
    app.add_url_rule("/zjsearch/debug/overview", "zjs_debug_overview", overview_debug_page, methods=["GET"])
