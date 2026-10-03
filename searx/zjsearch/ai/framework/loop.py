# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The agent loop: one run's phase machine over any :class:`infra.sdk.Sdk`
transport.

Phases: RESEARCH (tool turns; the model decides how many calls one turn
carries, the executor runs them in parallel) -- with the ``ask_user``
escape hatch as a first-class turn outcome -- then WRITE (a fresh
completion writes the reader-facing answer from the gathered material;
Vane's researcher/writer split: the researcher's prose is structurally
unable to leak into the answer).  Zero-tool callers (AI Overview) get a
single WRITE phase whose stream IS the answer.

The loop YIELDS WIRE EVENTS (see :mod:`framework.wire` -- the closed
timeline-op set).  Every delta carries its entry id and channel
(``think`` / ``say`` / ``answer``): the client appends, it never
reconstructs.  Exactly one ``settle`` event terminates the run; only
``related`` / ``memory`` may follow it.

Preserved semantics (ported from the former agent loop): the channel
doctrine (reasoning relayed for the timeline is NEVER the answer -- a
turn that answered in its reasoning channel only fails the run loudly),
transport health timeouts (connect+first-token and per-event idle -- NOT
research limits, the user's stop button is the control), the
stall-detector termination (``round_progress`` returns the halt message;
``max_rounds`` is only a safety ceiling), the writer's empty-stream
single retry (a reasoning-only writer is NOT retried -- the identical
request would repeat the misroute), and the mid-research transport-blip
recovery (the writer still answers from what was gathered).
"""

import asyncio
import inspect
import logging
import time
import typing as t

from searx.network.client import get_loop
from searx.zjsearch.ai.infra.streaming import LlmStream

from . import echo, fences, wire
from .executor import TOOL_RESULTS

logger = logging.getLogger(__name__)

FIRST_EVENT_TIMEOUT = 135.0
"""Budget for connect + first token of a turn.  A transport health guard
against dead upstreams -- NOT a research limit."""

IDLE_TIMEOUT = 125.0
"""Per-event queue budget while a turn streams."""

_RESEARCH = "research"
_WRITE = "write"


class _Tally:
    """The run's consolidated transport meta: the LAST turn's finish reason
    is the answer's completion state (the writer's, when a writer phase
    ran) and the usage sums across turns -- with a PER-PHASE split
    (research vs write) so the client's account shows where the tokens
    went.  The gates' spend lives outside (the runtime collects it and
    folds it into the settle's usage under ``gates``)."""

    def __init__(self) -> None:
        self.finish: str | None = None
        self.model: str | None = None
        self.phase = "research"
        self.usage = _zero_usage()
        self.usage_research = _zero_usage()
        self.usage_write = _zero_usage()

    def absorb(self, payload: t.Any) -> dict[str, t.Any]:
        """Fold one turn's finish meta in; RETURNS the meta (the loop reads
        the per-turn echo payloads off it)."""
        meta = payload if isinstance(payload, dict) else {}
        if meta.get("finish"):
            self.finish = str(meta["finish"])
        if meta.get("model"):
            # the API-REPORTED model id of the last turn that reported one
            self.model = str(meta["model"])
        usage = meta.get("usage")
        if isinstance(usage, dict):
            _bump(self.usage, usage)
            _bump(self.usage_research if self.phase == "research" else self.usage_write, usage)
        return meta

    def settle_kwargs(self) -> dict[str, t.Any]:
        return {"finish": self.finish, "usage": self.canonical_usage(), "model": self.model}

    def canonical_usage(self) -> dict[str, t.Any] | None:
        usage = self.usage
        if not self.finish and not (usage["input"] or usage["output"]):
            return None
        return {
            "input": usage["input"],
            "output": usage["output"],
            "thoughts": usage["thoughts"] or None,
            "cached": usage["cached"],
            "cache_write": usage["cache_write"],
            "research": _sub(self.usage_research),
            "write": _sub(self.usage_write),
        }


def _zero_usage() -> dict[str, int]:
    return {"input": 0, "output": 0, "thoughts": 0, "cached": 0, "cache_write": 0}


def _bump(bucket: dict[str, int], usage: dict[str, t.Any]) -> None:
    bucket["input"] += int(usage.get("input") or 0)
    bucket["output"] += int(usage.get("output") or 0)
    thoughts = usage.get("thoughts")
    if thoughts is not None:
        bucket["thoughts"] += int(thoughts)
    bucket["cached"] += int(usage.get("cached") or 0)
    bucket["cache_write"] += int(usage.get("cache_write") or 0)


