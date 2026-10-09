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

    @classmethod
    def child(cls, parent: "Searches", max_rounds: int, session_id: str | None = None) -> "Searches":
        """A SUBAGENT's executor (v2.1 R3): the parent's source registry
        is SHARED (contiguous [n] + mechanical dedup across workers) and
        the request-bound search wrapper is inherited (the driver thread
        has no request context of its own); everything else -- feed,
        ledger, coverage, corpus -- is the child's PRIVATE world, and the
        round budget is the delegation's small cap.  ``session_id`` gives
        the child its OWN browser session (R3B's keyed tab)."""
        child = cls(
            parent.prefs,
            parent.user_plugins,
            sources_base=0,
            search_language=parent.search_language,
            max_rounds=max_rounds,
            lang=parent.lang,
            cfg=parent.cfg,
        )
        child.reg = parent.reg
        if session_id:
            child.browser_session_id = session_id
        # the child was constructed on the DRIVER thread (no request
        # context there): inherit the parent's captured context TEMPLATE
        # so the child's searches can clone contexts per job
        child._search_ctx = parent._search_ctx  # pylint: disable=protected-access
        return child
