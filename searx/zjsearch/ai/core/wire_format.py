# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The wire protocol's CLOSED event alphabet and its one encoder -- a
CORE leaf on purpose: the shared NDJSON wrapper (``core.ndjson``) needs
the encode-with-validation, and core must not import the agent engine to
get it (the old edge dragged the whole AI stack behind a "leaf" module).
The agent's :py:mod:`agent.wire` re-exports both; the protocol's SEMANTICS
docs live there."""

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


def encode(event: dict[str, t.Any]) -> str:
    """One wire line: JSON + newline, with the closed-set check (a misspelled
    event is a programming error, not a silent client no-op)."""
    kind = event.get("e")
    if kind not in EVENTS:
        raise ValueError(f"unknown wire event: {kind!r}")
    return json.dumps(event, ensure_ascii=False) + "\n"