def _sub(bucket: dict[str, int]) -> dict[str, int] | None:
    if not (bucket["input"] or bucket["output"]):
        return None
    return {
        "input": bucket["input"],
        "output": bucket["output"],
        "thoughts": bucket["thoughts"] or 0,
        "cached": bucket["cached"],
        "cache_write": bucket["cache_write"],
    }


class _Run:
    """One run's plumbing: the transport config, the entry counter, the
    finish tally, the turn streamer."""

    def __init__(
        self,
        cfg: dict[str, t.Any],
        first_event_timeout: float,
        idle_timeout: float,
        tools: list[dict[str, t.Any]] | None = None,
    ) -> None:
        self.cfg = cfg
        self.first_event_timeout = first_event_timeout
        self.idle_timeout = idle_timeout
        self.tools = tools
        self.tally = _Tally()
        self.entries = 0
        # the write turn's gallery counter (the {{zjs-gallery:i}} indexes)
        self.galleries = 0

    def next_entry(self) -> int:
        self.entries += 1
        return self.entries

    def stream_turn(  # pylint: disable=too-many-branches, too-many-statements, too-many-locals
        self, entry: int, messages: list[dict[str, t.Any]], with_tools: bool
    ) -> t.Iterator[t.Any]:
        """One LLM turn: stream it, relay think/say deltas onto ``entry``,
        absorb the finish meta.  Yields wire events and RETURNS ``(text,
        reasoning, calls, meta, died)`` -- ``died`` covers transport errors
        and timeouts (the caller decides fatal vs recoverable)."""
        stream = LlmStream(self.cfg, messages, relay_reasoning=True, tools=self.tools if with_tools else None)
        turn_text = ""
        turn_reasoning = ""
        calls: list[dict[str, t.Any]] = []
        meta: dict[str, t.Any] = {}
        kind, payload = "end", None
        first = True
        try:
            while True:
                # the transport health budget is enforced PER EVENT: a
                # reasoning-looping model streams events forever, and only
                # the timeouts stop it
                wait = _event_wait(first, self.first_event_timeout, self.idle_timeout)
                kind, payload = stream.next_event(wait)
                first = False
                if kind == "think":
                    turn_reasoning += str(payload or "")
                    yield {"e": "think", "id": entry, "t": str(payload or "")}
                elif kind == "delta":
                    turn_text += str(payload or "")
                    yield {"e": "say", "id": entry, "t": str(payload or "")}
                elif kind == "tool_calls":
                    calls = list(payload or [])
                else:
                    if kind == "finish":
                        meta = self.tally.absorb(payload)
                    break  # "end" / "finish" / "error" closes the turn
        finally:
            # an abandoned consumer (client disconnect) closes this
            # generator right here -- cancel the pump towards the loop
            stream.cancel()
        # the turn closes on "finish" (clean) / "end" (clean, no meta) /
        # "error" (transport failure or idle timeout -- next_event maps it)
        died = kind == "error"
        if died:
            logger.warning("zjsearch loop: turn stream failed: %s", payload)
        return (turn_text, turn_reasoning, calls, meta, died)


