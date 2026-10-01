# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The structured-object gate and the upstream-text helpers.

:py:func:`json_completion` runs one small structured-object completion
(the gates -- clarify, related questions, follow-up rewrite): NATIVE
structured output per dialect with a tiered fallback, then the plain
streaming completion as the last resort.  The gates fail open (the
caller answers without the structured payload), so this module returns
``None`` instead of raising.
"""

import asyncio
import json
import logging
import re
import time
import typing as t

from searx.network.client import get_loop

from .sdk import resolve
from .streaming import LlmStream

logger = logging.getLogger(__name__)

_JSON_COMPLETION_TIMEOUT = 90.0
"""Wall clock for one native structured-object call (the gates): a
reasoning model may think for a while before emitting its single JSON
payload."""


def json_object_of(text: str) -> dict[str, t.Any] | None:
    """The first JSON object in a completion's text -- the lenient repair pass of
    the belt-and-braces: OpenAI-compatible gateways (LM Studio, vLLM,
    proxies) silently ignore ``response_format``/``output_config``, so the
    payload may arrive fenced or prose-wrapped even under native mode."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        value = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _array_of(text: str) -> list | None:
    """The first JSON array in the text -- models emit a bare list when
    the prompt says "return a list" (the wrap-into-object repair reads
    it for single-array-property schemas)."""
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end <= start:
        return None
    try:
        value = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, list) else None


def _single_array_prop(schema: dict[str, t.Any] | None) -> str | None:
    """The schema's single top-level property when its type is array --
    the shape a bare-list response can be wrapped into."""
    props = (schema or {}).get("properties") or {}
    if len(props) != 1:
        return None
    name, spec = next(iter(props.items()))
    types = (spec or {}).get("type") if isinstance(spec, dict) else None
    types = types if isinstance(types, list) else [types]
    return str(name) if "array" in types else None


def reason_of(payload: str | None) -> str:
    """A one-line, truncated upstream error for the 502 body: the client
    shows it under the answer card's failed label so a broken transport is
    readable in the UI (the full detail stays in the server log).  Tags are
    stripped -- gateways and proxies love answering with HTML error pages,
    and the raw markup would bury the actual message (the <title> text)."""
    text = re.sub(r"<[^>]+>", " ", str(payload or ""))
    text = " ".join(text.split())
    return text[:240] or "upstream returned an empty stream"


def _stream_plain_text(cfg: dict[str, t.Any], messages: list[dict[str, t.Any]]) -> tuple[str, dict[str, t.Any] | None]:
    """The plain streaming fallback every dialect already speaks (the
    reasoning-aware shape: the relay keeps the queue alive through a
    think phase; only content deltas are collected).  The stream's finish
    meta is the usage account."""
    stream = LlmStream(cfg, messages, relay_reasoning=True)
    text = ""
    usage: dict[str, t.Any] | None = None
    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        kind, payload = stream.next_event(45.0)
        if kind == "delta":
            text += str(payload or "")
        elif kind == "finish":
            meta = payload if isinstance(payload, dict) else {}
            usage = meta.get("usage")
        elif kind in ("error", "end"):
            break
    stream.cancel()
    return text, usage


_json_tier_cache: dict[tuple[str, str], int] = {}
"""``(kind, base)`` -> the native tier a gate should START from (0 =
strict schema, ... , len(attempts) = none of them worked): endpoints
answer capability questions the same way every time, so a rejected
constraint is remembered per endpoint instead of re-paid with a 400 on
every gate call."""


def json_completion(
    cfg: dict[str, t.Any],
    messages: list[dict[str, t.Any]],
    name: str,
    schema: dict[str, t.Any],
) -> tuple[dict[str, t.Any] | None, dict[str, t.Any] | None]:
    """Returns ``(parsed object, usage)`` -- the value is ``None`` when
    every tier missed (callers fail open); the usage is whatever the
    successful attempt (or the fallback) reported, so the gates' token
    spend joins the run's account.

    One small structured-object completion (the gates -- clarify, related
    questions, follow-up rewrite): NATIVE structured output per dialect
    with a tiered fallback.  openai chat / responses speak strict
    ``json_schema`` first and the weaker ``json_object`` mode second
    (DeepSeek and friends support the latter where the full schema is
    unavailable); anthropic speaks ``output_config.format``; gemini
    ``response_json_schema``.  Vane's belt-and-braces on top: the payload
    still goes through a lenient brace-scan repair (gateways ignore
    output constraints), and any native failure falls back to the plain
    streaming completion every dialect speaks.  The value is ``None``
    when every tier missed (callers fail open)."""
    sdk = resolve(cfg)
    tiers = max(1, int(sdk.json_tiers))
    attempts = [
        # the first tier requests the strict native mode where the dialect
        # speaks one; later tiers use the dialect's weaker native mode
        (lambda tier=offset: sdk.json_completion(messages, name, schema, tier == 0))
        for offset in range(tiers)
    ]
    cache_key = (sdk.kind, sdk.base)
    start = _json_tier_cache.get(cache_key, 0)
    for offset, make in enumerate(attempts[start:], start):
        try:
            text, usage = asyncio.run_coroutine_threadsafe(make(), get_loop()).result(_JSON_COMPLETION_TIMEOUT)
        except Exception as exc:  # pylint: disable=broad-except
            # an endpoint that rejects this constraint (or lacks it) lands
            # here -- the next tier, then the plain fallback, still answer.
            # A 400-class rejection is remembered: capabilities do not
            # flip between calls, so later gates skip straight to the
            # tier that works (transient errors are NOT remembered)
            if getattr(exc, "status_code", None) == 400:
                _json_tier_cache[cache_key] = offset + 1
            logger.warning(
                "zjsearch_ai: native structured output failed (%s: %.140s) -- next tier",
                type(exc).__name__,
                str(exc),
            )
            continue
        value = _parsed(text, schema)
        if value is not None:
            _json_tier_cache[cache_key] = offset
            return value, usage
    text, usage = _stream_plain_text(cfg, messages)
    return _parsed(text, schema), usage


def _parsed(text: str, schema: dict[str, t.Any]) -> dict[str, t.Any] | None:
    """The lenient parse of one attempt's text: the first JSON object,
    or -- when the schema is a single-array-property object -- a bare
    top-level array wrapped into it (the "return a list" literalism)."""
    value = json_object_of(text) if text else None
    if value is not None:
        return value
    array = _array_of(text) if text else None
    prop = _single_array_prop(schema)
    if array is not None and prop:
        return {prop: array}
    return None
