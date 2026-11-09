# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The run host: the live-run registry that decouples a research run's
life from its client connection.

Today a run dies with its HTTP response -- the client's generator close
cancels the LLM pump mid-turn and everything after is lost, which is
why "recovery" could only ever mean starting a new run.  The host
inverts the ownership: the run executes on a DRIVER THREAD (the route
spawns it), every wire event is published into a per-run buffer under a
monotonic ``seq``, and HTTP responses degrade into SUBSCRIBERS --
backlog replay + a live queue.  A disconnect is a DETACH: the driver
keeps going, and the run can be reattached with
``after_seq=N`` (the same run, the same [n] registry -- not a restart).

Detach policy (2026-10-14): EVERY research run LINGERS -- a run with
zero subscribers is never auto-wrapped; a closed tab means "collect
later", and the run researches until the ledger closes (the stall and
runaway guards still bound it) or the user's explicit stop/wrap-up lands.
Only a ``linger=False`` caller (none today) gets the old grace-window
auto-wrap back.  A terminal handle is retained for a short TTL so a
late attacher can still fetch the true ending; then the sweep drops it
(the durable copy is the run journal -- the knowledge base stays the
client-side persistent store).

The ``ControlBox`` is the run's inbound control plane: the stop flag,
the steer lane (FIFO, one drain per round boundary) and the preempt
slot (an immediate mid-turn interrupt carrying its own steering text).
The loop observes the box through narrow callables -- boundary directive
polling, a mid-turn interrupt check (the event wait is sliced so an
interrupt is seen within ~1s without weakening the idle-timeout
contract) and the guide lane's drain.  Pure stdlib threading: no flask,
no event loop -- unit tests run it bare.
"""

import json
import logging
import queue
import secrets
import threading
import time
import typing as t
from collections import deque

from searx.zjsearch.ai.agent import wire

logger = logging.getLogger(__name__)

GRACE_DEFAULT = 90.0
"""Retired with the auto-wrap: every research run registers ``linger``,
so the grace never fires (the knob remains for a non-linger caller)."""

TERMINAL_TTL = 3600.0
"""How long a finished handle stays fetchable for a late attach (the
resume upgrade: the true ending instead of a findings-handoff
restart)."""

POLL_SLICE = 1.0
"""The subscription wait slice: subscriber cancellation and the driver
finished-flag are observed within about a second."""


def _replay_line(event: dict[str, t.Any], line: str) -> str:
    """The buffer's copy of one wire line: a ``browser`` mirror event
    loses its volatile ``img`` bytes (the record stays -- url, title,
    action -- only the JPEG does not ride a replay)."""
    if event.get("e") != "browser" or "img" not in event:
        return line
    try:
        payload = json.loads(line)
    except ValueError:
        return line
    payload.pop("img", None)
    return json.dumps(payload, ensure_ascii=False) + "\n"


MAX_PENDING_STEERS = 3
"""The steer lane's queue cap: a chatty user cannot pile unbounded
instructions onto one boundary; an overflow answers the CONTROL
endpoint 422 and the client's chip never pends."""


