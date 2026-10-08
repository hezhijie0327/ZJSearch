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

Detach policy: a run with zero subscribers for longer than the grace
window is wrapped gracefully at its next round boundary (halt note to
the writer, real settle) -- every run ends with a REAL terminal state,
which is what retires the old 2h stale-run sweep for this class.  A
terminal handle is retained for a short TTL so a late attacher can
still fetch the true ending; then the sweep drops it (transient by
design -- the knowledge base stays the only persistent store).

The ``ControlBox`` is the run's inbound control plane: R1 carries the
stop flag only (the wire's stop button is an explicit instruction, not
a broken connection); steering/preempt/wrap directives land here in v2.1
R2.  The loop observes the box through two narrow callables -- boundary
directive polling and a mid-turn stop check (the event wait is sliced
so a stop is seen within ~1s without weakening the idle-timeout
contract).  Pure stdlib threading: no flask, no event loop -- unit
tests run it bare.
"""

import logging
import queue
import secrets
import threading
import time
import typing as t

from searx.zjsearch.ai.agent import wire

logger = logging.getLogger(__name__)

GRACE_DEFAULT = 90.0
"""Seconds a run may sit with zero subscribers before its next round
boundary wraps it up gracefully."""

TERMINAL_TTL = 3600.0
"""How long a finished handle stays fetchable for a late attach (the
断点继续 upgrade: the true ending instead of a findings-handoff
restart)."""

POLL_SLICE = 1.0
"""The subscription wait slice: subscriber cancellation and the driver
finished-flag are observed within about a second."""


class ControlBox:
    """The run's inbound controls.  R1: the stop flag only."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop = False

    def stop(self) -> None:
        with self._lock:
            self._stop = True

    def stopped(self) -> bool:
        with self._lock:
            return self._stop


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

    def __init__(self, key: str, grace_seconds: float = GRACE_DEFAULT) -> None:
        self.key = key
        self.control = ControlBox()
        self.grace_seconds = grace_seconds
        self._lock = threading.Lock()
        self._lines: list[str] = []
        self._subs: dict[int, "queue.Queue[str]"] = {}
        self._sub_seq = 0
        self._seq = 0
        self._settled = False
        self._settled_at = 0.0
        self._finished = False
        self._detached_at: float | None = None

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
        late attach replays the true ending, not just the head."""
        with self._lock:
            self._seq += 1
            line = wire.encode({**event, "seq": self._seq})
            self._lines.append(line)
            if event.get("e") == "settle":
                self._settled = True
                self._settled_at = time.monotonic()
            for sub in self._subs.values():
                sub.put(line)
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
        wins over the detach grace (both are terminal for the research
        phase -- the stop skips the writer, the wrap walks into it)."""
        if self.control.stopped():
            return [{"action": "stop"}]
        if self.grace_expired():
            return [{"action": "wrap"}]
        return []

    def grace_expired(self) -> bool:
        with self._lock:
            return (
                not self._settled
                and not self._finished
                and self._detached_at is not None
                and (time.monotonic() - self._detached_at) >= self.grace_seconds
            )

    def terminal_expired(self, now: float) -> bool:
        with self._lock:
            return self._finished and self._settled and now - self._settled_at >= TERMINAL_TTL


_HOSTS: dict[str, RunHandle] = {}
_HOSTS_LOCK = threading.Lock()


def register(grace_seconds: float = GRACE_DEFAULT) -> RunHandle:
    """Mint a run key and admit the handle (the sweep piggybacks here --
    registration is the one moment every run passes through)."""
    sweep()
    handle = RunHandle(secrets.token_urlsafe(16), grace_seconds)
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
