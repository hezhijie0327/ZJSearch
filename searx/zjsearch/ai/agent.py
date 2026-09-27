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
  rounds, calls, wall clock) bound the loop; an exhausted budget forces
  the next turn to run WITHOUT tools, so the model must answer from what
  it has.  Abandoned runs (client disconnect) cancel the underlying
  stream -- no request outlives its consumer.

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
"""Budget for connect + first token of a turn (see llm.LlmStream)."""

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


def run_agent(  # pylint: disable=too-many-arguments, too-many-branches, too-many-locals
    cfg: dict[str, t.Any],
    messages: list[dict[str, t.Any]],
    tools: dict[str, t.Any] | None = None,
    executor: t.Callable[[list[dict[str, t.Any]]], t.Iterator[tuple[str, t.Any]]] | None = None,
    max_rounds: int = 1,
    max_calls_per_round: int = 4,
    max_calls_total: int = 8,
    deadline: float | None = None,
    first_event_timeout: float = FIRST_EVENT_TIMEOUT,
    idle_timeout: float = IDLE_TIMEOUT,
) -> t.Iterator[tuple[str, t.Any]]:
    """Drive the tool-calling loop over ``cfg``'s model, yielding events.

    Zero-tool features (AI Overview) pass no ``tools``/``executor`` and
    get exactly one streamed turn.  With tools, each turn may end in
    ``("calls", ...)``: the executor runs within the remaining budget,
    results are appended (calls beyond the budget get a "skipped" result
    so every call is answered -- an API requirement), and the next turn
    starts.  When the budget is exhausted the next turn runs without
    tools: the model must answer.  The wall-clock ``deadline`` is enforced
    per event -- including mid-turn, so a reasoning-looping model cannot
    stream forever; on exhaustion the stream is cancelled and the run
    either settles the prose already streamed or ends with an error.
    """
    executed = 0
    rounds = 0
    while True:
        budget_left = bool(tools and executor is not None and rounds < max_rounds and executed < max_calls_total)
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
        if expired:
            if turn_text:
                return  # the prose already streamed is the answer
            yield ("error", "the AI budget was exhausted before the model answered")
            return
        if kind == "error":
            yield ("error", payload)
            return
        rounds += 1
        if not calls or not budget_left:
            # the deltas of this turn were the final answer
            return
        keep = max(0, min(max_calls_per_round, max_calls_total - executed))
        executable, skipped = calls[:keep], calls[keep:]
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
        for call in skipped:
            messages.append(
                tool_result_message(call, "skipped: the search budget is exhausted -- answer from what you have")
            )
        executed += len(executable)
