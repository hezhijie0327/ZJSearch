# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``user_memory`` tool: one self-contained package -- the
model-facing spec plus the search/save evaluator it backs, and the
post-run extractor's executor (its prompt text lives in
:py:mod:`prompts.extractor`).  Durable facts about the user (their
city, occupation, standing preferences) that personalize research
across sessions.  ONE tool with two actions -- ``search`` (the
pre-sent snapshot) and ``save`` (yields a ``memory`` wire event the
CLIENT persists into PGlite; the server stays stateless).

The read path needs no tool at small scale: the run pre-sends every
stored fact and the researcher prompt injects them directly -- the tool
exists for the SAVE path and for explicit search once the list grows.
The scenario is ours, not LobeHub's: one flat layer of self-contained
facts (location, standing preferences, durable context), no taxonomy."""

import json
import typing as t

from searx.zjsearch.ai.core.text import query_terms

USER_MEMORY_TOOL = "user_memory"

MAX_MEMORIES = 50
"""The pre-send cap -- facts beyond this are the oldest's problem (the
preferences surface prunes; the model is told to update, not append)."""
MAX_CONTENT = 300


def user_memory_spec() -> dict[str, t.Any]:
    """The ``user_memory`` tool spec."""
    return {
        "name": USER_MEMORY_TOOL,
        "description": (
            "Remember durable facts about the user across sessions"
            " (action=save) or look up what is already stored"
            " (action=search).  Save ONLY lasting facts -- the user's"
            " city, occupation, standing preferences (answer style,"
            ' source preferences) -- e.g. {"action": "save", "content":'
            ' "用户常住杭州"} -- NEVER one-off conversation details.  The'
            " facts the user already has stored are listed in the"
            " <user_memory> context block: search is for checking before"
            " a save that might duplicate, not for re-reading what you"
            " can already see."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["search", "save"],
                    "description": "search = look up stored facts; save = store one new fact.",
                },
                "query": {
                    "type": "string",
                    "description": "search: keywords for the facts you are looking for.",
                },
                "content": {
                    "type": "string",
                    "description": (
                        "save: ONE self-contained fact in the user's language"
                        ' (e.g. "用户常住杭州, 关注本地房产政策").'
                    ),
                },
            },
            "required": ["action"],
        },
    }


def parse_memories(raw: t.Any) -> list[dict[str, str]]:
    """The run payload's ``user_memories`` -- sanitized (content capped,
    ids kept for the model's reference)."""
    out: list[dict[str, str]] = []
    if isinstance(raw, list):
        for item in raw[:MAX_MEMORIES]:
            if isinstance(item, dict) and item.get("content"):
                out.append(
                    {
                        "id": str(item.get("id") or "")[:40],
                        "content": str(item["content"])[:MAX_CONTENT],
                    }
                )
    return out


def search_memories(query: str, memories: list[dict[str, str]]) -> str:
    """Keyword-score the snapshot (content matching); small lists answer
    with everything (the model can skim)."""
    if not memories:
        return "(no facts are stored about the user yet)"
    terms = query_terms(query)
    if not terms:
        return "\n".join(f"- {memory['content']}" for memory in memories)
    scored = []
    for memory in memories:
        content = memory["content"].lower()
        score = sum(1 for term in terms if term in content)
        if score > 0:
            scored.append((score, memory))
    scored.sort(key=lambda pair: -pair[0])
    if not scored:
        return "(no stored fact matches -- the full list follows)\n" + "\n".join(
            f"- {memory['content']}" for memory in memories
        )
    return "\n".join(f"- {memory['content']}" for _, memory in scored[:10])


def extract_insights(
    cfg: dict[str, t.Any], question: str, answer: str, usage_out: list[dict[str, t.Any]] | None = None
) -> tuple[list[str], list[str]]:
    """The post-run extractor (LobeHub's downstream-extractor pattern):
    one small JSON completion decides whether the exchange revealed
    durable facts worth remembering AND which concept tags name its
    topics (the tag graph's semantic layer) -- INDEPENDENT of the
    researcher's tool discipline (small models skip the save call; this
    cannot be skipped).  Degrades to ([], []) on any failure."""
    if not question or not answer.strip():
        return [], []
    from searx.zjsearch.ai.llm import jsongate  # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.prompts import extractor  # pylint: disable=import-outside-toplevel

    value, usage = jsongate.json_completion(
        cfg,
        [
            {
                "role": "system",
                "content": extractor.USER_MEMORY_EXTRACT_SYSTEM,
            },
            {"role": "user", "content": f"<question>{question[:500]}</question>\n<answer>{answer[:3000]}</answer>"},
        ],
        "user_memory_extract",
        {
            "type": "object",
            "properties": {
                "facts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "0-3 durable facts, each self-contained, or an empty array.",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "2-8 concept tags naming the exchange's topics, or an empty array.",
                },
            },
            "required": ["facts", "tags"],
        },
    )
    if usage_out is not None and usage:
        usage_out.append(usage)
    value = value or {}
    facts = value.get("facts")
    tags = value.get("tags")
    clean_facts = (
        [str(fact).strip()[:MAX_CONTENT] for fact in facts if str(fact).strip()][:3] if isinstance(facts, list) else []
    )
    clean_tags = [str(tag).strip()[:40] for tag in tags if str(tag).strip()] if isinstance(tags, list) else []
    return clean_facts, clean_tags[:8]


def evaluate_call(call: dict[str, t.Any], memories: list[dict[str, str]]) -> tuple[str, dict[str, t.Any] | None]:
    """One tool call -> (model feed, wire event).  ``save`` ALSO yields a
    ``memory`` wire event -- the client persists the fact into its local
    PGlite; the server keeps nothing."""
    try:
        args = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    action = str(args.get("action") or "search")
    if action == "save":
        content = str(args.get("content") or "").strip()[:MAX_CONTENT]
        if not content:
            return "error: save needs a non-empty content", None
        return (
            f'saved: "{content}" (the fact persists across sessions)',
            {"content": content},
        )
    return search_memories(str(args.get("query") or ""), memories), None