def run(  # pylint: disable=too-many-branches, too-many-locals, too-many-statements, too-many-arguments
    cfg: dict[str, t.Any],
    messages: list[dict[str, t.Any]],
    *,
    tools: list[dict[str, t.Any]] | None = None,
    executor: t.Any = None,
    max_rounds: int = 1,
    round_progress: t.Callable[[int], str | None] | None = None,
    continuation: t.Callable[[], str | None] | None = None,
    pre_write: t.Callable[[], list[dict[str, t.Any]]] | None = None,
    ask_tool: str | None = None,
    ask_shape: t.Callable[[str], dict[str, t.Any] | None] | None = None,
    display: t.Callable[[list[dict[str, t.Any]]], list[dict[str, t.Any]]] | None = None,
    writer: t.Callable[[str | None], list[dict[str, t.Any]] | t.Any] | None = None,
    writer_sources: t.Callable[[], list[dict[str, t.Any]]] | None = None,
    gallery_validator: t.Callable[[str], list[dict[str, t.Any]]] | None = None,
    first_event_timeout: float = FIRST_EVENT_TIMEOUT,
    idle_timeout: float = IDLE_TIMEOUT,
) -> t.Iterator[dict[str, t.Any]]:
    """Drive one run, yielding wire events.  See the module docstring for
    the phase machine; the parameters:

    - ``tools`` + ``executor``: the research phase (both or neither --
      without them the run is a single WRITE turn, the AI Overview shape).
    - ``round_progress(executed_rounds)``: the stall detector -- ``None``
      keeps researching, a string explains the halt and ends the phase.
    - ``pre_write()``: the PRE-WRITE verification pass (the strip's 核验
      stage) -- runs AFTER the research ends and BEFORE the write opens;
      the returned events stream under the ``audit`` phase (evidence
      checks, final gates), so the writer only consumes verified
      material.
    - ``continuation()``: the LEDGER-CLOSE contract -- consulted when a
      turn ends with ZERO calls (the model "stopped researching").
      ``None`` (or a missing callback) lets the run end; a string is the
      continuation note that goes back as a user message and the loop
      runs another turn (capped at two nudges -- a model with genuinely
      nothing left must never be trapped).
    - ``ask_tool`` + ``ask_shape(arguments) -> {intro, questions} | None``:
      the human-in-the-loop escape hatch; an unusable ask degrades to an
      error settle.
    - ``display(calls) -> rows``: the timeline rows of one turn's calls.
    - ``writer(halt) -> messages`` (an awaitable return is bridged onto
      the shared loop), ``writer_sources() -> entries``: the WRITE phase.
    - ``gallery_validator(body) -> items``: the ``zjs-images`` fence
      whitelist (invented urls are dropped server-side).
    """
    run_state = _Run(cfg, first_event_timeout, idle_timeout, tools)
    researching = bool(tools and executor is not None)
    rounds = 0
    halt_message: str | None = None
    carried_error: str | None = None
    refusals = 0

    if researching:
        # the coarse phase spine (the closed set's one coarse event): the
        # run opens in "plan" -- the first turn reads the material and
        # lays out the approach -- and flips to "research" the moment a
        # round's calls actually execute (micro-activity belongs to the
        # entries; this spine only tells the user where they are)
        current_phase = "plan"
        yield {"e": "phase", "name": current_phase}
        while rounds < max_rounds and halt_message is None:
            entry = run_state.next_entry()
            yield {"e": "open", "id": entry, "kind": _RESEARCH, "round": rounds + 1}
            turn_text, turn_reasoning, calls, meta, died = yield from run_state.stream_turn(entry, messages, True)
            if died:
                # a research turn died mid-stream: the transport blip must
                # not throw away the whole run -- the writer still answers
                # from the sources gathered so far
                carried_error = carried_error or "the AI stream was cut before any content"
                yield {"e": "close", "id": entry}
                break
            ask_call = next((c for c in calls if str(c.get("name")) == ask_tool), None) if ask_tool else None
            if ask_call is not None:
                # the human-in-the-loop escape hatch: the turn's calls event
                # flies first (the timeline records the ask like any round),
                # then the ask payload ends the run as ``awaiting`` -- the
                # answers travel back as clarifications on the next request
                yield {"e": "calls", "id": entry, "round": rounds + 1, "items": (display or _noop_display)(calls)}
                shaped = (ask_shape or (lambda _: None))(str(ask_call.get("arguments") or "{}"))
                yield {"e": "close", "id": entry}
                if shaped:
                    yield {"e": "ask", **shaped}
                    yield wire.settle("awaiting", halt="awaiting the user's direction")
                else:
                    yield wire.settle("error", halt="the model asked an unusable question")
                return
            if not calls:
                # the model stopped researching: the phase is over --
                # UNLESS the ledger-closure contract says otherwise (the
                # run ends when the LEDGER closes, not when the model got
                # bored): the continuation note goes back as a user
                # message and the loop runs another turn
                yield {"e": "close", "id": entry}
                note = None
                if continuation is not None:
                    try:
                        note = continuation()
                    except Exception as exc:  # pylint: disable=broad-except
                        logger.warning("zjsearch loop: continuation check failed: %r", exc)
                        note = None
                if note and refusals < 2:
                    refusals += 1
                    messages.append({"role": "user", "content": note})
                    continue
                if note:
                    # the nudges are spent but the ledger is still open --
                    # the WRITER must know the plan was not completed (an
                    # honest research_note beats a confident partial)
                    halt_message = note
                break
            rounds += 1
            yield {"e": "calls", "id": entry, "round": rounds, "items": (display or _noop_display)(calls)}
            if current_phase == "plan":
                current_phase = "research"
                yield {"e": "phase", "name": current_phase}
            filled: list[tuple[dict[str, t.Any], str] | None] = [None] * len(calls)
            try:
                for event in executor(calls):
                    if event[0] == TOOL_RESULTS:
                        _align_results(event[1], filled)
                    else:
                        yield _stamp(event, entry)
            except Exception as exc:  # pylint: disable=broad-except
                logger.warning("zjsearch loop: tool executor failed: %s: %s", type(exc).__name__, str(exc)[:300])
            messages.append(
                echo.assistant_tool_calls_message(
                    turn_text,
                    calls,
                    echo.echo_blocks((meta.get("usage") or {}).get("thinking_blocks") or [], turn_reasoning),
                    encrypted_content=str(meta.get("encrypted_content") or ""),
                    reasoning_items=meta.get("reasoning_items") or [],
                )
            )
            for index, call in enumerate(calls):
                pair = filled[index]
                messages.append(
                    echo.tool_result_message(call, pair[1] if pair else f"error: the {call.get('name')} tool failed")
                )
            yield {"e": "close", "id": entry}
            if round_progress is not None:
                # the progress verdict lands AFTER the round's results are in
                # the conversation: the next loop iteration sees the halt
                try:
                    halt_message = round_progress(rounds)
                except Exception as exc:  # pylint: disable=broad-except
                    logger.warning("zjsearch loop: round progress check failed: %r", exc)
                    halt_message = None

        if writer is not None:
            # the PRE-WRITE verification pass (核验): runs under its own
            # phase BEFORE the write opens -- the writer consumes verified
            # material only
            if pre_write is not None:
                try:
                    pre_events = pre_write()
                except Exception as exc:  # pylint: disable=broad-except
                    logger.warning("zjsearch loop: pre-write pass failed: %r", exc)
                    pre_events = []
                if pre_events:
                    yield from pre_events
            # the researcher/writer handoff: the recalled past-research
            # sources fly as one sources event (numbered AFTER the live
            # feed's final [n], so the answer can cite them), then a FRESH
            # completion writes the reader-facing answer
            current_phase = "write"
            yield {"e": "phase", "name": current_phase}
            if writer_sources is not None:
                try:
                    entries = writer_sources()
                except Exception as exc:  # pylint: disable=broad-except
                    logger.warning("zjsearch loop: writer sources failed: %r", exc)
                    entries = []
                if entries:
                    yield {"e": "sources", "items": entries}
            try:
                built = writer(halt_message)
            except Exception as exc:  # pylint: disable=broad-except
                logger.warning("zjsearch loop: writer messages failed: %r", exc)
                built = None
            if built is not None and inspect.isawaitable(built):
                # an async writer builds the embedding-ranked context (the
                # relevance order): the loop executes on the WSGI thread, the
                # coroutine bridges onto the shared network loop where the
                # embedding SDK rides
                built = asyncio.run_coroutine_threadsafe(built, get_loop()).result()
            if built:
                messages = built

    yield from _write_turn(run_state, messages, carried_error, gallery_validator)


