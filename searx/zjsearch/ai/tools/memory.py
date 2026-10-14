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

import logging
import typing as t

from searx.zjsearch.ai.core.text import query_terms, raw_args
from searx.zjsearch.ai.llm import decision as decision_service
from searx.zjsearch.ai.llm import embed as embed_service

logger = logging.getLogger(__name__)

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


def _dup_gate() -> tuple[bool, float]:
    """The near-dup gate's config: ``(active, cosine)`` -- off when the
    feature is disabled or the embedding service is unavailable (a save
    then always passes; fail-open like every funnel gate)."""
    gate = decision_service.features("memory_dedup")
    if not gate.get("enabled") or not embed_service.enabled() or not embed_service.configured():
        return False, 0.0
    return True, float(gate.get("cosine", 0.92))


def _nearest(content: str, known: list[str]) -> int | None:
    """The stored fact this new one duplicates (its index) -- embedding
    nearest-neighbour above the gate's cosine floor.  ``None`` on any
    skip/failure: the save passes (the gate is a lens, not a dependency)."""
    active, threshold = _dup_gate()
    if not active or not known:
        return None
    try:
        batch = embed_service.run_batch([content] + list(known), timeout=8.0)
        if not batch or len(batch[0]) != len(known) + 1:
            return None
        probe = batch[0][0]
        for index, vector in enumerate(batch[0][1:]):
            if embed_service.cosine(probe, vector) >= threshold:
                return index
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch_memory: near-dup scan failed: %s", exc)
    return None


def _filter_near_dups(facts: list[str], known: list[str]) -> list[str]:
    """The extractor's facts minus the near-duplicates -- against the
    stored facts AND each other (the extractor's small model loves
    rephrasing one fact three ways).  ONE batch embed; anything it cannot
    judge passes (fail-open)."""
    active, threshold = _dup_gate()
    if not active or (len(facts) < 2 and not known):
        return facts
    try:
        batch = embed_service.run_batch(list(facts) + list(known), timeout=8.0)
        if not batch or len(batch[0]) != len(facts) + len(known):
            return facts
        vectors = batch[0]
        known_vectors = vectors[len(facts) :]
        kept: list[str] = []
        kept_vectors: list[list[float]] = []
        for index, fact in enumerate(facts):
            vector = vectors[index]
            clash = any(embed_service.cosine(vector, other) >= threshold for other in known_vectors)
            clash = clash or any(embed_service.cosine(vector, other) >= threshold for other in kept_vectors)
            if not clash:
                kept.append(fact)
                kept_vectors.append(vector)
        return kept
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch_memory: dup filter failed: %s", exc)
        return facts


def extract_insights(
    cfg: dict[str, t.Any],
    question: str,
    answer: str,
    usage_out: list[dict[str, t.Any]] | None = None,
    known: list[str] | None = None,
) -> tuple[list[str], list[str]]:
    """The post-run extractor (LobeHub's downstream-extractor pattern):
    one small JSON completion decides whether the exchange revealed
    durable facts worth remembering AND which concept tags name its
    topics (the tag graph's semantic layer) -- INDEPENDENT of the
    researcher's tool discipline (small models skip the save call; this
    cannot be skipped).  ``known`` (the stored facts + this run's accepted
    saves) is the near-dup gate's comparison set: a fact that rephrases
    what is already stored never reaches the client.  Degrades to ([], [])
    on any failure."""
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
    if clean_facts and known is not None:
        clean_facts = _filter_near_dups(clean_facts, list(known))
    return clean_facts, clean_tags[:8]


def evaluate_call(
    call: dict[str, t.Any], memories: list[dict[str, str]], known: list[str] | None = None
) -> tuple[str, dict[str, t.Any] | None]:
    """One tool call -> (model feed, wire event).  ``save`` ALSO yields a
    ``memory`` wire event -- the client persists the fact into its local
    PGlite; the server keeps nothing.  ``known`` (the stored facts + this
    run's accepted saves) is the near-dup gate: a save that rephrases a
    stored fact settles as ``duplicate`` -- the model is told to update
    wording, not re-save."""
    args = raw_args(call)
    action = str(args.get("action") or "search")
    if action == "save":
        content = str(args.get("content") or "").strip()[:MAX_CONTENT]
        if not content:
            return "error: save needs a non-empty content", None
        if known and _nearest(content, known) is not None:
            feed = (
                f'duplicate: "{content}" already reads as a stored fact -- do NOT re-save it;'
                " if the stored wording is wrong, save a corrected, self-contained version."
            )
            return feed, None
        return (
            f'saved: "{content}" (the fact persists across sessions)',
            {"content": content},
        )
    return search_memories(str(args.get("query") or ""), memories), None
