# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The NDJSON stream wrapper the AI endpoints share: PRIME before
streaming (a run that dies before its first content event answers the
plain-text 502, never a 200 with an empty body), then buffer + iterate.

The base class is the overview contract (one write turn, no late work);
the search route subclasses the mechanics with its own settle-merge and
post-settle late events.  ``UpstreamDead`` is the one shared failure
type -- the routes map it to :py:func:`api.http.upstream_error_response`."""

import typing as t

from searx.zjsearch.ai.agent import wire


class UpstreamDead(Exception):
    """The run settled as an error before any content event: the route
    maps this to the plain-text 502."""


class PrimedStream:  # pylint: disable=too-few-public-methods
    """The timeline ops as NDJSON lines, primed before streaming so a
    dead upstream answers 502."""

    def __init__(self, events: t.Iterator[dict[str, t.Any]]) -> None:
        self.events = events
        self.buffer: list[str] = []
        self.rest: t.Iterator[str] | None = None
        self.dead_reason: str | None = None

    def prime(self) -> None:
        for event in self.events:
            kind = event.get("e")
            if kind == "settle":
                if str(event.get("status") or "") == "error":
                    self.dead_reason = str(event.get("halt") or "upstream returned an empty stream")
                    raise UpstreamDead(self.dead_reason)
                self.buffer.append(wire.encode(event))
                self.rest = iter(())
                return
            self.buffer.append(wire.encode(event))
            if kind in ("open", "think", "answer"):
                self.rest = self._rest()
                return

    def _rest(self) -> t.Iterator[str]:
        for event in self.events:
            yield wire.encode(event)

    def __iter__(self) -> t.Iterator[str]:
        if self.rest is None:
            self.prime()
        yield from self.buffer
        if self.rest is not None:
            yield from self.rest
