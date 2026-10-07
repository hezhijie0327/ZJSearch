# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The HTTP surface: every route the theme registers, THIN.  A view
parses and authorizes the request, calls into :py:mod:`runs` (the
tasks), and wraps the result -- the HMAC prologue and the streaming
plumbing live in :py:mod:`api.http` (one definition, every endpoint).
Business logic lives in the task modules, never here."""

import flask


def install(app: flask.Flask) -> None:
    """Register every AI endpoint; chained from the package install
    (``searx.zjsearch.ai``).  Each route module stays silent unless its
    feature is enabled and fully configured."""
    from searx.zjsearch.ai.api import (  # pylint: disable=import-outside-toplevel
        decision_route,
        embed_route,
        knowledge_page,
        overview_route,
        search_route,
        tag_route,
        thread_page,
    )

    thread_page.install(app)
    knowledge_page.install(app)
    search_route.install(app)
    overview_route.install(app)
    tag_route.install(app)
    embed_route.install(app)
    decision_route.install(app)
