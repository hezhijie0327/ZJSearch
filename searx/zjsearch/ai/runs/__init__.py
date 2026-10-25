# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The concrete tasks on the agent engine: AI Search
(:py:mod:`runs.search`) and the Report output shape
(:py:mod:`runs.report`), plus the shared mode/budget profile (:py:mod:`runs.profile` -- the AI
Overview is the search machinery's internal "overview" tier now, not a
task module of its own).  The HTTP
surface lives in :py:mod:`api` -- this package is import-safe from
everywhere (its root pulls :py:mod:`profile` only, so task modules and
route modules can both depend on it without a cycle)."""

from searx.zjsearch.ai.runs.profile import capability, overview_capability, overview_enabled

__all__ = ["capability", "overview_capability", "overview_enabled"]


def install(app) -> None:
    """Chain the API installs (lazy: the api package imports the route
    modules, which import back into this package's leaf modules -- the
    deferral keeps the import graph acyclic)."""
    from searx.zjsearch.ai.api import install as api_install  # pylint: disable=import-outside-toplevel

    api_install(app)
