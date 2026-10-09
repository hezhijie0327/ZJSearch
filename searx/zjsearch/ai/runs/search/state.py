# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search executor: the run STATE (:class:`SearchesCore`).

One research run's mutable world lives here: the source registry (the
global ``[n]`` numbering, dedup, the gallery whitelist), the coverage
tracker, the belief ledger (facts + gaps + their wire events), the
compact ``[n]`` feed the writer reads, the model-facing budgets and the
notes appended to a round's tool results.  The BEHAVIOR around the
state is split into mixins beside this module -- :py:mod:`.gather` (the
worker pool), :py:mod:`.referee` (the decision gates) and
:py:mod:`.handlers` (the per-tool dispatch); :py:mod:`.executor`
composes them into :class:`Searches`.
"""

import json
import logging
import time
import typing as t


from searx.zjsearch.ai.runs.search import corpus
from searx.zjsearch.ai.runs.search.coverage import Coverage
from searx.zjsearch.ai.runs.search.registry import SourcesRegistry

logger = logging.getLogger(__name__)

logger = logging.getLogger(__name__)

MAX_PARALLEL = 6
"""Worker threads per parallel batch -- uncapped per-round call counts
(the model's call) queue behind these slots so a chatty round cannot
stampede the instance.  Every queued search gets to run; each engine
request carries its own per-request timeout, which is what bounds a
batch -- no artificial wall clock."""

_FEED_SOFT_LIMIT = 24_000
"""Accumulated feed size at which the executor tells the model to start
converging -- the context-pressure signal reaches the MODEL (with the
round's tool results) instead of only shaping the writer's input."""


class SearchesCore:  # pylint: disable=too-many-instance-attributes
    """The run state: registries, ledger, feed, budgets.  One research
    run owns exactly one instance (the executor class composes it with
    its behavior mixins)."""

    def __init__(  # pylint: disable=too-many-arguments
        self,
        prefs: t.Any,
        user_plugins: list[str],
        sources_base: int = 0,
        user_memories: list[dict[str, str]] | None = None,
        past_research_entries: list[dict[str, str]] | None = None,
        search_language: str = "",
        max_rounds: int = 0,
        lang: str = "",
        cfg: dict[str, t.Any] | None = None,
        registry: SourcesRegistry | None = None,
    ):
        self.prefs = prefs
        self.user_plugins = user_plugins
        self.search_language = search_language
        self.max_rounds = max_rounds
        self.lang = lang
        self.cfg = cfg or {}
        self.round_no = 0
        # the browser's user-memory snapshot (pre-sent with the run): the
        # user_memory tool searches it; saves flow back as wire events
        self.user_memories = user_memories or []
        # the saves THIS run accepted (the near-dup gate's growing side) --
        # a second save of the same fact within one run reads as duplicate
        # just like a save of a pre-existing stored fact
        self.saved_memories: list[str] = []
        # the past-research index (reader pages WITH text heads + corpus
        # sources identity-only): the tool's matches get numbered as real
        # history sources -- full-text matches return their content head,
        # source-only matches point back at web_reader for a live re-read
        self.past_research_entries = past_research_entries or []
        # the run's source registries (the [n] numbering, the two dedup
        # sets, the gallery whitelist) -- one object, see registry.py;
        # parallel SUBAGENTS share the PARENT's registry (injected), so
        # the global [n] numbering stays contiguous and the dedup sets
        # are the mechanical anti-duplication across workers
        self.reg = registry if registry is not None else SourcesRegistry(sources_base)
        # the task card's coverage tracker (coverage.py)
        self.coverage = Coverage()
        # the accumulated source feed for the WRITER: one block per search
        # (its [n] lines) and per page read -- the writer's whole context
        self.feed: list[str] = []
        # the run's inline image galleries (validated zjs-images fences):
        # index -> items -- the answer's {{zjs-gallery:i}} placeholders
        # reference these
        self.galleries: list[list[dict[str, t.Any]]] = []
        # total feed characters (the context-pressure signal for the model)
        self.feed_chars = 0
        self.size_noted = False
        # progress bookkeeping for the stall detector: fresh queries with
        # results / fresh page reads in the CURRENT round, and the
        # consecutive-round count of rounds without any
        self.round_new_hits = 0
        self.stalled_rounds = 0
        # whether the CURRENT round queued real gathering work (searches,
        # page reads, MCP calls, past-research lookups) -- a round of pure
        # bookkeeping (plan writes, learnings, memory saves) is neither
        # progress nor stall for the detector
        self.round_gathered = False
        # the rerank model's account (zjsearch.rerank): one entry per
        # endpoint call + its prompt tokens -- the settle folds it into
        # ``usage.rerank`` and the knowledge base's model stats sum it
        self.rerank_usage = {"calls": 0, "tokens": 0}
        # the decision model's account (zjsearch.decision): one entry per
        # system_one delegation + its input tokens -- the settle folds it
        # into ``usage.decision`` beside the rerank bucket
        self.decision_usage = {"calls": 0, "tokens": 0}
        # the judgment ledger: EVERY structured verdict the run hands down
        # (the model-initiated ``judge`` calls today; the framework gates
        # join in later milestones) -- purpose, the questions asked, the
        # verdicts with their confidences and the latency, folded into the
        # settled run's meta so any decision is explainable and replayable
        self.judgments: list[dict[str, t.Any]] = []
        # the BELIEF LEDGER (the learnings tool): facts the sources
        # ESTABLISHED -- revisable ({id, text, refs, status}) -- and the
        # GAPS partition (the open questions the research still owes).
        # The writer reads the active facts; the next rounds chase the
        # open gaps; the loop ends when the ledger closes.
        self.facts: list[dict[str, t.Any]] = []
        self.gaps: list[dict[str, t.Any]] = []
        self._ledger_seq = 0
        # the plan review's weak-subtask note (one shot per plan write)
        self.weak_tasks: list[str] = []
        # THIS round's new source titles (the coverage referee's evidence)
        self.round_new_titles: list[str] = []
        # whether THIS round recorded learnings (the 边做边记 discipline note)
        self.round_learned = False
        # the run's question (the pre-write evidence check's judgment target;
        # set by route at construction time)
        self.question_held: str = ""
        # the DEEP sources (head-of-feed per search) -- the pre-write
        # evidence check grades exactly these (what the writer leans on)
        self.head_sources: dict[int, dict[str, str]] = {}
        # the run's wall clock (the max_seconds budget reads it)
        self.started_at = time.monotonic()
        # the numbered entries' identity (n -> title + snippet) -- the
        # pre-write evidence check's source pool
        self.entries: dict[int, dict[str, str]] = {}
        # the coverage referee's last verdict bands ((title, band) per
        # judged subtask): the 决策结果 entry only re-emits when a band
        # CHANGES -- identical per-round verdicts are not news (the feed
        # advice keeps its cadence, the card does not)
        self._referee_signature: tuple[tuple[str, str], ...] = ()
        # the RUN CORPUS (runs.search.corpus): the report synthesizer's
        # retrievable memory -- every result/page/fact lands here while
        # the research runs; a plain answer run never reads it (zero cost)
        self.corpus = corpus.Corpus()
        # the report mode's recorded TABLE ARTIFACTS (extract_table):
        # snapshot-replace per id on the wire, per-section context at
        # synthesis time
        self.artifacts: list[dict[str, t.Any]] = []
        self._artifact_seq = 0
        # view_image 的注入队列:抓到的图作为下一轮的 user 消息回灌对话
        # (工具结果本身是文本通道,图走 user turn 是全供应商通用的形态)
        self.image_injections: list[dict[str, t.Any]] = []
        # the browser SESSION this run drives: the lead's lane ("lead")
        # or a subagent's own keyed page (v2.1 R3B -- separate tabs in
        # the mirror, one persistent context)
        self.browser_session_id: str = "lead"
        # the search's request-context TEMPLATE (app, environ, request),
        # captured NOW on the request thread: the run executes on the run
        # host's driver thread, and the search path needs a flask request
        # context per worker -- but flask's RequestContext is NOT
        # thread-safe for concurrent push/pop (one shared token stack;
        # workers interleaving dies with "token was created in a
        # different Context"), so gather CLONES a fresh context per job
        # from this template: same request/environ, private token stack.
        # No request context (unit tests) degrades to no wrapper.
        try:
            import flask  # pylint: disable=import-outside-toplevel

            from flask.globals import request_ctx  # pylint: disable=import-outside-toplevel

            ctx = request_ctx._get_current_object()  # pylint: disable=protected-access,no-member
            self._search_ctx = (ctx.app, ctx.request.environ, ctx.request)
            # the RESULT SERIALIZATION (feed.py's pretty-url / proxified
            # image building) touches current_app -- the driver thread
            # has no app context of its own, so the app object rides
            # along and gather wraps the settlement in app_context()
            self._flask_app = flask.current_app._get_current_object()  # pylint: disable=protected-access,no-member
        except (ImportError, RuntimeError):
            self._search_ctx = None
            self._flask_app = None

    def drain_image_injections(self) -> list[dict[str, t.Any]]:
        """view_image's fetched pictures, drained into the next model turn
        as user messages (the loop consults this after each executor batch)."""
        out = self.image_injections
        self.image_injections = []
        return out

    def ledger_open_items(self) -> tuple[list[str], list[str]]:
        """The ledger's OPEN items: (open subtask titles, open gap
        questions).  The loop's continuation contract reads this -- a run
        may stop researching only when BOTH lists are empty (or the
        budget says otherwise)."""
        tasks = [str(task.get("title") or "") for task in self.coverage.task_list if task.get("status") != "done"]
        gaps = [str(gap.get("q") or "") for gap in self.gaps if gap.get("status") == "open"]
        return tasks, gaps

    def apply_learnings(self, ops: dict[str, t.Any], rnd: int) -> tuple[int, int, int]:
        """Apply one ``learnings`` call's operations to the belief ledger:
        new/superseding/retracting facts and opened/closed gaps.  Returns
        ``(facts_written, gaps_opened, gaps_closed)`` for the row's feed
        echo.  Superseding/retracting RETIRES the old fact (status flips,
        history stays -- the wire snapshot carries the full ledger)."""
        written = 0
        by_id = {fact["id"]: fact for fact in self.facts}
        for op in ops.get("facts") or []:
            self._ledger_seq += 1
            fact = {
                "id": self._ledger_seq,
                "text": str(op.get("text") or ""),
                "refs": op.get("refs") or [],
                "status": "active",
                "round": rnd,
            }
            for key in ("supersedes", "retracts"):
                target = by_id.get(op.get(key))
                if target is not None and target["status"] == "active":
                    target["status"] = "superseded" if key == "supersedes" else "retracted"
            self.facts.append(fact)
            by_id[fact["id"]] = fact
            self.corpus.add(fact["text"], ref_n=int((fact.get("refs") or [0])[0] or 0), kind="fact")
            written += 1
        opened = 0
        known_gaps = {str(gap.get("q") or "").lower() for gap in self.gaps}
        for op in ops.get("open_gaps") or []:
            q = str(op.get("q") or "")
            if q.lower() in known_gaps:
                continue
            known_gaps.add(q.lower())
            self._ledger_seq += 1
            self.gaps.append(
                {
                    "id": self._ledger_seq,
                    "q": q,
                    "why": str(op.get("why") or ""),
                    "status": "open",
                    "close_as": "",
                    "round": rnd,
                }
            )
            opened += 1
        closed = 0
        for op in ops.get("close_gaps") or []:
            q = str(op.get("q") or "").lower()
            for gap in self.gaps:
                if str(gap.get("q") or "").lower() == q and gap["status"] == "open":
                    gap["status"] = "closed"
                    gap["close_as"] = str(op.get("close_as") or "")
                    closed += 1
        return written, opened, closed

    def ledger_echo(self) -> str:
        """The tool feed's ledger summary -- the per-round injection that
        keeps the model aiming at its own gaps (the researcher reads this
        result before the next turn composes)."""
        active = sum(1 for fact in self.facts if fact["status"] == "active")
        open_gaps = [gap for gap in self.gaps if gap["status"] == "open"]
        lines = [f"LEDGER: {active} active fact(s)."]
        if open_gaps:
            shown = "\n".join(f"  {index}. {gap['q']}" for index, gap in enumerate(open_gaps[:5], 1))
            lines.append(f"Open gaps ({len(open_gaps)}):\n{shown}")
        else:
            lines.append("Open gaps: none.")
        return "\n".join(lines)

    @property
    def next_n(self) -> int:
        """The global [n] counter (the route's past-source numbering base
        continues after it)."""
        return self.reg.next_n

    @next_n.setter
    def next_n(self, value: int) -> None:
        self.reg.next_n = value

    @staticmethod
    def _raw_json(call: dict[str, t.Any]) -> dict[str, t.Any]:
        """The model's raw call arguments as a dict (the MCP bridge passes
        them to the server verbatim under the tool's own schema)."""
        try:
            value = json.loads(str(call.get("arguments") or "") or "{}")
        except ValueError:
            return {}
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _append_note(feeds: list[str | None], note: str) -> None:
        """Append a model-facing note to the LAST non-empty feed of the
        round -- one copy is enough (the model reads every tool result of
        the batch).  The rebind deliberately leaves the writer's ``feed``
        blocks untouched: notes steer the conversation, they are not
        source content."""
        for i in range(len(feeds) - 1, -1, -1):
            if feeds[i]:
                feeds[i] = f"{feeds[i]}\n\n{note}"
                return
