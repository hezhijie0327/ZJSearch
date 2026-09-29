# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: the agent loop and think-block state machine.

The one agent framework every theme AI feature runs on --
:py:mod:`searx.zjsearch.ai.overview` as the zero-tool single-turn case,
:py:mod:`searx.zjsearch.ai.search` as the tool-calling one:

- :py:func:`run_agent` drives turns over :py:mod:`searx.zjsearch.ai.llm`.
  A turn streams ``("think"|"delta", text)`` events; when it ends with
  tool calls (only possible with a ``tools`` spec + an ``executor``) the
  executor runs -- yielding its own feature events -- and its results go
  back to the model as tool messages for the next turn.  Budgets (tool
  rounds, an optional wall clock) bound the research; when it ends -- or
  a ``writer`` builder is present and the model stops calling tools --
  a FRESH completion writes the final answer from the gathered sources
  (the researcher/writer split: the researcher's prose never becomes the
  answer).  Abandoned runs (client disconnect) cancel the underlying
  stream -- no request outlives its consumer.

- :py:class:`ThinkGate` owns the ``<think>`` block semantics: the first
  reasoning delta opens the block, the first content delta closes it,
  stray reasoning after content is dropped.  Wire adapters render their
  own markers (raw-text ``<think>`` tags or NDJSON events) around this
  one shared state machine.

