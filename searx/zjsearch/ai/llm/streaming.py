# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The queue bridge from the shared network event loop to the WSGI thread.

:py:class:`LlmStream` starts the dialect's pump coroutine on the shared
loop and hands the consumer a synchronous ``next_event`` pull.  Abandoned
streams (client disconnect, idle timeout) are cancelled towards the loop,
so no request outlives its consumer.
"""

import asyncio
import logging
import queue
import typing as t

from searx.network.client import get_loop

from . import config
from .dialects import DIALECTS

logger = logging.getLogger(__name__)


async def _llm_pump(
    cfg: dict[str, t.Any],
    kind: str,
    base: str,
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool = False,
    tools: list[dict[str, t.Any]] | None = None,
) -> None:
    """Drive the dialect's SDK stream and relay it into ``events``; runs on
    the shared network event loop (see :py:class:`LlmStream`).  SDK client
    construction and request errors land as ("error", ...) events; the pump
    always ends with ("end", None).  A clean stream carries one
    ("finish", {"finish", "usage"}) meta event right before the end."""
    try:
        await DIALECTS[kind].pump(cfg, base, messages, events, relay_reasoning, tools)
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_ai: LLM stream error: %s: %s", type(exc).__name__, str(exc)[:300])
        events.put(("error", f"{type(exc).__name__}: {exc}"))
    finally:
        events.put(("end", None))


class LlmStream:
    """Queue bridge from the shared network event loop to the WSGI thread:
    the pump coroutine pushes events, :py:meth:`next_event` pulls them
    synchronously.  Abandoned streams (client disconnect, idle timeout) are
    cancelled towards the loop, so no request outlives its consumer."""

    def __init__(
        self,
        cfg: dict[str, t.Any],
        messages: list[dict[str, t.Any]],
        relay_reasoning: bool = False,
        tools: list[dict[str, t.Any]] | None = None,
    ):
        self.events: "queue.Queue[tuple[str, t.Any]]" = queue.Queue()
        self.loop = get_loop()
        kind, base = config.endpoint(cfg)
        self.task = asyncio.run_coroutine_threadsafe(
            _llm_pump(cfg, kind, base, messages, self.events, relay_reasoning, tools), self.loop
        )

    def next_event(self, timeout: float) -> tuple[str, str | None]:
        try:
            kind, payload = self.events.get(timeout=timeout)
        except queue.Empty:
            logger.warning("zjsearch_ai: LLM stream idle timeout")
            return ("error", "LLM stream idle timeout")
        if kind == "error":
            logger.warning("zjsearch_ai: LLM stream error: %s", payload)
        if kind not in ("delta", "think"):
            self.cancel()
        return (kind, payload)

    def cancel(self) -> None:
        if not self.task.done():
            self.loop.call_soon_threadsafe(self.task.cancel)
