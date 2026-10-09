# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The wire protocol v2: timeline operations as NDJSON, one CLOSED event
set.  The loop mutates the run's timeline; every mutation is one event
here -- the client is a dumb renderer with zero reconstruction heuristics.

Events (``e`` is the closed discriminator; anything else is a protocol
bug and :py:func:`encode` refuses it):

======================  ===================================================
``open``                a timeline entry starts: ``{id, kind: research|
                        write, round}`` -- think/narration deltas hang off
                        the id; a research entry's calls hang off it too.
``think``               reasoning delta for entry ``id`` (timeline
                        material, never the answer).
``say``                 narration delta for entry ``id`` (a research
                        turn's own prose -- the intent line).
``calls``               entry ``id``'s tool calls (all pending):
                        ``items`` are the display rows.
``call``                ONE call settled: ``{id, call, status, ...}``
                        (n/ms/chars/text/result/preview per tool kind).
                        ``web_browser`` rows add ``page`` {url,title},
                        ``snapshot`` (the fresh outline) and ``img``
                        (the volatile frame jpeg -- the client strips
                        it before persisting, the reading pane of the
                        ``read`` action is ``text``/``chars`` as
                        usual).
``close``               entry ``id`` is final.
``phase``               the run's macro stage: ``{name: plan|
                        research|write}`` -- the timeline's one
                        coarse spine (Qwen Deep Research's phase
                        design); micro-activity stays with the entries.
``decisions``           the run's DECISION RESULTS (framework gates +
                        model-initiated judge), one batch per
                        round: ``{round, items: [{purpose, question,
                        target, answer, ms}]}`` -- the sources rail's
                        决策结果 card; ``answer`` is the RAW model
                        answer (verdicts + probabilities) for
                        click-through.
``tasks``               the task card's AUTHORITATIVE snapshot.
``learnings``           the findings ledger's AUTHORITATIVE snapshot
                        (``items``: the facts so far) -- what the
                        researcher recorded as established.
``sources``             the global [n] registry's new/updated entries.
``answer``              the writer's answer delta (its OWN buffer --
                        narration never mixes in).
``ask``                 the clarify gate / mid-research ask_user:
                        ``{intro, questions}`` -- the run settles
                        ``awaiting``.
``steer``               a USER STEERING of the live run: ``{text,
                        delivery: guide|preempt, status:
                        drained|discarded}`` -- emitted when the message
                        actually reaches the lead (drained: injected at
                        the round boundary or via preempt) or visibly
                        dies (discarded: the write phase had already
                        opened).  The pending state lives client-side.
``gallery``             a validated inline image group
                        ``{items: [{u, n}]}``.
``browser``             the interactive browser session's MIRROR frame:
                        ``{url, title, img, w, h, wait_left?}`` -- live
                        while a ``web_browser`` call is pending (the
                        frames double as the stream's heartbeats); the
                        client renders them in the rail's browser card
                        and strips ``img`` before persisting.
``related``             follow-up question suggestions.
``memory``              a durable fact the model saved about the user.
``ctx``                 STORAGE-ONLY resume checkpoint: ``{round,
                        messages}`` -- the researcher's EXACT message
                        list at the round boundary, replayed verbatim
                        when a dead process's run is continued (the
                        server is stateless; the conversation lives in
                        the browser's store).  The client persists it
                        out-of-log (one upserted row, never appended to
                        the evt log) and never renders it.
``settle``              the terminal state: ``{status: done|awaiting|
                        error, finish, usage, model, halt}``.  After it,
                        only ``related`` / ``memory`` may follow (the
                        follow-up box must not wait for the related
                        fallback completion).
======================  ===================================================
"""

import json
import typing as t

EVENTS: frozenset[str] = frozenset(
    {
        "open",
        "phase",
        "think",
        "say",
        "calls",
        "call",
        "close",
        "tasks",
        "learnings",
        "sources",
        "decisions",
        "answer",
        "ask",
        "steer",
        "gallery",
        "outline",
        "artifact",
        "section",
        "browser",
        "related",
        "title",
        "memory",
        "ctx",
        "tags",
        "usage",
        "settle",
    }
)

LATE_EVENTS: frozenset[str] = frozenset({"related", "title", "memory", "tags", "usage"})
"""The only events allowed AFTER ``settle`` (the post-settle related
fallback completion and the memory/tag extraction trail behind by
design -- the follow-up box unlocks on settle, not on them)."""


def encode(event: dict[str, t.Any]) -> str:
    """One wire line: JSON + newline, with the closed-set check (a misspelled
    event is a programming error, not a silent client no-op)."""
    kind = event.get("e")
    if kind not in EVENTS:
        raise ValueError(f"unknown wire event: {kind!r}")
    return json.dumps(event, ensure_ascii=False) + "\n"


def settle(
    status: str,
    finish: str | None = None,
    usage: dict[str, t.Any] | None = None,
    model: str | None = None,
    halt: str | None = None,
) -> dict[str, t.Any]:
    """The terminal event's payload (the loop emits exactly one)."""
    return {"e": "settle", "status": status, "finish": finish, "usage": usage, "model": model, "halt": halt}