def _write_turn(  # pylint: disable=too-many-branches, too-many-statements, too-many-locals
    run_state: _Run,
    messages: list[dict[str, t.Any]],
    carried_error: str | None,
    gallery_validator: t.Callable[[str], list[dict[str, t.Any]]] | None,
) -> t.Iterator[dict[str, t.Any]]:
    """One WRITE turn: a fresh completion whose ``answer`` deltas are the
    run's answer (narration never mixes in).  The ``related`` /
    ``zjs-images`` fences are intercepted server-side.  A stream that
    closes with zero relayed events retries ONCE; a reasoning-only writer
    is NOT retried (the identical request would repeat the misroute)."""
    run_state.tally.phase = "write"
    entry = run_state.next_entry()
    yield {"e": "open", "id": entry, "kind": _WRITE}
    splitter = fences.FenceSplitter()
    answered = False
    reasoning = False
    for attempt in (1, 2):
        outcome = yield from _write_attempt(run_state, messages, entry, splitter, gallery_validator)
        if outcome == "content":
            answered = True
            break
        if outcome == "failed":
            # the transport errored: no retry (the settle below surfaces it)
            break
        reasoning = True
        logger.warning("zjsearch loop: the writer produced no content (attempt %d/2)", attempt)
    prose, closed = splitter.finish()
    if prose:
        yield {"e": "answer", "t": prose}
    for fence_kind, body in closed:
        yield from _fence(fence_kind, body, gallery_validator, run_state)
    yield {"e": "close", "id": entry}
    if not answered:
        halt = carried_error or (
            "the model answered in its reasoning channel only -- no answer text"
            if reasoning
            else "the model returned no answer text"
        )
        yield wire.settle("error", halt=halt, **run_state.tally.settle_kwargs())
        return
    yield wire.settle("done", halt=carried_error or None, **run_state.tally.settle_kwargs())


