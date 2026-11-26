# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

"""The delegation machinery of the search run handler
(subagent spawn/interleave/follow-up drives): one mixin of the
DispatchMixin composition."""

# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search executor: the TOOL DISPATCH.

:class:`DispatchMixin` owns :py:meth:`execute` -- one round of model
calls turned into tool executions and wire events -- plus the per-call
plan builder (``_search_plan``: the dedup key, the pool job and the
receipt scaffolding) and the decision-model verdict formatting.  Meta
tools (calculate, ledger writes, MCP, memory) run INLINE; the network
jobs (``search_web``) defer to :py:mod:`.gather`'s pool -- the browse
tool is the serialized session lane (open -> read, tabs, viewport)."""

import logging
import typing as t
import queue
import threading
import time
from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.core.config import zj_block
from searx.zjsearch.ai.tools import browse as browse_tool
from searx.zjsearch.ai.browser import session as browser_session
from searx.zjsearch.ai.tools.rows import display_item
from searx.zjsearch.ai.prompts import spine
from searx.zjsearch.ai.prompts.subagent import SUB_ROUNDS, SUB_STALL_ROUNDS, subagent_messages
from searx.zjsearch.ai.tools.message_subtask import FOLLOWUP_MAX
from searx.zjsearch.ai.runs.search.progress import (
    round_progress,
)
from searx.zjsearch.ai.runs.search.state import (
    ChildControl,
    SubagentHandle,
    state_block,
)

logger = logging.getLogger(__name__)




def _sub_display_rows(calls: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    """The subagent's ``calls``-event rows: the SAME builder the lead's
    route uses (``tools.rows.display_item``).  Without it the loop's
    ``_noop_display`` mints ``q: ""`` stubs -- a child's rows rendered as
    bare tool icons (no query, no url, no raw-args pane)."""
    return [display_item(idx, call) for idx, call in enumerate(calls, 1)]



def subagents_auto_background_ms() -> int:
    """The delegation batch's foreground deadline (``zjsearch.subagents
    .auto_background_ms``, default 180_000) -- past it, still-running
    children are promoted to the run's BACKGROUND lane and the lead
    continues researching.  ``0`` disables the promotion."""
    raw = zj_block("subagents")
    try:
        value = int(raw.get("auto_background_ms", 180_000))
    except (TypeError, ValueError):
        return 180_000
    return max(0, value)


class SubagentsMixin:
    def _sub_toolset(self) -> list[dict[str, t.Any]]:
        """The SUBAGENT's toolset: the shared discipline tools -- search,
        calculate, the deployment inventory, the findings ledger (the
        child's LEDGER IS its digest), page reads, the browser session and
        the structured evaluate call.  Built per delegation pass: the
        availability flags are the RUN's.  The child's LEDGER IS its
        digest: the delegation contract promises the lead "facts + gaps +
        the source lines", and ``_sub_digest`` builds exactly that from
        ``child.facts``/``child.gaps`` -- which only the record_findings
        tool writes.  Evaluate rides the same gate as the lead's -- a
        structured tie-break is exactly what a worker without the lead's
        context needs."""
        from searx.zjsearch.ai.tools import (  # pylint: disable=import-outside-toplevel
            TOOL_INSTRUCTIONS,
            calculate_spec,
            record_findings_spec,
            evaluate_spec,
            list_engines_spec,
            search_web_spec,
        )

        browser_on = browser_config.ready()
        specs = (
            [search_web_spec(browser_on, with_info=True), calculate_spec(), list_engines_spec(), record_findings_spec()]
            + ([browse_tool.browse_spec()] if browser_on else [])
            # the evaluate tool needs no availability gate: the chat
            # fallback (llm.decision.judge_via_chat) serves it when the
            # decision model is absent -- a worker's tie-break must not
            # depend on a deployment's optional model
            + [evaluate_spec()]
        )
        self._sub_tool_notes = [
            (str(spec["name"]), TOOL_INSTRUCTIONS[str(spec["name"])])
            for spec in specs
            if str(spec["name"]) in TOOL_INSTRUCTIONS
        ]
        return specs

    def _register_subagent(
        self,
        parsed: dict[str, str],
        lang: str,
        tool_notes: list[tuple[str, str]] | None = None,
    ) -> SubagentHandle:
        """Mint one delegation's handle: the run's stable key (S1, S2,
        ...), its own child executor on the SHARED registry, its opener
        messages and a fresh control plane.  The handle lives in
        ``self.subagents`` for the whole run -- message_subtask resumes
        it from there."""
        self._sub_seq += 1
        key = f"S{self._sub_seq}"
        child = type(self).child(
            self,
            max_rounds=SUB_ROUNDS,
            session_id=f"sub-{id(self):x}-{key}",
        )
        child.question_held = parsed["objective"]
        # the child's sources entries carry this key -- the client's
        # result-strip join resolves (round, call id) PER AGENT
        child.agent_key = key
        handle = SubagentHandle(
            key,
            self._sub_seq,
            parsed,
            subagent_messages(parsed, lang, tz=getattr(self, "tz", None), tool_notes=tool_notes),
            child,
            ChildControl(),
        )
        self.subagents[key] = handle
        return handle

    def _lead_pending_interrupt(self) -> tuple[str, str] | None:
        """The run's stop/preempt as a NON-destructive observation: the
        event pump polls it to propagate into running subagents.  The
        lead's own preempt slot must stay unconsumed (its loop injects
        the steering), hence peek over read."""
        ctl = self.run_control
        if ctl is None:
            return None
        try:
            peek = getattr(ctl, "peek_interrupt", None)
            if peek is not None:
                return peek()
            if ctl.stopped():
                return ("stop", "")
        except Exception:  # pylint: disable=broad-except
            return None
        return None

    def _interleave(
        self,
        queues: "dict[int, queue.Queue[t.Any]]",
        handles: "dict[int, SubagentHandle]",
        deadline: float | None = None,
    ) -> t.Iterator[tuple[str, t.Any]]:
        """One event per active child queue in round-robin (each child's
        own order preserved; cross-child order is stream order), remapped
        into the sub rows.  POLLS the run's stop between drains: a user
        stop/preempt stops every still-running child's control plane --
        the child loops end as interrupted within ~1s (their event-wait
        slice), their partial events still stream, and the digests note
        the early end.  Child surfaces for OTHER surfaces (phase/tasks/
        findings/decisions/settle) are the LEAD's -- dropped.  With a
        ``deadline``, still-open children at the deadline are returned
        (the ``yield from`` value) -- the BACKGROUND promotion's handoff
        set; the caller settles their delegation rows and hands them to
        the late lane."""
        active = {seq: q for seq, q in queues.items()}
        closed: set[int] = set()
        stop_signalled = False
        while len(closed) < len(queues):
            if deadline is not None and time.monotonic() >= deadline:
                open = {seq for seq in queues if seq not in closed}
                if open:
                    return open
            if not stop_signalled and self._lead_pending_interrupt():
                stop_signalled = True
                for handle in handles.values():
                    handle.control.stop()
            progressed = False
            for seq, q in list(active.items()):
                if seq in closed:
                    continue
                try:
                    event = q.get(timeout=0.05)
                except queue.Empty:
                    continue
                progressed = True
                if event is None:
                    closed.add(seq)
                    continue
                gid = handles[seq].gid
                kind = str(event.get("e") or "")
                if kind == "open":
                    # the child's per-round open: remapped into the sub row
                    yield (
                        "open",
                        {
                            "id": gid,
                            "kind": "sub",
                            "round": int(event.get("round") or 1),
                            "agent": handles[seq].key,
                            "title": "",
                        },
                    )
                elif kind in ("think", "say", "calls", "call", "close", "browser"):
                    out = dict(event)
                    if kind in ("calls", "call"):
                        # the child's per-turn entry id survives the remap
                        # as ``turn``: the gid only ROUTES the event into
                        # the sub row (every batch shares it), while
                        # settlements address (turn, in-round position) --
                        # without it a round's settlement would rewrite
                        # the same-position rows of EVERY past round.  The
                        # base keeps turns unique across passes (a
                        # follow-up's loop restarts its entry ids at 1).
                        child_turn = int(out.pop("entry", 0) or out.get("id") or 0)
                        turn = handles[seq].turn_base + max(child_turn, 1)
                        out["turn"] = turn
                        if turn > handles[seq].turn_top:
                            handles[seq].turn_top = turn
                    out["id"] = gid
                    yield (kind, out)
                elif kind == "sources":
                    # [n] numbers are ALREADY parent-consistent (the
                    # shared registry minted them); the PRODUCING TURN
                    # rides as ``turn`` (the executor's _stamp put the
                    # child's entry on the event) -- the client's row
                    # join keys on it, because a resumed child's Searches
                    # round counter outlives the loop's per-pass rounds
                    # and ``round`` alone drifts
                    out = {"items": event.get("items") or []}
                    child_turn = int(event.get("entry") or 0)
                    if child_turn:
                        out["turn"] = handles[seq].turn_base + child_turn
                    yield ("sources", out)
            if not progressed and len(closed) < len(queues):
                time.sleep(0.05)
        for handle in handles.values():
            if handle.control.stopped:
                handle.stopped = True
        return set()

    def _run_subagents(  # pylint: disable=too-many-locals, too-many-branches
        self,
        rnd: int,
        sub_jobs: list[tuple[int, dict[str, str]]],
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        """One delegation batch: every ``delegate_research`` call mints a
        REGISTERED subagent (stable key S1, S2, ... -- the digest's tag
        and the follow-up channel's address) and runs its nested loop on
        its OWN thread (own context window, own small round budget, the
        SHARED source registry so overlapping searches settle as
        duplicates mechanically).  Their wire events interleave into the
        parent stream under the handle's PERMANENT id slot (kind "sub" --
        a follow-up's resume re-opens the SAME row).  After each child
        settles it STAYS in the registry, conversation and all: its
        material joins the parent's world delta-promoted (a follow-up's
        second settlement must not double-fold), and the compressed
        digest becomes that call's tool result."""
        from searx.zjsearch.ai.agent import (
            loop as engine,
        )  # pylint: disable=import-outside-toplevel

        cfg = self.cfg
        child_tools = self._sub_toolset()
        lang = self.lang or "en"
        settled_jobs: list[tuple[int, SubagentHandle]] = []
        threads: list[threading.Thread] = []
        queues: "dict[int, queue.Queue[t.Any]]" = {}
        handles_by_seq: "dict[int, SubagentHandle]" = {}
        wire_by_seq: "dict[int, int]" = {}
        auto_background_ms = subagents_auto_background_ms()
        started_at = time.monotonic()

        for job_idx, (wire_id, parsed) in enumerate(sub_jobs):
            if job_idx >= self.SUB_MAX_PARALLEL:
                # over the batch cap: an honest refusal teaches the model
                # to merge subtasks instead of fanning out unbounded
                feeds[wire_id - 1] = (
                    "error: the delegation batch is full"
                    f" (max {self.SUB_MAX_PARALLEL} subagents per round) --"
                    " merge overlapping subtasks and re-delegate."
                )
                continue
            handle = self._register_subagent(parsed, lang, tool_notes=self._sub_tool_notes)
            handle.busy = True
            settled_jobs.append((wire_id, handle))
            handles_by_seq[handle.seq] = handle
            wire_by_seq[handle.seq] = wire_id
            q: "queue.Queue[t.Any]" = queue.Queue()
            queues[handle.seq] = q
            # this pass's turn stamps start above every earlier pass's
            # (the pump reads turn_base; nothing has consumed the
            # generator yet, so no event can race the assignment)
            handle.turn_base = handle.turn_top
            events = engine.run(
                cfg,
                handle.messages,
                tools=child_tools,
                executor=handle.child.execute,
                max_rounds=SUB_ROUNDS,
                round_progress=self._sub_round_progress(handle.child),
                control=handle.control,
                compact_state=lambda handle=handle: state_block(handle.child, include_tasks=False),
                display=_sub_display_rows,
            )
            threads.append(
                threading.Thread(
                    target=self._drive_sub,
                    args=(handle, events, q),
                    daemon=True,
                    name=f"zjs-sub-{handle.key}",
                )
            )
            threads[-1].start()
            # the call row settles immediately (the delegation was
            # accepted); the SUB ROW opens for the live child timeline.
            # Rows address by ``call`` (the in-round position) -- the
            # loop stamps the entry id (an ``id`` here would HIJACK the
            # entry address and the settlement would never land).
            yield (
                "call",
                {
                    "call": wire_id,
                    "status": "ok",
                    "label": f"{handle.key} · {parsed['title']}",
                    "ms": 0,
                    "feed": parsed["objective"][:800],
                    "raw": parsed["objective"][:50_000],
                },
            )
            yield (
                "open",
                {
                    "id": handle.gid,
                    "kind": "sub",
                    "round": 1,
                    "agent": handle.key,
                    "title": f"{handle.key} · {parsed['title']}",
                    "objective": parsed["objective"][:600],
                },
            )

        deadline = started_at + auto_background_ms / 1000.0 if auto_background_ms else None
        open_seqs = yield from self._interleave(queues, handles_by_seq, deadline=deadline)

        if open_seqs:
            # the BACKGROUND promotion (C2): the batch outlived its
            # foreground deadline -- settle the still-running delegations
            # NOW (the lead's round completes and it keeps researching)
            # and hand them to the run's late lane, which keeps pumping
            # their timelines and delivers the digests as
            # <task_result> messages at upcoming round boundaries
            elapsed_ms = int((time.monotonic() - started_at) * 1000)
            for seq in sorted(open_seqs):
                handle = handles_by_seq[seq]
                wire_id = wire_by_seq[seq]
                background_feed = (
                    f"still running in the background (subagent {handle.key})"
                    " -- its digest arrives as a <task_result> message at an"
                    " upcoming round boundary; keep researching meanwhile."
                )
                feeds[wire_id - 1] = background_feed
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "ok",
                        "ms": elapsed_ms,
                        "label": f"{handle.key} · {handle.parsed['title']}",
                        "feed": background_feed[:800],
                        "raw": background_feed[:50_000],
                    },
                )
            self._spawn_late_lane(
                rnd,
                {seq: queues[seq] for seq in open_seqs},
                {seq: handles_by_seq[seq] for seq in open_seqs},
                child_tools,
            )

        # settle: delta-promote each SETTLED child's material into the
        # parent's world and write the compressed digest as the call's
        # tool result (backgrounded children settle in the lane instead)
        promoted = False
        for wire_id, handle in settled_jobs:
            if handle.seq in open_seqs:
                continue
            digest = self._sub_digest(handle)
            feeds[wire_id - 1] = digest
            self._promote_child(rnd, handle)
            handle.busy = False
            promoted = True
            # the digest is the ROW's receipt too: a second settlement on
            # the same wire id updates the row (the expansion renders it)
            yield (
                "call",
                {
                    "call": wire_id,
                    "status": "ok",
                    "ms": 0,
                    "label": f"{handle.key} · {handle.parsed['title']}",
                    "chars": len(digest),
                    "feed": digest[:800],
                    "raw": digest[:50_000],
                    "result": digest,
                },
            )
        if promoted:
            # the promoted facts/gaps join the ledger: the AUTHORITATIVE
            # snapshot flies so the findings card renders them live (the
            # same event the record_findings tool emits)
            yield (
                "findings",
                {"round": rnd, "items": list(self.facts), "gaps": list(self.gaps)},
            )

    def _spawn_late_lane(
        self,
        rnd: int,
        queues: "dict[int, queue.Queue[t.Any]]",
        handles_by_seq: "dict[int, SubagentHandle]",
        child_tools: list[dict[str, t.Any]],
    ) -> None:
        """The BACKGROUND lane thread: keeps draining the promoted
        children's queues (their timelines stream as late events the loop
        flushes at every round boundary), and at each settlement promotes
        the child, queues its digest as a ``<task_result>`` and chains
        any follow-up messages that were queued while it ran."""
        from searx.zjsearch.ai.agent import (
            loop as engine,
        )  # pylint: disable=import-outside-toplevel

        def lane() -> None:
            for kind, payload in self._interleave(queues, handles_by_seq):
                self.late_events.put({"e": kind, **payload})
            for handle in handles_by_seq.values():
                if handle.control.stopped:
                    handle.stopped = True
                self._settle_background_child(rnd, handle, child_tools, engine)

        thread = threading.Thread(
            target=lane,
            daemon=True,
            name=f"zjs-late-lane-{rnd}-{sorted(handles_by_seq)}",
        )
        self.late_lanes.append(thread)
        thread.start()

    def _settle_background_child(
        self,
        rnd: int,
        handle: SubagentHandle,
        child_tools: list[dict[str, t.Any]],
        engine: t.Any,
    ) -> None:
        """One backgrounded child's settlement: promote + queue the
        digest, then chain the follow-ups that were queued while it ran
        (each a full resume inside the same conversation, still on this
        lane)."""

        def settle_pass() -> None:
            digest = self._sub_digest(handle)
            self._promote_child(rnd, handle)
            handle.busy = False
            with self.pending_lock:
                self.pending_results.append({"handle": handle.key, "digest": digest})

        settle_pass()
        while handle.pending_messages and handle.followups < FOLLOWUP_MAX and not self._lead_pending_interrupt():
            message = handle.pending_messages.pop(0)
            handle.control.reset()
            handle.stopped = False
            handle.busy = True
            handle.followups += 1
            handle.messages.append(
                {
                    "role": "user",
                    "content": spine.block("lead_followup", message),
                }
            )
            q: "queue.Queue[t.Any]" = queue.Queue()
            handle.turn_base = handle.turn_top
            events = engine.run(
                self.cfg,
                handle.messages,
                tools=child_tools,
                executor=handle.child.execute,
                max_rounds=SUB_ROUNDS,
                round_progress=self._sub_round_progress(handle.child),
                control=handle.control,
                compact_state=lambda handle=handle: state_block(handle.child, include_tasks=False),
                display=_sub_display_rows,
            )
            self._drive_sub(handle, events, q)  # synchronous ON the lane
            for kind, payload in self._interleave({handle.seq: q}, {handle.seq: handle}):
                self.late_events.put({"e": kind, **payload})
            settle_pass()

    def _run_followups(  # pylint: disable=too-many-locals, too-many-branches
        self,
        rnd: int,
        followup_jobs: list[tuple[int, dict[str, str]]],
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        """The ``message_subtask`` passes, one at a time (the resumed
        lane is serialized): the registered subagent's OWN conversation
        gains the lead's message and the SAME loop re-runs on it -- the
        sources, ledger and reads it built are all still in its context.
        A fresh digest comes back as the tool result; only the NEW
        material promotes into the parent's world.  Guards teach the
        contract: an unknown id names the live ones, a spent budget
        points at fresh delegation."""
        from searx.zjsearch.ai.agent import (
            loop as engine,
        )  # pylint: disable=import-outside-toplevel

        cfg = self.cfg
        child_tools = self._sub_toolset()
        promoted = False
        for wire_id, parsed in followup_jobs:
            handle = self.subagents.get(parsed["id"])
            feed_text = ""
            if handle is None:
                live = ", ".join(sorted(self.subagents)) or "none"
                feed_text = f"error: no subagent \"{parsed['id']}\" -- live ids: {live}."
            elif not parsed["message"]:
                feed_text = "error: empty message -- say what the subagent should do next."
            elif handle.followups >= FOLLOWUP_MAX:
                feed_text = (
                    f"error: subagent {handle.key} has spent its follow-up budget"
                    f" ({FOLLOWUP_MAX} messages) -- delegate a fresh"
                    " delegate_research if the facet is new."
                )
            elif handle.busy:
                # the child is mid-pass (a backgrounded batch): the
                # message QUEUES and the settling lane chains it
                handle.pending_messages.append(parsed["message"])
                feed_text = (
                    f"queued: subagent {handle.key} is still working -- the"
                    " message executes when its current pass settles."
                )
                feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "ok",
                        "ms": 0,
                        "label": f"{handle.key} · follow-up (queued)",
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                    },
                )
                continue
            elif self._lead_pending_interrupt():
                feed_text = "error: the run is stopping -- the follow-up was not delivered."
            if feed_text:
                feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "error",
                        "label": f"{parsed['id']} · follow-up",
                        "ms": 0,
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                    },
                )
                continue
            # resume: a previous stop does not bind a new follow-up (the
            # lead re-engaged the subagent ON PURPOSE), the message joins
            # the SAME conversation, and the loop re-runs it
            handle.control.reset()
            handle.stopped = False
            handle.busy = True
            handle.followups += 1
            handle.messages.append(
                {
                    "role": "user",
                    "content": spine.block("lead_followup", parsed["message"]),
                }
            )
            q: "queue.Queue[t.Any]" = queue.Queue()
            handle.turn_base = handle.turn_top
            events = engine.run(
                cfg,
                handle.messages,
                tools=child_tools,
                executor=handle.child.execute,
                max_rounds=SUB_ROUNDS,
                round_progress=self._sub_round_progress(handle.child),
                control=handle.control,
                compact_state=lambda handle=handle: state_block(handle.child, include_tasks=False),
                display=_sub_display_rows,
            )
            resume_thread = threading.Thread(
                target=self._drive_sub,
                args=(handle, events, q),
                daemon=True,
                name=f"zjs-sub-{handle.key}-f{handle.followups}",
            )
            resume_thread.start()
            # the row settles immediately (the follow-up was accepted);
            # the child's own open event re-activates its sub row
            yield (
                "call",
                {
                    "call": wire_id,
                    "status": "ok",
                    "label": f"{handle.key} · follow-up",
                    "ms": 0,
                    "feed": parsed["message"][:800],
                    "raw": parsed["message"][:50_000],
                },
            )
            yield from self._interleave({handle.seq: q}, {handle.seq: handle})
            handle.busy = False
            digest = self._sub_digest(handle)
            feeds[wire_id - 1] = digest
            self._promote_child(rnd, handle)
            promoted = True
            yield (
                "call",
                {
                    "call": wire_id,
                    "status": "ok",
                    "ms": 0,
                    "label": f"{handle.key} · follow-up",
                    "chars": len(digest),
                    "feed": digest[:800],
                    "raw": digest[:50_000],
                    "result": digest,
                },
            )
        if promoted:
            yield (
                "findings",
                {"round": rnd, "items": list(self.facts), "gaps": list(self.gaps)},
            )

    def _drive_sub(self, handle: SubagentHandle, events: t.Any, q: "queue.Queue[t.Any]") -> None:
        """One subagent lane's pump thread (delegation batch AND follow-up
        resumes alike): the events into the queue, then the close
        sentinel; the child's browser session dies with its loop (a
        follow-up re-opens the SAME keyed session lazily -- the
        persistent context keeps the cookie store)."""
        try:
            for event in events:
                q.put(event)
        finally:
            if handle.child.browser_session_id != "lead":
                try:
                    browser_session.close(handle.child.browser_session_id)
                except Exception:  # pylint: disable=broad-except
                    pass
            q.put(None)

    def _sub_round_progress(self, child: t.Any) -> t.Callable[[int], tuple[str, str] | None]:
        """The subagent's stall detector closure, bound to the CHILD's
        state (its own counters; two unproductive rounds end it -- the
        budget is the delegation's spend cap)."""
        return round_progress(child, SUB_STALL_ROUNDS, 0)

    def _promote_child(self, rnd: int, handle: SubagentHandle) -> None:
        """A settled subagent's material joins the parent's world -- as a
        DELTA against the handle's marks, because a resumed subagent
        settles repeatedly (a wholesale re-fold would duplicate feed
        blocks, judgments and spend).  The facts/gaps re-apply wholesale:
        the ledger dedupes (near-duplicate merge, gap keys).  The
        sources themselves were already minted into the SHARED registry
        as the child searched."""
        child = handle.child
        ops: dict[str, t.Any] = {"facts": [], "open_gaps": []}
        for fact in child.facts:
            if fact.get("status") == "active":
                ops["facts"].append(
                    {
                        "text": fact.get("text"),
                        "refs": fact.get("refs") or [],
                        "tags": fact.get("tags") or [],
                    }
                )
        for gap in child.gaps:
            if gap.get("status") == "open":
                ops["open_gaps"].append({"q": gap.get("q"), "why": gap.get("why")})
        if ops["facts"] or ops["open_gaps"]:
            self.apply_learnings(ops, rnd)
        new_feed = child.feed[handle.feed_mark :]
        if new_feed:
            block = f"[Subtask material · {handle.key}]\n" + "\n".join(str(line) for line in new_feed)
            self.feed.append(block[:6000])
            self.feed_chars += min(len(block), 6000)
        handle.feed_mark = len(child.feed)
        self.entries.update(child.entries)
        self.head_sources.update(child.head_sources)
        self.corpus.absorb_new(child.corpus, handle.corpus_seen)
        for judgment in child.judgments[handle.judgment_mark :]:
            self.judgments.append(
                {
                    **judgment,
                    "purpose": f"sub:{judgment.get('purpose') or ''}".rstrip(":"),
                }
            )
        handle.judgment_mark = len(child.judgments)
        self.account.merge_delta(child.account, handle.spend_snap)

    def _sub_digest(self, handle: SubagentHandle) -> str:
        """The compressed report-back: established facts (each [n]-cited),
        the open gaps, the source line count -- the lead aggregates many
        digests, so this stays under ~2k characters.  The ``[Subtask Sn]``
        tag is the subagent's stable id: message_subtask addresses it."""
        child = handle.child
        lines: list[str] = [f"[Subtask {handle.key}] {handle.parsed['title']}"]
        if handle.stopped:
            lines.append("(terminated early -- only the material confirmed before the stop follows)")
        if child is None:
            lines.append("the subagent did not report")
            return "\n".join(lines)[:2000]
        active = [fact for fact in child.facts if fact.get("status") == "active"]
        if active:
            lines.append("Confirmed:")
            for fact in active[:8]:
                refs = ",".join(str(n) for n in (fact.get("refs") or [])[:4])
                mark = f" [{refs}]" if refs else ""
                lines.append(f"- {str(fact.get('text') or '')[:200]}{mark}")
        if child.gaps:
            open_gaps = [gap for gap in child.gaps if gap.get("status") != "closed"][:4]
            if open_gaps:
                lines.append("Open:")
                for gap in open_gaps:
                    lines.append(f"- {str(gap.get('q') or gap.get('text') or '')[:160]}")
        lines.append(f"Sources registered: {len(child.entries)}")
        return "\n".join(lines)[:2000]
