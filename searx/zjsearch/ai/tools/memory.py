# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``memory`` tool: one self-contained package -- the model-facing
spec, the search/save evaluator it backs, and the post-run extractor's
executor (its prompt text lives in :py:mod:`prompts.extractor`).  The
tripartite refactor's semantic + procedural layers: durable facts about
the user AND learned procedures (how they want research done), stored
client-side; the server stays stateless.

ONE tool with FOUR actions -- full CRUD, because a memory that only
grows stops being a memory:

- ``search``: the read path when no snapshot was injected.
- ``save``: one new fact/procedure.  The near-dup gate runs FIRST:
  embeddings narrow the candidate, a small judgment model decides
  same/update/distinct -- a moved city UPDATES the stored fact instead
  of piling a second version beside it.
- ``update``: correct an existing memory (by id or by a few of its
  words).
- ``forget``: drop one (the user asked).

Each mutation yields a v2 ``memory`` wire event (``op`` +
``kind``/``id``/``content``/``old``) the CLIENT executes against its
store; the server keeps nothing."""

import logging
import typing as t

from searx.zjsearch.ai.core.text import query_terms, raw_args
from searx.zjsearch.ai.llm import decision as decision_service
from searx.zjsearch.ai.llm import embed as embed_service

logger = logging.getLogger(__name__)

MEMORY_TOOL = "memory"

INSTRUCTIONS = """\
The user's durable memory lives here -- facts (home city, occupation,
standing preferences) and learned procedures (how they want research
done), stored across sessions and injected each run.  When the run
injects the stored list, search (action=search) is for checking before
a save that might duplicate; when nothing is injected, search IS the
read path -- consult it before planning when a standing fact could
shape the research.  Maintain it like a memory, not a log: save
lasting facts and procedures, never one-off conversation details;
UPDATE (action=update) when a stored fact CHANGED -- a moved city, a
changed preference -- instead of saving a second version; FORGET
(action=forget) when the user asks to drop something.  The answer
must still answer the question; memory maintenance is a silent side
action."""

MAX_MEMORIES = 50
"""The pre-send cap -- facts beyond this are the oldest's problem (the
preferences surface prunes; the model is told to update, not append)."""
MAX_CONTENT = 300


def memory_spec() -> dict[str, t.Any]:
    """The ``memory`` tool spec."""
    return {
        "name": MEMORY_TOOL,
        "description": (
            "The user's durable memory across sessions (facts + learned"
            " procedures).  actions: search = look up what is stored;"
            " save = store ONE new memory; update = correct an existing"
            " one; forget = remove one."
        ),
        "annotations": {"readOnlyHint": False, "destructiveHint": False},
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["search", "save", "update", "forget"],
                    "description": (
                        "search = look up stored memories; save = store one"
                        " new memory; update = replace an existing memory's"
                        " wording; forget = remove one."
                    ),
                },
                "query": {
                    "type": "string",
                    "description": "search: keywords for the memories you are looking for.",
                },
                "kind": {
                    "type": "string",
                    "enum": ["fact", "procedure"],
                    "description": (
                        "save: fact = a durable fact about the user; procedure"
                        " = a learned way to research or write for them"
                        " (a standing preference about method or output)."
                    ),
                },
                "content": {
                    "type": "string",
                    "description": (
                        "save: ONE self-contained memory in the user's language"
                        " (e.g. \"User lives in Shanghai, follows the local"
                        " housing policy\").  update: the corrected wording."
                    ),
                },
                "target": {
                    "type": "string",
                    "description": (
                        "update/forget: the existing memory to touch -- its id"
                        " from a search, or a distinctive few of its words."
                    ),
                },
            },
            "required": ["action"],
        },
    }


def parse_memories(raw: t.Any) -> list[dict[str, str]]:
    """The run payload's ``user_memories`` -- sanitized (content capped,
    ids + kinds kept for the model's reference)."""
    out: list[dict[str, str]] = []
    if isinstance(raw, list):
        for item in raw[:MAX_MEMORIES]:
            if isinstance(item, dict) and item.get("content"):
                out.append(
                    {
                        "id": str(item.get("id") or "")[:40],
                        "content": str(item["content"])[:MAX_CONTENT],
                        "kind": "procedure" if item.get("kind") == "procedure" else "fact",
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
        return _snapshot_text(memories)
    scored = []
    for memory in memories:
        content = memory["content"].lower()
        score = sum(1 for term in terms if term in content)
        if score > 0:
            scored.append((score, memory))
    scored.sort(key=lambda pair: -pair[0])
    if not scored:
        return "(no stored memory matches -- the full list follows)\n" + _snapshot_text(memories)
    return "\n".join(_memory_line(memory) for _, memory in scored[:10])


def _memory_line(memory: dict[str, str]) -> str:
    tag = " [procedure]" if memory.get("kind") == "procedure" else ""
    return f"-{tag} {memory['content']}"


def _snapshot_text(memories: list[dict[str, str]]) -> str:
    return "\n".join(_memory_line(memory) for memory in memories)


def _resolve_target(target: str, memories: list[dict[str, str]]) -> dict[str, str] | None:
    """An update/forget's ``target`` -> the snapshot row: the exact id
    wins, then keyword scoring over the contents."""
    needle = str(target or "").strip()
    if not needle:
        return None
    for memory in memories:
        if memory.get("id") and memory["id"] == needle:
            return memory
    terms = query_terms(needle)
    best: tuple[int, dict[str, str]] | None = None
    for memory in memories:
        content = memory["content"].lower()
        score = sum(1 for term in terms if term in content)
        if score > 0 and (best is None or score > best[0]):
            best = (score, memory)
    return best[1] if best else None


def _dup_gate() -> tuple[bool, float, float]:
    """The near-dup gate's config: ``(active, gray_floor, same_floor)`` --
    off when the feature is disabled or the embedding service is
    unavailable (a save then always passes; fail-open like every funnel
    gate).  At or above ``same_floor`` the candidate IS the stored fact
    (reinforce, no judgment); between the floors lies the GRAY BAND
    where the judgment model decides."""
    gate = decision_service.features("memory_dedup")
    if not gate.get("enabled") or not embed_service.enabled() or not embed_service.configured():
        return False, 0.0, 0.0
    return True, float(gate.get("cosine", 0.92)), float(gate.get("same", 0.98))


def _nearest(content: str, known: list[str], account: t.Any = None) -> tuple[int, float] | None:
    """The stored memory the candidate most resembles (its index +
    cosine) -- embedding nearest-neighbour at or above the gray floor.
    ``None`` on any skip/failure: the save passes (the gate is a lens,
    not a dependency)."""
    active, gray, _same = _dup_gate()
    if not active or not known:
        return None
    try:
        batch = embed_service.run_batch([content] + list(known), timeout=8.0, account=account)
        if not batch or len(batch[0]) != len(known) + 1:
            return None
        probe = batch[0][0]
        best: tuple[int, float] | None = None
        for index, vector in enumerate(batch[0][1:]):
            cosine = embed_service.cosine(probe, vector)
            if cosine >= gray and (best is None or cosine > best[1]):
                best = (index, cosine)
        return best
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch_memory: near-dup scan failed: %s", exc)
    return None


def _judge_relation(cfg: dict[str, t.Any], existing: str, candidate: str, account: t.Any = None) -> str:
    """The gray band's verdict -- ``same`` (a rephrase), ``update`` (the
    fact changed) or ``distinct`` (a different fact).  ONE small
    structured completion on the run's own transport; any failure
    answers ``distinct`` (a duplicate is the lesser evil -- a lost
    update never comes back)."""
    from searx.zjsearch.ai.llm import jsongate  # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.prompts import extractor, spine  # pylint: disable=import-outside-toplevel

    try:
        value, _usage = jsongate.json_completion(
            cfg,
            [
                {"role": "system", "content": extractor.MEMORY_JUDGE_SYSTEM},
                {
                    "role": "user",
                    "content": spine.block("existing", existing[:300]) + "\n" + spine.block("candidate", candidate[:300]),
                },
            ],
            "memory_relation_judge",
            {
                "type": "object",
                "properties": {"verdict": {"type": "string", "enum": ["same", "update", "distinct"]}},
                "required": ["verdict"],
            },
            account=account,
        )
        verdict = str((value or {}).get("verdict") or "")
        return verdict if verdict in ("same", "update", "distinct") else "distinct"
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch_memory: relation judge failed: %s", exc)
        return "distinct"


def extract_insights(
    cfg: dict[str, t.Any],
    question: str,
    answer: str,
    known: list[str] | None = None,
    account: t.Any = None,
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
    from searx.zjsearch.ai.prompts import extractor, spine  # pylint: disable=import-outside-toplevel

    value, _usage = jsongate.json_completion(
        cfg,
        [
            {
                "role": "system",
                "content": extractor.USER_MEMORY_EXTRACT_SYSTEM,
            },
            {"role": "user", "content": spine.block("question", question[:500]) + "\n" + spine.block("answer", answer[:3000])},
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
        account=account,
    )
    value = value or {}
    facts = value.get("facts")
    tags = value.get("tags")
    clean_facts = (
        [str(fact).strip()[:MAX_CONTENT] for fact in facts if str(fact).strip()][:3] if isinstance(facts, list) else []
    )
    clean_tags = [str(tag).strip()[:40] for tag in tags if str(tag).strip()] if isinstance(tags, list) else []
    if clean_facts and known is not None:
        clean_facts = _filter_near_dups(clean_facts, list(known), account=account)
    return clean_facts, clean_tags[:8]


def _filter_near_dups(facts: list[str], known: list[str], account: t.Any = None) -> list[str]:
    """The extractor's facts minus the near-duplicates -- against the
    stored facts AND each other (the extractor's small model loves
    rephrasing one fact three ways).  ONE batch embed; anything it cannot
    evaluate passes (fail-open)."""
    active, threshold, _same = _dup_gate()
    if not active or (len(facts) < 2 and not known):
        return facts
    try:
        batch = embed_service.run_batch(list(facts) + list(known), timeout=8.0, account=account)
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


def run_call(
    call: dict[str, t.Any],
    memories: list[dict[str, str]],
    known: list[str] | None = None,
    known_ids: list[str | None] | None = None,
    account: t.Any = None,
    cfg: dict[str, t.Any] | None = None,
) -> tuple[str, dict[str, t.Any] | None]:
    """One tool call -> (model feed, v2 wire event).  The CLIENT executes
    the event against its store (op=save/update/reinforce/forget); the
    server keeps nothing.  ``known`` (snapshot contents + this run's
    accepted saves) is the near-dup gate's comparison set, ``known_ids``
    the aligned ids (None for this run's own saves -- the client mints
    ids at insert, the server never knows them)."""
    args = raw_args(call)
    action = str(args.get("action") or "search")

    if action == "save":
        content = str(args.get("content") or "").strip()[:MAX_CONTENT]
        if not content:
            return "error: save needs a non-empty content", None
        kind = "procedure" if args.get("kind") == "procedure" else "fact"
        hit = _nearest(content, known or [], account=account)
        if hit is not None:
            index, cosine = hit
            existing = known[index]
            same_floor = _dup_gate()[2]
            target_id = (known_ids or [None] * len(known))[index] if index < len(known_ids or []) else None
            if cosine >= same_floor:
                if target_id:
                    return (
                        f'noted again: "{content}" reads as the stored memory "{existing}" -- its'
                        " weight grows instead.",
                        {"op": "reinforce", "kind": kind, "id": target_id, "content": existing},
                    )
                return (
                    f'duplicate: "{content}" was already saved this run -- do NOT re-save it.',
                    None,
                )
            verdict = _judge_relation(cfg or {}, existing, content, account=account) if cfg else "distinct"
            if verdict == "same":
                if target_id:
                    return (
                        f'noted again: "{content}" rephrases the stored memory "{existing}" -- its'
                        " weight grows instead.",
                        {"op": "reinforce", "kind": kind, "id": target_id, "content": existing},
                    )
                return (f'duplicate: "{content}" was already saved this run -- do NOT re-save it.', None)
            if verdict == "update" and target_id:
                return (
                    f'updated: "{existing}" is superseded by "{content}" (the fact changed -- one'
                    " version stays).",
                    {"op": "update", "kind": kind, "id": target_id, "content": content, "old": existing},
                )
        return (
            f'saved: "{content}" (it persists across sessions)',
            {"op": "save", "kind": kind, "content": content},
        )

    if action in ("update", "forget"):
        target = _resolve_target(str(args.get("target") or ""), memories)
        if target is None:
            return (
                f"error: no stored memory matches {str(args.get('target') or '')!r} -- search first to"
                " learn what is stored.",
                None,
            )
        if action == "forget":
            return (
                f'forgot: "{target["content"]}" (it is removed from the memory).',
                {"op": "forget", "kind": target.get("kind", "fact"), "id": target.get("id"), "content": target["content"]},
            )
        content = str(args.get("content") or "").strip()[:MAX_CONTENT]
        if not content:
            return "error: update needs the corrected wording in content", None
        return (
            f'updated: "{target["content"]}" now reads "{content}".',
            {
                "op": "update",
                "kind": target.get("kind", "fact"),
                "id": target.get("id"),
                "content": content,
                "old": target["content"],
            },
        )

    return search_memories(str(args.get("query") or ""), memories), None
