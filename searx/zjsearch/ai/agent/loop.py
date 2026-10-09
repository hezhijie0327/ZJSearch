# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The agent loop: one run's phase machine over any :class:`llm.sdk` surfaces
transport.

Phases: RESEARCH (tool turns; the model decides how many calls one turn
carries, the executor runs them in parallel) -- with the ``ask_user``
escape hatch as a first-class turn outcome -- then WRITE (a fresh
completion writes the reader-facing answer from the gathered material;
Vane's researcher/writer split: the researcher's prose is structurally
unable to leak into the answer).  Zero-tool callers (AI Overview) get a
single WRITE phase whose stream IS the answer.

The loop YIELDS WIRE EVENTS (see :mod:`agent.wire` -- the closed
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
import json
import logging
import typing as t

from searx.network.client import get_loop
from searx.zjsearch.ai.llm.streaming import LlmStream

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

_STOP_HALT = "stopped_by_user"
"""The user stop's settle halt: the run does NOT walk into the writer --
stopping means stopping (the client's own stop path folds the same
verdict locally, this one is for a second tab / a replay).  Machine KEY,
not prose: the client's i18n catalog renders it (unknown halt strings
fall back to verbatim display)."""

_WRAP_HALT = "wrap_grace_ended"
"""The detach grace's wrap halt (the settle's client-facing KEY): the run
walks into the writer with the material gathered so far -- every run ends
with a REAL terminal state."""

_WRAP_NOTE = (
    "The connection was lost past the detach grace window -- the answer is"
    " written from the material gathered so far."
)
"""The WRITER-facing half of the wrap halt (an honest English research
note -- the model must never see a machine key)."""

_CONTROL_SLICE = 1.0
"""The stop-observable event wait slice (seconds): a stop is seen
within about a second mid-turn, and the per-event idle budgets keep
their exact semantics via the waited accumulator."""


def _ctx_snapshot(messages: list[dict[str, t.Any]], rounds: int) -> dict[str, t.Any]:
    """The resume checkpoint's payload (the ``ctx`` wire event): the
    researcher's EXACT message list at the round boundary.  The copy is
    a JSON round-trip on purpose -- it freezes the list against the
    loop's later mutations AND proves the payload survives the wire;
    the client persists it out-of-log and a continued run replays it
    verbatim as the next request's conversation (the stateless
    server's only conversation storage is the browser's)."""
    return {
        "e": "ctx",
        "round": rounds,
        "messages": json.loads(json.dumps(messages, ensure_ascii=False, default=str)),
    }


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
        interrupt_check: t.Callable[[], tuple[str, str] | None] | None = None,
        entry_base: int = 0,
    ) -> None:
        self.cfg = cfg
        self.first_event_timeout = first_event_timeout
        self.idle_timeout = idle_timeout
        self.tools = tools
        self.interrupt_check = interrupt_check
        # the LAST mid-turn interrupt as (kind, text): "stop" or the
        # preempt's steering text -- the loop reads it when the turn
        # comes back ``interrupted``
        self.last_interrupt: tuple[str, str] = ("stop", "")
        self.tally = _Tally()
        # a resumed run CONTINUES the dead attempt's entry-id space (the
        # client's timeline appends to the same run section -- entry ids
        # must never collide with the stored ones)
        self.entries = entry_base
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
        reasoning, calls, meta, outcome)`` -- the outcome is ``"ok"``,
        ``"died"`` (transport errors and idle timeouts -- the caller
        decides fatal vs recoverable) or ``"interrupted"`` (the run's
        stop flag fired mid-turn: NOT an error, the caller ends the
        research phase on purpose)."""
        stream = LlmStream(self.cfg, messages, relay_reasoning=True, tools=self.tools if with_tools else None)
        turn_text = ""
        turn_reasoning = ""
        calls: list[dict[str, t.Any]] = []
        meta: dict[str, t.Any] = {}
        kind, payload = "end", None
        outcome = "ok"
        first = True
        try:
            while True:
                budget = self.first_event_timeout if first else self.idle_timeout
                waited = 0.0
                while True:
                    kind, payload = stream.wait_event(min(budget - waited, _CONTROL_SLICE))
                    if kind != "timeout":
                        break
                    waited += _CONTROL_SLICE
                    if self.interrupt_check is not None:
                        hit = self.interrupt_check()
                        if hit is not None:
                            stream.cancel()
                            self.last_interrupt = hit
                            outcome = "interrupted"
                            kind, payload = "end", None
                            break
                    if waited >= budget:
                        kind, payload = "error", "LLM stream idle timeout"
                        break
                first = False
                if outcome == "interrupted":
                    logger.warning("zjsearch loop: turn interrupted by the run's stop flag")
                    break
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
        # "error" (transport failure or idle timeout -- the outcome maps it)
        if kind == "error":
            logger.warning("zjsearch loop: turn stream failed: %s", payload)
            outcome = "died"
        return (turn_text, turn_reasoning, calls, meta, outcome)


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
    post_round_injections: t.Callable[[], list[dict[str, t.Any]]] | None = None,
    synthesizer: t.Callable[[t.Any], t.Iterator[dict[str, t.Any]]] | None = None,
    writer_sources: t.Callable[[], list[dict[str, t.Any]]] | None = None,
    gallery_validator: t.Callable[[str], list[dict[str, t.Any]]] | None = None,
    first_event_timeout: float = FIRST_EVENT_TIMEOUT,
    idle_timeout: float = IDLE_TIMEOUT,
    control: t.Any = None,
    entry_base: int = 0,
    round_base: int = 0,
) -> t.Iterator[dict[str, t.Any]]:
    """Drive one run, yielding wire events.  See the module docstring for
    the phase machine; the parameters:

    - ``tools`` + ``executor``: the research phase (both or neither --
      without them the run is a single WRITE turn, the AI Overview shape).
    - ``round_progress(executed_rounds)``: the stall detector -- ``None``
      keeps researching, a string explains the halt and ends the phase.
    - ``pre_write()``: the PRE-WRITE verification pass -- runs AFTER the
      research ends and BEFORE the write opens; the returned events
      stream as-is (evidence checks land in the 决策结果 card), so the
      writer only consumes verified material.
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
    - ``control``: the RUN HOST handle (duck-typed: ``directives()``,
      ``interrupt()``, ``poll_steer()``, ``drain_steers()``) -- boundary
      directives (``stop`` ends the research without the writer; ``wrap``
      halts INTO the writer with the material gathered; ``steer``
      injects the user's message) and the mid-turn interrupt check (the
      event wait is sliced so a stop/preempt cancels the in-flight
      stream within ~1s; a preempt carries its steering text and the run
      CONTINUES on the steered course).
    - ``entry_base`` / ``round_base``: a CONTINUED run's seeds -- the
      dead attempt's entry-id and round counts, so the resumed stream's
      timeline ids never collide with the stored ones and the stall
      detector's accounting carries over.
    """
    run_state = _Run(
        cfg,
        first_event_timeout,
        idle_timeout,
        tools,
        interrupt_check=control.interrupt if control else None,
        entry_base=entry_base,
    )
    researching = bool(tools and executor is not None)
    rounds = round_base
    halt_message: str | None = None
    carried_error: str | None = None
    refusals = 0
    stop_requested = False

    def poll_control() -> str | None:
        """Fold the host's boundary directives into the loop's state;
        RETURNS the one drained steer text (the caller injects it and
        yields the steer event) or ``None``."""
        nonlocal stop_requested, halt_message, carried_error
        if control is None:
            return None
        try:
            directives = control.directives()
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch loop: control poll failed: %r", exc)
            return None
        steer_text = None
        for directive in directives:
            action = str(directive.get("action") or "")
            if action == "stop":
                stop_requested = True
            elif action == "wrap":
                # the wrap halt rides BOTH surfaces, in each one's own
                # language: the writer's prompt gets the honest English
                # note, the settle's halt carries the client-facing KEY
                # (the i18n catalog renders it)
                halt_message = halt_message or _WRAP_NOTE
                carried_error = carried_error or _WRAP_HALT
            elif action == "steer":
                steer_text = str(directive.get("text") or "") or None
        return steer_text

    def inject_steering(text: str) -> None:
        """One steered course correction as the newest user message."""
        messages.append({"role": "user", "content": f"<user_steering>{text}</user_steering>"})

    if researching:
        # the coarse phase spine (the closed set's one coarse event): the
        # run opens in "plan" -- the first turn reads the material and
        # lays out the approach -- and flips to "research" the moment a
        # round's calls actually execute (micro-activity belongs to the
        # entries; this spine only tells the user where they are)
        current_phase = "plan"
        yield {"e": "phase", "name": current_phase}
        # the FIRST resume checkpoint: the seeded conversation is the only
        # copy of itself -- a process death before the first round
        # completes must still be continuable
        yield _ctx_snapshot(messages, rounds)
        while rounds < max_rounds and halt_message is None:
            entry = run_state.next_entry()
            yield {"e": "open", "id": entry, "kind": _RESEARCH, "round": rounds + 1}
            turn_text, turn_reasoning, calls, meta, outcome = yield from run_state.stream_turn(entry, messages, True)
            if outcome == "interrupted":
                # the interrupt fired mid-turn: a deliberate end, never an
                # error -- a STOP closes the research without the writer;
                # a PREEMPT injects its steering text and the loop
                # CONTINUES on the steered course
                ikind, itext = run_state.last_interrupt or ("stop", "")
                yield {"e": "close", "id": entry}
                if ikind == "preempt" and itext:
                    yield {"e": "steer", "text": itext, "delivery": "preempt", "status": "drained"}
                    inject_steering(itext)
                    continue
                stop_requested = True
                break
            if outcome == "died":
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
                steer_text = poll_control()
                if stop_requested:
                    yield {"e": "close", "id": entry}
                    break
                if steer_text:
                    # a steer outranks the ledger-closure contract: the
                    # steered course correction takes the next user slot
                    # and the run keeps researching on it
                    yield {"e": "steer", "text": steer_text, "delivery": "guide", "status": "drained"}
                    inject_steering(steer_text)
                    continue
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
            if post_round_injections is not None:
                # e.g. view_image's fetched pictures ride the next turn as a
                # USER message -- user turns accept image parts on every dialect
                for message in post_round_injections():
                    messages.append(message)
            # the round-boundary resume checkpoint: the conversation is
            # COMPLETE through this round's tool results -- exactly the
            # state a continued run replays
            yield _ctx_snapshot(messages, rounds)
            yield {"e": "close", "id": entry}
            if round_progress is not None:
                # the progress verdict lands AFTER the round's results are in
                # the conversation: the next loop iteration sees the halt
                try:
                    halt_message = round_progress(rounds)
                except Exception as exc:  # pylint: disable=broad-except
                    logger.warning("zjsearch loop: round progress check failed: %r", exc)
                    halt_message = None
            steer_text = poll_control()
            if stop_requested:
                break
            if steer_text:
                yield {"e": "steer", "text": steer_text, "delivery": "guide", "status": "drained"}
                inject_steering(steer_text)

        if stop_requested:
            # a stop SKIPS the write phase on purpose: stopping means
            # stopping -- the settle is an honest error whose halt names
            # the cause (the aborting client folds its own stopped state;
            # this settle is what a second tab / a replay sees)
            yield wire.settle("error", halt=_STOP_HALT, **run_state.tally.settle_kwargs())
            return
        if control is not None:
            # the guide lane CLOSES at the write phase: the leftovers die
            # VISIBLY (the client's pending chips flip to 未送达), never
            # silently
            try:
                leftovers = control.drain_steers()
            except Exception as exc:  # pylint: disable=broad-except
                logger.warning("zjsearch loop: steer drain failed: %r", exc)
                leftovers = []
            for text in leftovers:
                yield {"e": "steer", "text": text, "delivery": "guide", "status": "discarded"}

        if synthesizer is not None or writer is not None:
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
            if synthesizer is not None:
                # the REPORT synthesizer owns the whole write phase: it
                # streams per-section events and the settle itself (its
                # usage lands in the same tally)
                try:
                    yield from synthesizer(run_state.tally)
                except Exception as exc:  # pylint: disable=broad-except
                    logger.warning("zjsearch loop: synthesizer failed: %r", exc)
                    yield wire.settle(
                        "error", halt=f"the report synthesis failed: {exc}", **run_state.tally.settle_kwargs()
                    )
                return
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
        writer_title = fences.parse_related_title(body)
        if writer_title:
            yield {"e": "title", "text": writer_title}
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
