# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

"""AI Search: the ``record_findings`` tool -- the BELIEF LEDGER's model surface.

v2 turns dzhng's append-only findings into a ledger the model REvises:
facts carry identity (``supersedes`` / ``retracts`` name earlier fact
ids) and the ledger carries a GAPS partition -- the open questions the
research still owes an answer to.  Gap-closing is the loop's engine: the
writer reads the facts, the next rounds chase the gaps, and the run
ends when the ledger closes (subtasks covered, gaps answered or
explicitly abandoned), not when the model got bored.
"""

import typing as t

from searx.zjsearch.ai.core.text import raw_args

RECORD_FINDINGS_TOOL = "record_findings"
"""The wire name matches the module and every prompt mention (the
pre-rename wire name "findings" survives only inside stored threads'
event logs, which render historical rows verbatim)."""

LEARNING_MAX_CHARS = 400
"""One recorded finding's cap -- a finding is one self-contained sentence,
not a paragraph (the writer reads them alongside the full sources)."""

GAP_MAX_CHARS = 200
"""One gap question's cap -- a gap names WHAT is missing, not an essay."""

FACT_TAG_MAX = 3
"""Concept tags per fact (1-3 short strings) -- the knowledge graph's
evidence layer: the model names the topics a fact belongs to at write
time (zero extra calls), the client folds them into the run row's tags
and the tag graph renders the fact-bearing topics."""

FACT_TAG_CHARS = 24
"""One fact tag's cap -- a concept word, not a sentence."""


def record_findings_spec() -> dict[str, t.Any]:
    """The ``record_findings`` tool spec: a belief ledger with two partitions --
    facts (with revision ops) and gaps (with close ops)."""
    return {
        "name": RECORD_FINDINGS_TOOL,
        "description": (
            "Maintain the research BELIEF LEDGER -- what the sources"
            " ESTABLISHED, and what the question still OWES.  Two"
            " partitions, one call, roughly once per round:  (1) facts --"
            " self-contained [n]-cited sentences (\"DeepSeek-V4 ships a"
            ' 256k context window [4]"); REvise the ledger as evidence'
            ' moves: {"text": ..., "supersedes": <fact id>} replaces an'
            ' earlier fact the new evidence corrects, {"text": ...,'
            ' "retracts": <fact id>} withdraws one a source contradicted.'
            "  (2) gaps -- the open questions between the evidence and a"
            ' complete answer: open_gaps adds {"q": ..., "why": ...}'
            ' (what is missing and why it matters), close_gaps settles'
            ' one {"q": ..., "close_as": "answered by [7]" | "no public'
            ' data exists"} -- closing a gap with an honest reason IS'
            " progress.  Never record plans (the task list owns those)"
            " and never a fact no source supports.  The writer reads the"
            " facts; your next rounds chase the gaps; the run ends when"
            " the ledger closes."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "facts": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "text": {
                                "type": "string",
                                "description": "One self-contained finding, [n]-cited.",
                            },
                            "refs": {
                                "type": "array",
                                "items": {"type": "number"},
                                "description": "The [n] source numbers the fact rests on.",
                            },
                            "supersedes": {
                                "type": "number",
                                "description": "Fact id this CORRECTS (the old fact retires).",
                            },
                            "retracts": {
                                "type": "number",
                                "description": "Fact id this CONTRADICTS (the old fact withdraws).",
                            },
                            "tags": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": (
                                    "1-3 SHORT concept tags naming the topics this fact belongs to"
                                    ' (e.g. ["DeepSeek-V4", "context window"]) -- reuse the tags earlier'
                                    " facts used; they place the fact in the knowledge graph."
                                ),
                            },
                        },
                        "required": ["text"],
                    },
                    "description": "Up to 6 fact operations this round (new / supersede / retract).",
                },
                "open_gaps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "q": {"type": "string", "description": "The question the evidence does not answer yet."},
                            "why": {"type": "string", "description": "Why the answer needs it."},
                        },
                        "required": ["q"],
                    },
                    "description": "Up to 4 NEW gaps discovered this round.",
                },
                "close_gaps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "q": {"type": "string", "description": "The gap's question (as you opened it)."},
                            "close_as": {
                                "type": "string",
                                "description": 'How it settled: "answered by [7]" or "no public data exists".',
                            },
                        },
                        "required": ["q"],
                    },
                    "description": "Up to 4 gaps this round settled.",
                },
            },
            "required": ["facts"],
        },
    }


def parse_record_findings_call(call: dict[str, t.Any]) -> dict[str, t.Any]:
    """The sanitized ledger operations out of one ``record_findings`` call:
    ``{"facts": [...], "open_gaps": [...], "close_gaps": [...]}`` -- every
    entry trimmed, capped and type-checked; malformed shapes drop
    silently (a ledger op must never crash a settlement)."""
    args = raw_args(call)
    facts: list[dict[str, t.Any]] = []
    for fact in (args.get("facts") if isinstance(args.get("facts"), list) else [])[:8]:
        if not isinstance(fact, dict):
            continue
        text = " ".join(str(fact.get("text") or "").split())[:LEARNING_MAX_CHARS]
        if not text:
            continue
        entry: dict[str, t.Any] = {"text": text}
        refs = fact.get("refs")
        if isinstance(refs, list) and refs:
            entry["refs"] = [int(n) for n in refs[:8] if isinstance(n, (int, float))]
        for key in ("supersedes", "retracts"):
            value = fact.get(key)
            if isinstance(value, (int, float)):
                entry[key] = int(value)
        tags = fact.get("tags")
        if isinstance(tags, list) and tags:
            cleaned = [t2 for t2 in (" ".join(str(tag or "").split())[:FACT_TAG_CHARS] for tag in tags[:FACT_TAG_MAX]) if t2]
            if cleaned:
                entry["tags"] = cleaned
        facts.append(entry)
    open_gaps: list[dict[str, str]] = []
    for gap in (args.get("open_gaps") if isinstance(args.get("open_gaps"), list) else [])[:6]:
        if not isinstance(gap, dict):
            continue
        q = " ".join(str(gap.get("q") or "").split())[:GAP_MAX_CHARS]
        if not q:
            continue
        open_gaps.append({"q": q, "why": " ".join(str(gap.get("why") or "").split())[:GAP_MAX_CHARS]})
    close_gaps: list[dict[str, str]] = []
    for gap in (args.get("close_gaps") if isinstance(args.get("close_gaps"), list) else [])[:6]:
        if not isinstance(gap, dict):
            continue
        q = " ".join(str(gap.get("q") or "").split())[:GAP_MAX_CHARS]
        if not q:
            continue
        close_gaps.append({"q": q, "close_as": " ".join(str(gap.get("close_as") or "").split())[:GAP_MAX_CHARS]})
    return {"facts": facts, "open_gaps": open_gaps, "close_gaps": close_gaps}
