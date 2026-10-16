# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The HTTP surface: every route the theme registers, THIN.  A view
parses and authorizes the request, calls into :py:mod:`runs` (the
tasks), and wraps the result -- the HMAC prologue and the streaming
plumbing live in :py:mod:`api.http` (one definition, every endpoint).
Business logic lives in the task modules, never here.

NAMING (the URL is the product contract; the module file mirrors it):

- ``/zjsearch/ask/*`` -- the AI research conversation domain: the run
  stream, the run host's ``run/*`` actions, the thread/overview pages,
  and the decision model proxy.  Every URL's LAST segment is the
  module's feature name (``overview_route`` owns ``/ai/overview``).
- ``/zjsearch/knowledge/*`` -- the KNOWLEDGE BASE's backend services
  (embed / rerank / tags normalization), consumed by the
  ``/zjsearch/knowledge`` page and the browser-local store (the page is
  the GET shell at the namespace root; the services are POSTs under it).
- ``/zjsearch/browser/*`` -- the interactive browser session domain
  (the takeover's input forwarding).

Module files: ``*_route.py`` register POST APIs, ``*_page.py`` register
GET page shells.  Flask endpoints follow
``zjsearch_<domain>_<name>``."""

import flask


def install(app: flask.Flask) -> None:
    """Register every AI endpoint; chained from the package install
    (``searx.zjsearch.ai``).  Each route module stays silent unless its
    feature is enabled and fully configured."""
    from searx.zjsearch.ai.api import (  # pylint: disable=import-outside-toplevel
        browser_input_route,
        decision_route,
        embed_route,
        knowledge_page,
        overview_route,
        recall_route,
        rerank_route,
        run_host_route,
        search_route,
        tags_route,
        thread_page,
        debug_page,
    )

    thread_page.install(app)
    debug_page.install(app)
    knowledge_page.install(app)
    search_route.install(app)
    overview_route.install(app)
    decision_route.install(app)
    run_host_route.install(app)
    recall_route.install(app)
    # the KB trio (embed / rerank / tags) and the browser session's input
    # channel: their domains live outside /ai, their implementation home
    # is this package
    tags_route.install(app)
    embed_route.install(app)
    rerank_route.install(app)
    browser_input_route.install(app)