def _write_attempt(  # pylint: disable=too-many-branches
    run_state: _Run,
    messages: list[dict[str, t.Any]],
    entry: int,
    splitter: fences.FenceSplitter,
    gallery_validator: t.Callable[[str], list[dict[str, t.Any]]] | None,
) -> t.Iterator[t.Any]:
    """One writer stream attempt: relay think/answer deltas through the
    fence splitter.  Yields wire events and RETURNS the outcome --
    ``"content"`` (the answer channel spoke), ``"reasoning"`` (only the
    reasoning channel did), ``"failed"`` (the transport errored)."""
    stream = LlmStream(run_state.cfg, messages, relay_reasoning=True)
    first = True
    try:
        while True:
            wait = _event_wait(first, run_state.first_event_timeout, run_state.idle_timeout)
            kind, payload = stream.next_event(wait)
            first = False
            if kind == "delta":
                prose, closed = splitter.feed(str(payload or ""))
                if prose:
                    yield {"e": "answer", "t": prose}
                for fence_kind, body in closed:
                    yield from _fence(fence_kind, body, gallery_validator, run_state)
            elif kind == "think":
                yield {"e": "think", "id": entry, "t": str(payload or "")}
            elif kind == "finish":
                run_state.tally.absorb(payload)
            elif kind == "error":
                logger.warning("zjsearch loop: writer stream failed: %s", payload)
                return "failed"
            else:
                break  # "end" closes the writer
    finally:
        stream.cancel()
    return "content"


def _fence(
    kind: str,
    body: str,
    gallery_validator: t.Callable[[str], list[dict[str, t.Any]]] | None,
    run_state: _Run,
) -> t.Iterator[dict[str, t.Any]]:
    """One closed fence: ``related`` queues the questions (a pre-settle
    related event), a ``zjs-images`` group is validated server-side and
    emitted as a gallery event plus its placeholder delta at the fence's
    position in the answer."""
    if kind == "related":
        found = fences.parse_related_questions(body)
        if found:
            yield {"e": "related", "items": found[:3]}
        return
    if gallery_validator is None:
        return
    items = gallery_validator(body)[:4]
    if not items:
        return
    index = run_state.galleries
    run_state.galleries += 1
    mark = f"\n{{{{zjs-gallery:{index}}}}}\n"
    # the placeholder RIDES the answer text: the client's renderer expands
    # `{{zjs-gallery:i}}` positions against the galleries array -- a gallery
    # event alone would leave the group stored but never rendered
    yield {"e": "answer", "t": mark.strip()}
    yield {"e": "gallery", "items": items}


def _align_results(
    pairs: list[tuple[dict[str, t.Any], str]],
    filled: list[tuple[dict[str, t.Any], str] | None],
) -> None:
    """Fold the executor's terminal tool_results into the per-call slots
    (aligned BY POSITION with the round's calls)."""
    for index, pair in enumerate(pairs):
        filled[index] = pair


def _stamp(event: tuple[str, t.Any], entry: int) -> dict[str, t.Any]:
    """An executor event as a wire event, stamped with the current entry
    (the tasks event keeps its round + in-round call id INSIDE the
    payload -- the client addresses the step by entry and the row by
    call)."""
    kind, payload = event
    stamped = {"entry": entry, **(payload or {})}
    if kind == "call":
        return {"e": "call", "id": entry, **stamped}
    return {"e": kind, **stamped}


def _noop_display(calls: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    return [{"id": index, "tool": str(call.get("name") or ""), "q": ""} for index, call in enumerate(calls, 1)]


def _event_wait(first: bool, first_event_timeout: float, idle_timeout: float) -> float:
    """Seconds to wait for the next stream event."""
    return first_event_timeout if first else idle_timeout


def time_monotonic() -> float:
    """Re-exported for the runtime's elapsed accounting (a single clock)."""
    return time.monotonic()