Events yielded by :py:func:`run_agent` are ``(kind, payload)`` tuples:
``("think"|"delta", text)``, ``("calls", {"round", "intent", "calls"})``,
``("plan", {"t": text})`` -- the answer-plan turn's prose re-homed as a
research step (see ``plan_tool``) --, ``("ask_user", arguments)``,
``("error", reason)``, plus the executor's feature events passed
through.  The executor contract: a generator over the executable calls
that yields ``(kind, payload)`` feature events and MUST end with
``("tool_results", [(call, text), ...])`` aligned with its input.
"""

import json
import logging
import time
import typing as t

from searx.zjsearch.ai import llm

logger = logging.getLogger(__name__)

FIRST_EVENT_TIMEOUT = 135.0
"""Budget for connect + first token of a turn (see llm.LlmStream).  A
transport health guard against dead upstreams -- NOT a research limit."""

IDLE_TIMEOUT = 125.0
"""Per-event queue budget while a turn streams."""

_PLAN_ACK = (
    "Plan noted -- it is now visible to the user as your research step."
    "  Continue researching if you still have gaps; otherwise your NEXT"
    " message is the final answer itself: written for the reader, the"
    " first sentence carries the point, no meta commentary and no"
    " restating of the plan."
)


def _plan_text(turn_text: str, calls: list[dict[str, t.Any]], plan_tool: str) -> str:
    """The plan step's text: the turn's own prose; a model that put the
    plan in the tool argument instead gets that."""
    if turn_text.strip():
        return turn_text
    for call in calls:
        if str(call.get("name")) == plan_tool:
            try:
                args = json.loads(str(call.get("arguments") or "") or "{}")
            except ValueError:
                return ""
            if isinstance(args, dict):
                return str(args.get("plan") or "").strip()
    return ""


class ThinkGate:
    """The ``<think>`` block state machine shared by every wire adapter."""

    def __init__(self) -> None:
        self.opened = False
        self.closed = False

    def reasoning(self) -> str:
        """Feed a reasoning delta: ``"open"`` when it opens the block,
        ``"relay"`` while it streams, ``"drop"`` for stray reasoning after
        content (the answer started; late thoughts are not prose)."""
        if self.closed:
            return "drop"
        if not self.opened:
            self.opened = True
            return "open"
        return "relay"

    def content(self) -> None:
        """Feed a content delta: the think block closes for good."""
        self.closed = True


def assistant_tool_calls_message(text: str, calls: list[dict[str, t.Any]]) -> dict[str, t.Any]:
    """Canonical assistant message carrying the turn's prose + tool calls
    (the pumps emit flat ``{"id", "name", "arguments"}`` calls; the
    canonical message nests them under ``"function"``)."""
    return {
        "role": "assistant",
        "content": text,
        "tool_calls": [
            {
                "id": str(call.get("id") or ""),
                "type": "function",
                "function": {"name": str(call.get("name") or ""), "arguments": str(call.get("arguments") or "{}")},
            }
            for call in calls
        ],
    }


def tool_result_message(call: dict[str, t.Any], text: str) -> dict[str, t.Any]:
    """Canonical ``tool`` result for one call (``name`` rides along: the
    gemini dialect needs it for the function_response part)."""
    return {
        "role": "tool",
        "tool_call_id": str(call.get("id") or ""),
        "name": str(call.get("name") or "tool"),
        "content": text,
    }


def _event_wait(deadline: float | None, first: bool, first_event_timeout: float, idle_timeout: float) -> float:
    """Seconds to wait for the next stream event: the per-event timeout,
    capped by the remaining wall-clock budget (0 once it ran out)."""
    wait = first_event_timeout if first else idle_timeout
    if deadline is not None:
        wait = min(wait, max(0.0, deadline - time.monotonic()))
    return wait


def run_agent(  # pylint: disable=too-many-arguments, too-many-branches, too-many-locals, too-many-statements
    cfg: dict[str, t.Any],
    messages: list[dict[str, t.Any]],
    tools: dict[str, t.Any] | None = None,
    executor: t.Callable[[list[dict[str, t.Any]]], t.Iterator[tuple[str, t.Any]]] | None = None,
    max_rounds: int = 1,
    deadline: float | None = None,
    answer_reserve: float = 0.0,  # pylint: disable=unused-argument
    round_progress: t.Callable[[int], str | None] | None = None,
    ask_tool: str | None = None,
    plan_tool: str | None = None,
    writer: t.Callable[[str | None], list[dict[str, t.Any]]] | None = None,
    first_event_timeout: float = FIRST_EVENT_TIMEOUT,
    idle_timeout: float = IDLE_TIMEOUT,
) -> t.Iterator[tuple[str, t.Any]]:
    """Drive the research loop over ``cfg``'s model, yielding events.

    Zero-tool features (AI Overview) pass no ``tools``/``executor`` and
    get exactly one streamed turn whose prose IS the answer.  With tools,
    each turn may end in ``("calls", ...)``: the executor runs every call
    of the round -- the model decides how many one round carries --
    results are appended and the next turn starts.  The ROUND count
    (``max_rounds``) is a SAFETY ceiling, not a plan: productive research
    runs as long as it is productive.  ``round_progress`` (called after
    each executed round with its 1-based number) is the real termination
    policy -- it returns None to continue or a message explaining the
    research has gone stale (no new information for N consecutive
    rounds); time limits are gone on purpose (the user's stop button is
    the control), so ``deadline``/``answer_reserve`` stay supported for
    callers that want them but AI Search passes none.

    The RESEARCHER/WRITER split (Vane's shape, ``writer``): when the
    research phase ends -- the model stops calling tools, the ceiling or
    the stale-research verdict halts it, or a turn's transport dies -- a
    FRESH completion writes the final answer from the sources the
    researcher gathered.  ``writer(halt_message)`` builds the writer's
    messages at that moment; a ``("wrapup", None)`` event flies first (the
    client drops any streamed research prose) and the writer's stream is
    relayed as-is.  The researcher's own prose therefore never becomes
    the answer -- consistency by construction, not by pleading.  Without
    ``writer`` the last turn's prose stays the answer (the zero-tool
    case, and the fail-open path).

    The FIRST_EVENT/IDLE timeouts are transport health guards
    (a dead upstream), not research limits.

    ``plan_tool`` (Vane's reasoning preamble, adapted): when the turn's
    calls include this tool, the turn is answered WITHOUT executing
    anything -- the turn's prose (or the tool's ``plan`` argument) is
    yielded as a ``("plan", ...)`` event, an acknowledgement goes back as
    the tool result, and the loop continues.  The turn is FREE: no round
    consumed, no progress verdict.  Like ``ask_tool`` it must be the only
    call of its turn; riders are refused with a tool error.
    """
    rounds = 0
    halt_message: str | None = None
    researching = bool(tools and executor is not None)
    while True:
        if researching and (rounds >= max_rounds or halt_message is not None):
            # the ceiling or the stale-research verdict ended the gathering:
            # the writer phase below answers from what was gathered
            break
        budget_left = researching
        stream = llm.LlmStream(cfg, messages, relay_reasoning=True, tools=tools if budget_left else None)
        turn_text = ""
        calls: list[dict[str, t.Any]] = []
        kind, payload = "end", None
        expired = False
        first = True
        try:
            while True:
                # the wall-clock budget is enforced PER EVENT, not only
                # between turns: a reasoning-looping model streams events
                # forever, and only the deadline stops it
                wait = _event_wait(deadline, first, first_event_timeout, idle_timeout)
                if wait <= 0:
                    expired = True
                    break
                kind, payload = stream.next_event(wait)
                first = False
                if kind in ("think", "delta"):
                    if kind == "delta":
                        turn_text += str(payload or "")
                    yield (kind, payload)
                elif kind == "tool_calls":
                    calls = list(payload or [])
                else:
                    break  # "end" or "error" closes the turn
        finally:
            # an abandoned consumer (client disconnect) closes this
            # generator right here -- cancel the pump towards the loop
            stream.cancel()
        if expired or kind == "error":
            if not researching:
                # the zero-tool turn's partial prose is all there is
                if turn_text:
                    return
                yield ("error", payload if kind == "error" else "the AI stream was cut before any content")
                return
            # a research turn died mid-stream: the transport blip must not
            # throw away the whole run -- the writer still answers from the
            # sources gathered so far
            break
        if ask_tool:
            # the human-in-the-loop escape hatch: the model realized
            # MID-research that the request is genuinely ambiguous and
            # asked the user instead of guessing through the budget.  End
            # the run here -- the client settles it as awaiting and the
            # answers travel back as clarifications on the next request.
            ask_call = next((c for c in calls if str(c.get("name")) == ask_tool), None)
            if ask_call is not None:
                yield ("ask_user", str(ask_call.get("arguments") or "{}"))
                return
        if plan_tool and any(str(c.get("name")) == plan_tool for c in calls):
            # the answer-planning escape valve (Vane's reasoning preamble):
            # the model's deliberation about the SHAPE of its answer reaches
            # the UI as a plan step instead of leaking into the answer text.
            # The turn is FREE -- it does not count as a research round and
            # the progress verdict never sees it.  Like ask_user, the plan
            # tool must be the only call of its turn: anything that rode
            # along is refused (the model re-issues it).
            yield ("plan", {"t": _plan_text(turn_text, calls, plan_tool)})
            messages.append(assistant_tool_calls_message(turn_text, calls))
            for call in calls:
                ack = (
                    _PLAN_ACK
                    if str(call.get("name")) == plan_tool
                    else (
                        "error: call the plan tool ALONE in its turn -- your other"
                        " calls were not executed; re-issue them now."
                    )
                )
                messages.append(tool_result_message(call, ack))
            continue
        if not calls or not budget_left:
            # the model stopped researching (or the zero-tool turn spoke):
            # the research phase is over
            break
        # rounds count EXECUTED call rounds only -- the wire round must stay
        # aligned with the executor's own numbering or the client cannot
        # settle its timeline rows (the plan turns in between do not
        # execute searches and must not shift the numbering)
        rounds += 1
        executable = calls
        yield ("calls", {"round": rounds, "intent": turn_text, "calls": calls})
        filled: list[tuple[dict[str, t.Any], str] | None] = [None] * len(executable)
        try:
            for event in executor(executable):
                if event[0] == "tool_results":
                    for index, pair in enumerate(event[1]):
                        filled[index] = pair
                else:
                    yield event
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch agent: tool executor failed: %s: %s", type(exc).__name__, str(exc)[:300])
        messages.append(assistant_tool_calls_message(turn_text, calls))
        for index, call in enumerate(executable):
            pair = filled[index]
            messages.append(
                tool_result_message(call, pair[1] if pair else f"error: the {call.get('name')} tool failed")
            )
        if round_progress is not None:
            # the progress verdict lands AFTER the round's results are in
            # the conversation: the next loop iteration sees the halt and
            # transitions to the writer phase
            try:
                halt_message = round_progress(rounds)
            except Exception as exc:  # pylint: disable=broad-except
                logger.warning("zjsearch agent: round progress check failed: %r", exc)
                halt_message = None
    # ------------------------- the writer phase -------------------------
    if writer is None:
        return
    yield ("wrapup", None)
    writer_messages = writer(halt_message)
    stream = llm.LlmStream(cfg, writer_messages, relay_reasoning=True)
    first = True
    try:
        while True:
            wait = _event_wait(None, first, first_event_timeout, idle_timeout)
            kind, payload = stream.next_event(wait)
            first = False
            if kind in ("think", "delta"):
                yield (kind, payload)
            elif kind == "error":
                logger.warning("zjsearch agent: writer stream failed: %s", payload)
                yield ("error", payload)
                return
            else:
                break  # "end" closes the writer
    finally:
        stream.cancel()
    return
