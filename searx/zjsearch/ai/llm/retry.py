# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The model-request retry policy: one failure classifier + one backoff
curve for EVERY chat completion (the port of ZCode's
failure-classifier/retry-policy pair, sized for this codebase).

The boundary rule lives at the ONE choke point where every dialect's
pump surfaces its stream-establishment failure
(:meth:`sdk.Sdk.pump`): a request that fails BEFORE its first committed
event is retried invisibly -- the consumer never sees a dangling
attempt.  Once any event reached the queue (the stream was alive) a
failure propagates: the loop's own recovery paths (research blip →
writer, reactive compact) own it from there.  ``Retry-After`` takes
precedence over the backoff curve when the provider sent one."""

import asyncio
import logging
import random
import typing as t

logger = logging.getLogger(__name__)

RETRY_MAX_ATTEMPTS = 3
"""Total attempts per request (NOT per turn -- the loop's own timeout
budgets bound the whole turn)."""

RETRY_BASE_SECONDS = 2.0
RETRY_CAP_SECONDS = 30.0
"""Exponential 2s x2, capped -- a 60s Retry-After would blow the loop's
first-event budget, so the cap wins over a longer provider hint."""

_RETRYABLE_STATUS = frozenset({408, 409, 429, 500, 502, 503, 504, 529})
"""529 = Anthropic's overloaded."""

_RETRYABLE_TEXT = ("rate limit", "overloaded", "temporarily", "try again", "capacity")


def _status_of(exc: BaseException) -> int | None:
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    try:
        return int(status) if status is not None else None
    except (TypeError, ValueError):
        return None


def _retry_after_of(exc: BaseException) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    raw: t.Any = None
    try:
        raw = headers.get("retry-after")
    except Exception:  # pylint: disable=broad-except
        return None
    if raw is None:
        return None
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        return None


def classify_failure(exc: BaseException) -> tuple[bool, float | None]:
    """``(retryable, retry_after_seconds)`` off the exception's status /
    transport type / provider text.  A 400-tier rejection is NEVER
    retried here -- a context overflow is the reactive compact's job,
    any other bad request is a configuration fact."""
    retry_after = _retry_after_of(exc)
    status = _status_of(exc)
    if status is not None:
        return (status in _RETRYABLE_STATUS, retry_after)
    name = type(exc).__name__.lower()
    if any(mark in name for mark in ("timeout", "connection", "transport", "network")):
        return (True, retry_after)
    text = str(exc).lower()
    if any(mark in text for mark in _RETRYABLE_TEXT):
        return (True, retry_after)
    return (False, retry_after)


def backoff_delay(attempt: int, retry_after: float | None) -> float:
    """The wait before retry ``attempt`` (0-based): the provider's hint
    when it gave one, else jittered exponential."""
    if retry_after is not None:
        return min(retry_after, RETRY_CAP_SECONDS)
    return min(RETRY_BASE_SECONDS * (2**attempt), RETRY_CAP_SECONDS) * (0.5 + random.random() * 0.5)


async def with_retry(
    run: t.Callable[[], t.Awaitable[t.Any]],
    *,
    committed: t.Callable[[], int],
    label: str = "request",
) -> t.Any:
    """Run ``run()`` retrying pre-commit failures (``committed()`` counts
    the events the attempt already handed the consumer -- a nonzero count
    means the stream was alive and the failure propagates)."""
    attempt = 0
    while True:
        try:
            return await run()
        except Exception as exc:  # pylint: disable=broad-except
            if committed():
                raise
            retryable, retry_after = classify_failure(exc)
            if not retryable or attempt >= RETRY_MAX_ATTEMPTS - 1:
                raise
            delay = backoff_delay(attempt, retry_after)
            logger.warning(
                "zjsearch llm: %s failed (%s: %s) -- retry %s/%s in %.1fs",
                label,
                type(exc).__name__,
                str(exc)[:160],
                attempt + 1,
                RETRY_MAX_ATTEMPTS,
                delay,
            )
            attempt += 1
            await asyncio.sleep(delay)
