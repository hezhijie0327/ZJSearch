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

import logging
import json
import logging
import queue
import threading
import time
import typing as t


from searx.zjsearch.ai.runs.search import audit
from searx.zjsearch.ai.runs.search import corpus
from searx.zjsearch.ai.runs.search.coverage import Coverage
from searx.zjsearch.ai.runs.search.registry import SourcesRegistry

logger = logging.getLogger(__name__)

SUB_ENTRY_BASE = 10_000
"""The subagents' wire entry-id space (the lead's counter never reaches
it): client groups a sub's think/call events under the `open kind:"sub"`
row by id.  One 64-slot stride per subagent, allocated from the run's
REGISTRY sequence -- stable across delegation batches, so a follow-up's
resumed stream re-opens the SAME row instead of colliding into another
batch's (the old per-batch ``job_idx`` ids reused the space every
delegation round)."""

SUB_SERIALIZE_CHILD_MAX = 150_000
"""Serialized conversation chars kept for ONE archived subagent (the
CONTINUE checkpoint's per-child budget; older messages drop first)."""

SUB_SERIALIZE_TOTAL_MAX = 600_000
"""The registry's total serialization budget (oldest children beyond it
are listed under ``dropped`` instead of archived)."""


class ChildControl:
    """One subagent's inbound control plane: the stop flag the event
    pump sets when the RUN's stop/preempt fires, read by the agent loop
    through the same duck-typed surface as the run host's ControlBox
    (``directives`` / ``interrupt`` / ``poll_steer`` / ``drain_steers``).
    A resume RESETS the flag -- a follow-up re-engages the subagent even
    if a previous batch was stopped early."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop = False

    def stop(self) -> None:
        with self._lock:
            self._stop = True

    def reset(self) -> None:
        with self._lock:
            self._stop = False

    @property
    def stopped(self) -> bool:
        with self._lock:
            return self._stop

    def directives(self) -> list[dict[str, str]]:
        return [{"action": "stop"}] if self.stopped else []

    def interrupt(self) -> tuple[str, str] | None:
        return ("stop", "") if self.stopped else None

    def poll_steer(self) -> str | None:
        return None

    def drain_steers(self) -> list[str]:
        return []


class SubagentHandle:
    """One delegation's LIVE record in the run's registry: the stable
    identity (``key`` = the digest's 【子任务 Sn】 tag, the wire id space
    slot ``seq``), the child's OWN conversation (``messages`` mutates in
    place as the loop runs -- a follow-up appends and re-runs it), its
    control plane, and the PROMOTION MARKS that keep the parent-side
    fold delta-only across repeated settlements."""

    def __init__(
        self,
        key: str,
        seq: int,
        parsed: dict[str, str],
        messages: list[dict[str, t.Any]],
        child: t.Any,
        control: ChildControl,
    ) -> None:
        self.key = key
        self.seq = seq
        self.parsed = parsed
        self.messages = messages
        self.child = child
        self.control = control
        self.followups = 0
        self.stopped = False
        # the BACKGROUND promotion (C2): True while a loop is running for
        # this handle (foreground batch OR a late-lane resume);
        # message_subtask queues onto ``pending_messages`` instead of
        # refusing, and the settling lane chains them
        self.busy = False
        self.pending_messages: list[str] = []
        # the parent-fold bookkeeping: feed/judgment/gate positions, the
        # spend snapshots and the absorbed corpus-chunk identities -- all
        # read AFTER each settlement, so a resume promotes only the new
        # material
        self.feed_mark = 0
        self.judgment_mark = 0
        self.gate_mark = 0
        self.rerank_snap: dict[str, int] = {}
        self.decision_snap: dict[str, int] = {}
        self.corpus_seen: set[int] = set()

    @property
    def gid(self) -> int:
        return SUB_ENTRY_BASE + (self.seq - 1) * 64


def state_block(
    core: "SearchesCore",
    *,
    include_tasks: bool = True,
    source_limit: int = 60,
) -> str:
    """The AUTHORITATIVE state block rendered for compaction summary
    injections (and future resumes): the belief ledger, the open gaps,
    the task card and the ``[n]`` source table -- mechanically rendered
    from the run state, never from the summary model's prose (a fact the
    summary drops still reaches the next turn through here)."""
    lines: list[str] = ["<authoritative_state>"]
    facts = [f for f in core.facts if f.get("status") == "active"]
    if facts:
        lines.append("<findings>")
        for fact in facts[:40]:
            refs = ",".join(str(n) for n in (fact.get("refs") or [])[:6])
            mark = f" [{refs}]" if refs else ""
            lines.append(f"- {str(fact.get('text') or '')[:400]}{mark}")
        lines.append("</findings>")
    gaps = [g for g in core.gaps if g.get("status") == "open"]
    if gaps:
        lines.append("<open_gaps>")
        for gap in gaps[:12]:
            lines.append(f"- {str(gap.get('q') or '')[:200]}")
        lines.append("</open_gaps>")
    tasks = getattr(core.coverage, "task_list", None) if include_tasks else None
    if tasks:
        done = sum(1 for item in tasks if item.get("status") == "done")
        lines.append(f'<plan completed="{done}/{len(tasks)}">')
        for item in tasks[:12]:
            lines.append(f"- [{item.get('status')}] {str(item.get('title') or '')[:200]}")
        lines.append("</plan>")
    entries = getattr(core, "entries", None) or {}
    if entries:
        lines.append(f'<sources total="{len(entries)}">')
        for n in sorted(entries)[-source_limit:]:
            entry = entries[n]
            lines.append(f"[{n}] {str(entry.get('title') or '')[:100]}")
        lines.append("</sources>")
    lines.append("</authoritative_state>")
    return "\n".join(lines)


def serialize_subagents(core: "SearchesCore") -> dict[str, t.Any]:
    """The registry's CONTINUE-checkpoint form: per child the identity,
    the brief, the conversation (JSON-safe), the follow-up count and its
    ledger -- everything a resumed run needs to keep addressing the SAME
    subagent with message_subtask.  The promotion marks do NOT travel
    (they must restart at zero against the fresh child).  Oversized
    children drop their oldest messages; children beyond the total
    budget are listed under ``dropped``."""
    handles = getattr(core, "subagents", None)
    if not handles:
        return {}
    out: dict[str, t.Any] = {}
    total = 0
    dropped: list[str] = []
    for key in sorted(handles, key=lambda k: handles[k].seq):
        handle = handles[key]
        if total >= SUB_SERIALIZE_TOTAL_MAX:
            dropped.append(key)
            continue
        messages = json.loads(json.dumps(handle.messages, ensure_ascii=False, default=str))
        trimmed = False
        while len(json.dumps(messages, ensure_ascii=False)) > SUB_SERIALIZE_CHILD_MAX and len(messages) > 2:
            del messages[1 if (messages[0].get("role") == "system") else 0]
            trimmed = True
        blob = json.dumps(messages, ensure_ascii=False)
        total += len(blob)
        out[key] = {
            "key": handle.key,
            "seq": handle.seq,
            "followups": handle.followups,
            "parsed": dict(handle.parsed),
            "messages": messages,
            "trimmed": trimmed,
            "facts": [
                {"text": f.get("text"), "refs": f.get("refs") or []}
                for f in handle.child.facts
                if f.get("status") == "active"
            ][:40],
            "gaps": [
                {"q": g.get("q"), "why": g.get("why")}
                for g in handle.child.gaps
                if g.get("status") != "closed"
            ][:20],
        }
    if dropped:
        out["dropped"] = dropped
    return out


def restore_subagents(
    core: "SearchesCore",
    archived: dict[str, t.Any],
    child_factory: t.Callable[["SearchesCore", str], t.Any],
) -> None:
    """Re-hydrate the serialized registry after a CONTINUE: each handle
    gets a FRESH child executor (its own ledger/facts are restored from
    the archive; its corpus/feed start empty -- the parent already
    folded those, and the promotion marks restart at zero against the
    fresh child).  ``child_factory(parent, key)`` builds the child."""
    if not isinstance(archived, dict):
        return
    top_seq = getattr(core, "_sub_seq", 0) or 0
    for key, data in archived.items():
        if key == "dropped" or not isinstance(data, dict):
            continue
        if not str(key).startswith("S") or core.subagents.get(key) is not None:
            continue
        messages = data.get("messages")
        if not isinstance(messages, list) or not messages:
            continue
        parsed = data.get("parsed") if isinstance(data.get("parsed"), dict) else {
            "title": key,
            "objective": "",
            "output_format": "",
            "tool_guidance": "",
            "boundaries": "",
        }
        try:
            seq = int(data.get("seq") or 0)
        except (TypeError, ValueError):
            seq = 0
        child = child_factory(core, str(key))
        for index, fact in enumerate(data.get("facts") or []):
            if isinstance(fact, dict) and fact.get("text"):
                child.facts.append(
                    {
                        "id": index + 1,
                        "text": str(fact.get("text")),
                        "refs": fact.get("refs") or [],
                        "status": "active",
                        "round": 0,
                    }
                )
        for index, gap in enumerate(data.get("gaps") or []):
            if isinstance(gap, dict) and gap.get("q"):
                child.gaps.append(
                    {
                        "id": 10_000 + index,
                        "q": str(gap.get("q")),
                        "why": str(gap.get("why") or ""),
                        "status": "open",
                        "close_as": "",
                        "round": 0,
                    }
                )
        handle = SubagentHandle(
            str(key),
            seq,
            {field: str(parsed.get(field) or "")[:600] for field in
             ("title", "objective", "output_format", "tool_guidance", "boundaries")},
            messages,
            child,
            ChildControl(),
        )
        try:
            handle.followups = max(0, min(int(data.get("followups") or 0), 99))
        except (TypeError, ValueError):
            pass
        core.subagents[str(key)] = handle
        top_seq = max(top_seq, seq)
    core._sub_seq = max(getattr(core, "_sub_seq", 0) or 0, top_seq)


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

    def __init__(  # pylint: disable=too-many-arguments, too-many-statements
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
        # plan_review's plan_complete verdict: the deliverable entities the
        # current plan still does not cover (consumed by the task_write
        # feed, then cleared -- one note per plan write)
        self.entity_gap: list[str] = []
        # the deliverable-entity heuristic: entities the FINAL answer
        # depends on understanding that no planned subtask covers (the
        # report outline's screen fills it before the run; the single-write
        # entity gate fills it on the first task_write).  The researcher's
        # <deliverable_entities> block and plan_review's plan_complete
        # question consume it.
        self.deliverable_entities: list[str] = []
        # the single-write entity gate runs ONCE, on the first task_write
        self.entity_gate_done = False
        # the run's attachments (sanitized {name, text}), the entity gate's
        # extraction context (the attachment may name the actors the answer
        # makes claims about)
        self.attached_files: list[dict[str, str]] = []
        # the route's gate-usage list, RE-BOUND onto the state (the route
        # assigns the same list object): loop-side gate completions (the
        # entity gate's extraction) append here and fold into the settle's
        # gates bucket through the route's own accounting
        self.gate_usage: list[dict[str, t.Any]] = []
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
        self.corpus = corpus.Corpus(usage=self.rerank_usage)
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
        # THE SUBAGENT REGISTRY (the follow-up channel's backbone): every
        # delegation mints one SubagentHandle -- stable key (S1, S2, ...)
        # and wire id slot for the whole run -- and a settled subagent
        # STAYS here, conversation and all, so message_subtask can resume
        # it.  Children (nested runs) carry their own empty registry.
        self.subagents: dict[str, SubagentHandle] = {}
        self._sub_seq = 0
        # the LEAD's inbound control plane (the run host's ControlBox;
        # the route assigns it): the event pump polls it non-destructively
        # so a user stop/preempt reaches the running subagents.  A child
        # stays None (it observes nothing above its own box).
        self.run_control: t.Any = None
        # the BACKGROUND lane (C2): backgrounded subagents' remapped wire
        # events and their settled digests queue here between the round
        # boundaries -- the loop drains both at the top of every round
        # (``drain_late``) and once more before the write phase opens
        self.late_events: "queue.Queue[dict[str, t.Any]]" = queue.Queue()
        self.pending_results: list[dict[str, str]] = []
        self.pending_lock = threading.Lock()
        self.late_lanes: list[threading.Thread] = []
        # the task-card cadence reminder's last round (B2)
        self.last_plan_reminder_round = 0
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

    def drain_late(self) -> tuple[list[dict[str, t.Any]], list[dict[str, t.Any]]]:
        """The loop's round-boundary flush: the late lane's queued wire
        events (yielded verbatim -- sub rows carry their own ids), then
        the settled digests as ``<task_result>`` user messages the model
        reads before the next turn composes."""
        events: list[dict[str, t.Any]] = []
        while True:
            try:
                events.append(self.late_events.get_nowait())
            except queue.Empty:
                break
        with self.pending_lock:
            results, self.pending_results = self.pending_results, []
        messages = [
            {
                "role": "user",
                "content": f"<task_result subagent=\"{result['handle']}\">\n{result['digest']}\n</task_result>",
            }
            for result in results
        ]
        return events, messages

    def wait_for_lanes(self, timeout: float) -> None:
        """The write boundary's bounded wait for backgrounded lanes."""
        deadline = time.monotonic() + max(0.0, timeout)
        for thread in list(self.late_lanes):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            if thread.is_alive():
                thread.join(timeout=remaining)

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
        history stays -- the wire snapshot carries the full ledger).  A
        new fact that REPEATS an active one lands on two floors: the
        EXACT text merges its refs into the survivor (the resume
        channel's wholesale re-apply -- a follow-up's second promotion
        must not re-append the child's whole ledger), and the embedding
        nearest-neighbour (the small-model pathology where one fact
        lands three ways) merges the same way; both fail safe."""
        written = 0
        by_id = {fact["id"]: fact for fact in self.facts}
        active = [fact for fact in self.facts if fact["status"] == "active"]
        exact_texts = {str(fact.get("text") or "").strip().lower(): fact for fact in active}
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
            survivor: dict[str, t.Any] | None = None
            if fact["text"] and fact["text"].strip().lower() in exact_texts:
                survivor = exact_texts[fact["text"].strip().lower()]
            else:
                dup = audit.near_duplicate(fact["text"], [item["text"] for item in active])
                if dup is not None:
                    survivor = active[dup]
            if survivor is not None:
                old_refs = survivor.get("refs") or []
                survivor["refs"] = list(dict.fromkeys([*old_refs, *fact["refs"]]))[:8]
                continue
            self.facts.append(fact)
            by_id[fact["id"]] = fact
            active.append(fact)
            exact_texts[fact["text"].strip().lower()] = fact
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
