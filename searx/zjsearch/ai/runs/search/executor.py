# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the tool executor -- the composed :class:`Searches`.

The class is the UNION of its parts: the run state
(:py:mod:`.state`), the worker pool (:py:mod:`.gather`), the decision
gates (:py:mod:`.referee`) and the per-tool dispatch
(:py:mod:`.handlers`).  It yields the feature events for the wire
protocol and ends with the agent engine's ``("tool_results", ...)``
alignment; the progress machinery -- the budget notes and the stall
detector -- lives in :py:mod:`.progress`."""

from searx.zjsearch.ai.runs.search.gather import GatherMixin
from searx.zjsearch.ai.runs.search.handlers import DispatchMixin
from searx.zjsearch.ai.runs.search.referee import RefereeMixin
from searx.zjsearch.ai.runs.search.state import SearchesCore


class Searches(DispatchMixin, RefereeMixin, GatherMixin, SearchesCore):
    """The ``web_search`` executor: real instance searches in a worker
    pool.  Yields the feature events for the wire protocol and ends with
    the agent framework's ``("tool_results", ...)`` alignment."""
