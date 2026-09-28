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
  rounds, wall clock with an answer reserve) bound the loop; an exhausted
  budget TELLS the model to wrap up (never a silent tool removal) and
  forces the next turn to run WITHOUT tools, so the model must answer
  from what it has.  Abandoned runs (client disconnect) cancel the
  underlying stream -- no request outlives its consumer.

- :py:class:`ThinkGate` owns the ``<think>`` block semantics: the first
  reasoning delta opens the block, the first content delta closes it,
  stray reasoning after content is dropped.  Wire adapters render their
  own markers (raw-text ``<think>`` tags or NDJSON events) around this
  one shared state machine.

Events yielded by :py:func:`run_agent` are ``(kind, payload)`` tuples:
``("think"|"delta", text)``, ``("calls", {"round", "intent", "calls"})``,
``("error", reason)``, plus the executor's feature events passed
through.  The executor contract: a generator over the executable calls
that yields ``(kind, payload)`` feature events and MUST end with
``("tool_results", [(call, text), ...])`` aligned with its input.
"""

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
    answer_reserve: float = 0.0,
    wrapup_message: str | None = None,
    wrapup_grace: float = 90.0,
    round_progress: t.Callable[[int], str | None] | None = None,
    ask_tool: str | None = None,
    first_event_timeout: float = FIRST_EVENT_TIMEOUT,
    idle_timeout: float = IDLE_TIMEOUT,
) -> t.Iterator[tuple[str, t.Any]]:
    """Drive the tool-calling loop over ``cfg``'s model, yielding events.

    Zero-tool features (AI Overview) pass no ``tools``/``executor`` and
    get exactly one streamed turn.  With tools, each turn may end in
    ``("calls", ...)``: the executor runs every call of the round -- the
    model decides how many one round carries -- results are appended and
    the next turn starts.  The ROUND count (``max_rounds``) is a SAFETY
    ceiling, not a plan: productive research runs as long as it is
    productive.  ``round_progress`` (called after each executed round
    with its 1-based number) is the real termination policy -- it returns
    None to continue or a message explaining the research has gone stale
    (no new information for N consecutive rounds); time limits are gone
    on purpose (the user's stop button is the control), so
    ``deadline``/``answer_reserve`` stay supported for callers that want
    them but AI Search passes none.

    The forced-answer transition is EXPLAINED, never silent: when the
    ceiling, the progress verdict or a caller-set ``answer_reserve``
    takes the tools away, the explaining message is injected as a user
    message and a ``("wrapup", None)`` event flies -- a model that merely
    loses its tools keeps emitting tool-call markup as raw text instead
    of writing the answer.  A deadline that cuts a turn MID-STREAM gets
    the same treatment plus a grace turn: the partial prose is discarded
    (the client drops it on the ``wrapup`` event) and the model rewrites
    the complete answer from scratch under ``wrapup_grace`` seconds.

    The FIRST_EVENT/IDLE timeouts are transport health guards
    (a dead upstream), not research limits.
    """
    rounds = 0
    prev_budget_left = False
    budget_note_injected = False
    wrapping_up = False
    interrupted_text = ""
    halt_message: str | None = None
    while True:
        reserve_ok = deadline is None or deadline - time.monotonic() > answer_reserve
        budget_left = bool(
            tools
            and executor is not None
            and not wrapping_up
            and rounds < max_rounds
            and halt_message is None
            and reserve_ok
        )
        if not budget_left and prev_budget_left and not budget_note_injected:
            # the forced-answer turn must be TOLD: a model that silently
            # loses its tools keeps "calling" them as raw text instead of
            # summarizing (the leaked-markup failure mode).  The progress
            # verdict (stale research) is the more specific explanation.
            note = halt_message or wrapup_message
            if note:
                messages.append({"role": "user", "content": note})
                budget_note_injected = True
                # mark the run as wrapping up: the wrap-up answer is FINAL
                # and a mid-stream cut of this turn goes
                # to the settle-for-partial path, not another grace loop
                wrapping_up = True
                yield ("wrapup", None)
        prev_budget_left = budget_left
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
        if expired and not wrapping_up:
            # the deadline cut a turn mid-stream: the partial prose is NOT
            # an answer.  One graceful no-tools wrap-up turn rewrites the
            # complete answer under a grace deadline; the client dropped
            # the partial prose on the wrapup event.
            wrapping_up = True
            interrupted_text = turn_text
            yield ("wrapup", None)
            note = (
                "  You were interrupted mid-response; whatever you already"
                " streamed was discarded -- write the complete final answer"
                " from scratch."
            )
            messages.append({"role": "user", "content": (wrapup_message or "") + note})
            deadline = time.monotonic() + wrapup_grace
            continue
        if expired or kind == "error":
            # the wrap-up turn itself died: settle for whatever prose
            # exists (the client re-accepts it as the answer), else error
            if not turn_text and interrupted_text:
                yield ("delta", interrupted_text)
            if turn_text or interrupted_text:
                return
            yield ("error", "the AI budget was exhausted before the model answered")
            return
        if ask_tool and not wrapping_up:
            # the human-in-the-loop escape hatch: the model realized
            # MID-research that the request is genuinely ambiguous and
            # asked the user instead of guessing through the budget.  End
            # the run here -- the client settles it as awaiting and the
            # answers travel back as clarifications on the next request.
            ask_call = next((c for c in calls if str(c.get("name")) == ask_tool), None)
            if ask_call is not None:
                yield ("ask_user", str(ask_call.get("arguments") or "{}"))
                return
        if not calls or not budget_left:
            # no tool calls (or none allowed): the turn's prose IS the answer
            return
        # rounds count EXECUTED call rounds only -- the wire round must stay
        # aligned with the executor's own numbering or the client cannot
        # settle its timeline rows (the forced-answer turns in between do
        # not execute searches and must not shift the numbering)
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
            # transitions to the explained wrap-up turn
            try:
                halt_message = round_progress(rounds)
            except Exception as exc:  # pylint: disable=broad-except
                logger.warning("zjsearch agent: round progress check failed: %r", exc)
                halt_message = None
