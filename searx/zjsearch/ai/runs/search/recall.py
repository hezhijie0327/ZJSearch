# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The live-recall slot registry: the server-side half of the ``recall``
wire event.  The model's ``past_research`` call parks here while the
CLIENT answers from its browser-local knowledge base -- the store never
ships wholesale, the model's own query goes to the data.

Flow: the handler opens a slot, yields the ``recall`` wire event (the
client sees ``{id, q}``, runs its hybrid recall against PGlite) and
blocks on :py:func:`wait` -- the client's answer lands through
``POST /zjsearch/ask/run/recall`` (:py:func:`answer` fills the slot and
sets its event).  FAIL-OPEN on purpose: a timeout (the tab navigated
away, the store never booted) returns ``None`` and the tool feeds its
no-matches line -- the run continues on live search alone, exactly like
an empty index answers today.

The registry is process-global because the answering request carries no
run binding: the slot id (a random token minted per call, consumed on
the first answer or the timeout) IS the capability -- the HMAC token
gate on the route authenticates the client, the id authenticates the
pending call."""

import secrets
import threading

WAIT_S = 6.0
"""The park ceiling: covers a cold store boot (wasm compile + election +
DDL, budgeted client-side at 5s) plus the round trips, and stays far
under every watchdog (the client stream's 170s ceiling, the loop's
135s/125s quiet bounds)."""

_SLOTS: dict[str, "_Slot"] = {}


class _Slot:
    """One pending ``past_research`` call's answer box."""

    def __init__(self) -> None:
        self.event = threading.Event()
        self.entries: list[dict[str, str]] | None = None


def open() -> str:
    """Mint one slot; the id rides the wire event and the client's answer."""
    rid = secrets.token_urlsafe(12)
    _SLOTS[rid] = _Slot()
    return rid


def answer(rid: str, entries: list[dict[str, str]]) -> bool:
    """Fill a slot (the recall route).  ``False`` = unknown/expired id."""
    slot = _SLOTS.get(rid)
    if slot is None:
        return False
    slot.entries = entries
    slot.event.set()
    return True


def wait(rid: str) -> list[dict[str, str]] | None:
    """Block until the client answers or the ceiling passes; the slot is
    consumed either way (a late answer finds nothing -- a no-op)."""
    slot = _SLOTS.get(rid)
    if slot is None:
        return None
    try:
        if slot.event.wait(WAIT_S):
            return slot.entries
        return None
    finally:
        _SLOTS.pop(rid, None)