class ControlBox:
    """The run's inbound controls: the stop flag, the steer lane (FIFO,
    ONE drain per round boundary) and the preempt slot (an immediate
    mid-turn interrupt carrying its own steering text)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop = False
        self._preempt: str | None = None
        self._steers: "deque[tuple[str, dict | None]]" = deque()
        self._pending_template: dict | None = None
        self._pending_shape: str | None = None

    def stop(self) -> None:
        with self._lock:
            self._stop = True

    def stopped(self) -> bool:
        with self._lock:
            return self._stop

    def steer(self, text: str, preempt: bool = False, meta: dict | None = None) -> bool:
        """Queue one steering message; ``False`` when the guide lane's
        queue is full (the endpoint answers 422).  ``meta`` rides the
        drained steer EVENT as top-level fields -- the structured lane the
        control endpoints use to say WHY they steered (the direct-answer
        pick's ``{"shape": "direct"}`` is what lets the client fold the
        run's output-shape state back, replay-stable)."""
        with self._lock:
            if preempt:
                self._preempt = text
                return True
            if len(self._steers) >= MAX_PENDING_STEERS:
                return False
            self._steers.append((text, meta))
            return True

    def interrupt(self) -> tuple[str, str] | None:
        """The mid-turn observation, in priority order: ``("stop", "")``,
        ``("preempt", text)`` or ``None``.  The preempt slot is CONSUMED
        here (a one-shot interrupt)."""
        with self._lock:
            if self._stop:
                return ("stop", "")
            if self._preempt is not None:
                text = self._preempt
                self._preempt = None
                return ("preempt", text)
        return None

    def peek_interrupt(self) -> tuple[str, str] | None:
        """The NON-destructive observation (same priority order): the
        subagent pump polls this to propagate a stop/preempt into the
        running children WITHOUT consuming the lead's own preempt slot --
        the lead's loop must still see it and inject the steering."""
        with self._lock:
            if self._stop:
                return ("stop", "")
            if self._preempt is not None:
                return ("preempt", self._preempt)
        return None

    def poll_steer(self) -> tuple[str, dict | None]:
        """The boundary's ONE guide-lane drain (FIFO): the text plus the
        endpoint's meta (``None`` on a plain user steer)."""
        with self._lock:
            if self._steers:
                return self._steers.popleft()
        return ("", None)

    def drain_steers(self) -> list[tuple[str, dict | None]]:
        """Everything the guide lane never delivered (the write phase
        closed the lane -- the leftovers surface as visible discards)."""
        with self._lock:
            out = list(self._steers)
            self._steers.clear()
            return out

    def set_template(self, template: dict) -> None:
        """The rail's output-structure control: one PENDING template for
        the write boundary -- the synthesizer re-mints the outline from it
        before the first section streams.  The latest write wins (a second
        set before the boundary simply replaces it)."""
        with self._lock:
            self._pending_template = template

    def take_template(self) -> dict | None:
        """The synthesizer's boundary consume (one shot)."""
        with self._lock:
            template = self._pending_template
            self._pending_template = None
            return template

    def clear_template(self) -> None:
        """The rail's cancel: a previously-picked template is withdrawn
        (the write boundary consumes nothing -- the free outline stands)."""
        with self._lock:
            self._pending_template = None

    def set_shape(self, shape: str) -> bool:
        """The rail's output-structure shape flip (report|deck|direct): one
        PENDING output shape for the write boundary -- the synthesizer
        rebinds its slide/report dialect before the first section streams,
        and the "direct" sentinel (the reader's back-to-the-plain-answer
        pick) outranks the model's minted flip there.  Returns whether the
        pending value CHANGED (the control endpoint steers the researcher
        only on a real flip -- flip-flops must not burn guide queue
        slots)."""
        with self._lock:
            changed = self._pending_shape != shape
            self._pending_shape = shape
            return changed

    def peek_shape(self) -> str | None:
        """The NON-destructive observation of the pending shape -- the
        research lane's set_deliverable dispatcher consults it so a
        route-skeleton run already taken back to the direct answer stops
        answering "the structure does not change" (and stops letting a
        dialect flip overwrite the reader's pending direct)."""
        with self._lock:
            return self._pending_shape

    def take_shape(self) -> str | None:
        """The synthesizer's boundary consume (one shot)."""
        with self._lock:
            shape = self._pending_shape
            self._pending_shape = None
            return shape


class Subscription:  # pylint: disable=too-few-public-methods
    """One subscriber's live attachment: the backlog at subscribe time
    plus the queue the driver fans out to."""

    def __init__(self, backlog: list[str], live: "queue.Queue[str]") -> None:
        self.backlog = backlog
        self.live = live


class RunHandle:
    """One hosted run: the seq-stamped line buffer, the subscriber set,
    the control box and the detach accounting.  One lock guards the lot
    -- every critical section is O(subscribers)."""

    def __init__(self, key: str, grace_seconds: float = GRACE_DEFAULT, linger: bool = True) -> None:
        self.key = key
        self.control = ControlBox()
        self.grace_seconds = grace_seconds
        # THE RUN-TO-COMPLETION DEFAULT: a linger run ignores the detach
        # grace entirely -- a closed tab does not wrap it, it researches
        # until the ledger closes (or the stall/runaway guards end it).
        # Only the explicit directives (stop / wrap) end it early; the
        # settle still lands in the journal for the late collector.
        self.linger = linger
        # the durable shadow (optional): called with ``(seq, line)`` for
        # every published event AFTER the lock -- the replay line (the
        # browser mirror's img bytes already stripped), so a journal is a
        # byte-verbatim attach backlog.  Wired by the search route.
        self.journal: t.Callable[[int, str], None] | None = None
        # the structured steer's state-side reaction (optional): called
        # with the steer's meta dict when a meta-carrying steer DRAINS at
        # the round boundary -- the direct-answer pick's withdrawal clears
        # the route skeleton for the remaining rounds.  Wired by the
        # search route; fail-open (directives() guards it).
        self.on_steer: t.Callable[[dict], None] | None = None
        # the report synthesizer's SECTION REWRITE lane (synth.py registers
        # the entry when the write phase opens): ``callable(section_id)``
        # re-streams one settled section against the run's own write
        # materials, serving ``POST /zjsearch/ask/run/section`` for the
        # handle's terminal TTL.  ``None`` = not a synthesizer run (or the
        # write phase never opened).  The lock serializes rewrites -- the
        # written/status maps they mutate are single-writer state.
        self.section_rewrite: t.Callable[[str], t.Iterator[dict[str, t.Any]]] | None = None
        self.rewrite_lock = threading.Lock()
        self._lock = threading.Lock()
        self._lines: list[str] = []
        self._subs: dict[int, "queue.Queue[str]"] = {}
        self._sub_seq = 0
        self._seq = 0
        self._settled = False
        self._settled_at = 0.0
        self._finished = False
        self._detached_at: float | None = None
        self._wrap = False

    @property
    def settled(self) -> bool:
        with self._lock:
            return self._settled

    @property
    def finished(self) -> bool:
        with self._lock:
            return self._finished

    def publish(self, event: dict[str, t.Any]) -> str:
        """Seq-stamp one wire event, encode it once and fan it out.  The
        buffer keeps EVERY line (settle and the late tail alike) -- a
        late attach replays the true ending, not just the head.  The
        browser mirror's ``img`` frames are LIVE-ONLY: live subscribers
        get the volatile JPEG, the buffer keeps the slimmed line (a
        ``wait_user`` window emits a frame every ~2s for minutes -- a
        reattach replaying hundreds of base64 payloads was pure waste,
        and the client's evt-log persistence drops the bytes for the
        same reason).  The wired journal receives the slimmed line
        outside the lock -- a durable shadow of the attach backlog."""
        seq: int
        replay: str
        with self._lock:
            self._seq += 1
            seq = self._seq
            line = wire.encode({**event, "seq": self._seq})
            replay = _replay_line(event, line)
            self._lines.append(replay)
            if event.get("e") == "settle":
                self._settled = True
                self._settled_at = time.monotonic()
            for sub in self._subs.values():
                sub.put(line)
        if self.journal is not None:
            try:
                self.journal(seq, replay)
            except Exception:  # pylint: disable=broad-except
                logger.warning("zjsearch run host: journal append failed for run %s", self.key[:8], exc_info=True)
                self.journal = None
        return line

    def subscribe(self, after_seq: int = 0) -> Subscription:
        """Attach: backlog after ``after_seq`` plus a live queue, under
        one lock (no line is missed or duplicated between snapshot and
        fan-out).  A fresh subscriber clears the detach clock."""
        with self._lock:
            self._sub_seq += 1
            sub = Subscription(list(self._lines[after_seq:]), queue.Queue())
            self._subs[self._sub_seq] = sub.live
            self._detached_at = None
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        with self._lock:
            for name, registered in list(self._subs.items()):
                if registered is sub.live:
                    del self._subs[name]
            if not self._subs and not self._settled and self._detached_at is None:
                self._detached_at = time.monotonic()

    def pull(self, sub: Subscription, timeout: float = POLL_SLICE) -> list[str]:
        """Blocking drain of one subscriber's queue (up to the timeout --
        returns whatever arrived)."""
        try:
            line = sub.live.get(timeout=timeout)
        except queue.Empty:
            return []
        lines = [line]
        while True:
            try:
                lines.append(sub.live.get_nowait())
            except queue.Empty:
                return lines

    def stream(self, after_seq: int = 0, idle_cap: float = 300.0) -> t.Iterator[str]:
        """The subscription as a response iterator: backlog, then live
        lines, until the driver finishes (the late tail AFTER the settle
        flows through too).  The idle cap only fires on a driver that
        died without its guaranteed finish -- defensive, not policy."""
        sub = self.subscribe(after_seq)
        idle = 0.0
        try:
            yield from sub.backlog
            while True:
                lines = self.pull(sub, POLL_SLICE)
                if lines:
                    idle = 0.0
                    yield from lines
                    continue
                if self.finished:
                    return
                idle += POLL_SLICE
                if idle >= idle_cap:
                    logger.warning("zjsearch run host: subscription idle cap on run %s", self.key[:8])
                    return
        finally:
            self.unsubscribe(sub)

    def finish(self) -> None:
        """The driver's terminal flag: every event (settle + late tail)
        is published; subscribers may drain and exit."""
        with self._lock:
            self._finished = True

    def directives(self) -> list[dict[str, t.Any]]:
        """The loop's round-boundary control poll: an explicit user stop
        wins over wrap/grace, and the boundary's ONE steer drain rides
        along (both are terminal/steering for the research phase -- the
        stop skips the writer, the wrap walks into it).  A meta-carrying
        steer first notifies ``on_steer`` (the run's state-side reaction
        to its OWN structured controls -- the direct-answer pick's
        withdrawal clears the route skeleton while the research is still
        running; fail-open: a broken hook never blocks the drain)."""
        out: list[dict[str, t.Any]] = []
        if self.control.stopped():
            return [{"action": "stop"}]
        if self._wrap or self.grace_expired():
            out.append({"action": "wrap"})
        steer = self.control.poll_steer()
        if steer[0]:
            if steer[1] and self.on_steer is not None:
                try:
                    self.on_steer(steer[1])
                except Exception as exc:  # pylint: disable=broad-except
                    logger.warning("zjsearch run host: on_steer hook failed: %r", exc)
            out.append({"action": "steer", "text": steer[0], **(steer[1] or {})})
        return out

    def wrap(self) -> None:
        """The user's wrap-up: the run finishes its round, then
        walks into the writer with the material gathered -- the same
        graceful exit the detach grace takes."""
        with self._lock:
            self._wrap = True

    def interrupt(self) -> tuple[str, str] | None:
        """The loop's mid-turn observation (see :py:meth:`ControlBox.interrupt`)."""
        return self.control.interrupt()

    def drain_steers(self) -> list[tuple[str, dict | None]]:
        """The guide lane's undelivered leftovers (visible discards)."""
        return self.control.drain_steers()

    def grace_expired(self) -> bool:
        with self._lock:
            if self.linger:
                # the background-completion contract: a closed tab never
                # wraps this run -- it researches to the ledger's closure
                return False
            return (
                not self._settled
                and not self._finished
                and self._detached_at is not None
                and (time.monotonic() - self._detached_at) >= self.grace_seconds
            )

    def touch(self) -> bool:
        """The keepalive heartbeat (the backgrounded tab's proof of life):
        answers whether the run is still live (``False`` ends the
        client's beating).  Under the linger default the detach clock it
        restarts is dormant -- the run's life no longer depends on
        anyone watching; the beats double as the client watchdog's
        fresh-connection verdicts."""
        with self._lock:
            if self._settled or self._finished:
                return False
            self._detached_at = time.monotonic()
            return True

    def terminal_expired(self, now: float) -> bool:
        with self._lock:
            return self._finished and self._settled and now - self._settled_at >= TERMINAL_TTL


_HOSTS: dict[str, RunHandle] = {}
_HOSTS_LOCK = threading.Lock()


def register(grace_seconds: float = GRACE_DEFAULT, linger: bool = True) -> RunHandle:
    """Mint a run key and admit the handle (the sweep piggybacks here --
    registration is the one moment every run passes through)."""
    sweep()
    handle = RunHandle(secrets.token_urlsafe(16), grace_seconds, linger=linger)
    with _HOSTS_LOCK:
        _HOSTS[handle.key] = handle
    return handle


def get(key: str) -> RunHandle | None:
    with _HOSTS_LOCK:
        return _HOSTS.get(key)


def sweep() -> None:
    """Drop finished handles past the terminal TTL (a late attach after
    that falls back to the knowledge base's replay -- the storage
    question it always was)."""
    now = time.monotonic()
    with _HOSTS_LOCK:
        for key in [key for key, handle in _HOSTS.items() if handle.terminal_expired(now)]:
            del _HOSTS[key]
