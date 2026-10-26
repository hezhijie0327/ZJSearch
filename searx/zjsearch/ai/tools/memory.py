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
(action=forget) when the user asks to drop something.  SITE SKILLS AND SOURCE NOTES: when you just completed a non-trivial
operation on a website in the browser session -- a sign-in flow, a
captcha, a multi-step path to walled content -- save the recipe
(kind=procedure, host=<the site's host>, content=<the minimal step
list>); it rides your next browse to that site.  A durable judgment
about a SOURCE (it lags the official data, it spins its numbers, it is
the fastest lawful route to X) is a source note: kind=fact with that
source's host -- it resurfaces whenever your searches or reads touch
the site.  LESSONS (kind=lesson): when a search only worked after you
rephrased it -- a wording, a site: operator, another category or
language -- save what worked; try saved lessons before brute-forcing.
GAPS (kind=gap): when the run ends with a question you could NOT
answer, save it as a gap -- the backlog; when a run RESOLVES a stored
gap, answer it and FORGET the memory.  Every memory is written in the
user's language -- match the language they are speaking to you in,
never your own default.  The answer must still answer the question;
memory maintenance is a silent side action."""

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
                    "enum": ["fact", "procedure", "lesson", "gap"],
                    "description": (
                        "save: fact = a durable fact (about the user, a"
                        " tracked entity/project, or with host = about one"
                        " website as a source); procedure = a learned way"
                        " (user preference, or with host = a site recipe);"
                        " lesson = a search lesson (the angle that only"
                        " worked after rephrasing); gap = an open question"
                        " this run could not answer (the backlog)."
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
                "host": {
                    "type": "string",
                    "description": (
                        "save: for SITE RECIPES only -- a learned operational"
                        " flow for one website (a login path, a captcha dance,"
                        " the route to walled content); pass that site's host"
                        " (e.g. xiaohongshu.com).  Omit for facts about the"
                        " user."
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
                        "kind": item.get("kind") if item.get("kind") in ("fact", "procedure", "lesson", "gap") else "fact",
                        "host": str(item.get("host") or "")[:120],
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
    site = f" [site {memory['host']}]" if memory.get("host") else ""
    return f"-{tag}{site} {memory['content']}"


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


def _save_funnel(
    content: str,
    kind: str,
    known: list[str],
    known_ids: list[str | None],
    cfg: dict[str, t.Any] | None,
    account: t.Any = None,
    state: str | None = None,
) -> tuple[str, dict[str, t.Any] | None]:
    """One candidate memory -> ``(feed, v2 event | None)``: the near-dup
    gate plus the gray-band judgment, shared by the tool's save and the
    extractor.  ``known``/``known_ids`` MUTATE to track the resolved
    outcome (a save joins the set with a None id -- the client mints
    ids; an update replaces the wording in place), so batch members
    dedup against each other through the same lists.  ``state`` rides
    the save event (``provisional`` for mined procedures)."""
    hit = _nearest(content, known, account=account)
    if hit is not None:
        index, cosine = hit
        existing = known[index]
        target_id = known_ids[index] if index < len(known_ids) else None
        if cosine >= _dup_gate()[2]:
            if target_id:
                return (
                    f'noted again: "{content}" reads as the stored memory "{existing}" -- its'
                    " weight grows instead.",
                    {"op": "reinforce", "kind": kind, "id": target_id, "content": existing},
                )
            return (f'duplicate: "{content}" was already noted -- do NOT re-save it.', None)
        verdict = _judge_relation(cfg or {}, existing, content, account=account) if cfg else "distinct"
        if verdict == "same":
            if target_id:
                return (
                    f'noted again: "{content}" rephrases the stored memory "{existing}" -- its'
                    " weight grows instead.",
                    {"op": "reinforce", "kind": kind, "id": target_id, "content": existing},
                )
            return (f'duplicate: "{content}" was already noted -- do NOT re-save it.', None)
        if verdict == "update" and target_id:
            known[index] = content
            return (
                f'updated: "{existing}" is superseded by "{content}" (the fact changed -- one'
                " version stays).",
                {"op": "update", "kind": kind, "id": target_id, "content": content, "old": existing},
            )
        # distinct -- or an update whose target has no id (this run's own
        # save): both fall through to a plain save
    known.append(content)
    known_ids.append(None)
    event: dict[str, t.Any] = {"op": "save", "kind": kind, "content": content}
    if state:
        event["state"] = state
    return (f'saved: "{content}" (it persists across sessions)', event)


def extract_insights(
    cfg: dict[str, t.Any],
    question: str,
    answer: str,
    known: list[str] | None = None,
    known_ids: list[str | None] | None = None,
    account: t.Any = None,
    clarifications: str = "",
    open_gaps: list[tuple[str, str]] | None = None,
) -> tuple[list[dict[str, t.Any]], list[str]]:
    """The post-run extractor -- the consolidation organ (LobeHub's
    downstream-extractor pattern): one small JSON completion decides
    what the exchange revealed, INDEPENDENT of the researcher's tool
    discipline (small models skip the save call; this cannot be
    skipped).  Reads the question, the CONFIRMED DIRECTION (the clarify
    answers -- the user's preferences surface there, never in the
    report) and the answer's head.

    Returns ``(events, tags)``: every extracted memory as a v2 wire
    event the client executes against its store -- facts save/reinforce/
    update through the same funnel the tool rides, procedures land
    ``provisional`` (the panel's confirm gate), a detected supersession
    updates the old row.  Degrades to ``([], [])`` on any failure."""
    if not question or not answer.strip():
        return [], []
    from searx.zjsearch.ai.llm import jsongate  # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.prompts import extractor, spine  # pylint: disable=import-outside-toplevel

    user_text = spine.block("question", question[:500])
    if clarifications.strip():
        user_text += "\n" + spine.block("clarified", clarifications.strip()[:500])
    user_text += "\n" + spine.block("answer", answer[:3000])
    gap_rows = [(gid, gtext) for gid, gtext in (open_gaps or []) if gid and gtext]
    if gap_rows:
        gap_lines = "\n".join(f"- [{gid}] {gtext}" for gid, gtext in gap_rows)
        user_text += "\n" + spine.block(
            "open_gaps",
            "The user's OPEN QUESTIONS (the backlog -- judge whether this"
            " exchange answered any):\n" + gap_lines,
        )
    value, _usage = jsongate.json_completion(
        cfg,
        [
            {
                "role": "system",
                "content": extractor.USER_MEMORY_EXTRACT_SYSTEM,
            },
            {"role": "user", "content": user_text},
        ],
        "user_memory_extract",
        {
            "type": "object",
            "properties": {
                "facts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "0-3 durable facts about the user, each self-contained, or an empty array.",
                },
                "procedures": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "0-2 learned PROCEDURES -- standing preferences about"
                        " how research or answers should be done for this"
                        " user, or an empty array."
                    ),
                },
                "forget_gaps": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "The ids of the OPEN QUESTIONS this exchange"
                        " genuinely answered, or an empty array."
                    ),
                },
                "superseded": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"old": {"type": "string"}, "new": {"type": "string"}},
                        "required": ["old", "new"],
                    },
                    "description": (
                        "0-3 detected CHANGES: the exchange shows a stored-style"
                        " fact no longer holds -- old names the previous fact,"
                        " new states the current one, or an empty array."
                    ),
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "2-8 concept tags naming the exchange's topics, or an empty array.",
                },
            },
            "required": ["facts", "procedures", "superseded", "forget_gaps", "tags"],
        },
        account=account,
    )
    value = value or {}
    clean_facts = _clean_list(value.get("facts"), 3)
    clean_procedures = _clean_list(value.get("procedures"), 2)
    clean_tags = [str(tag).strip()[:40] for tag in value.get("tags") or [] if str(tag).strip()] if isinstance(value.get("tags"), list) else []
    forget_raw = value.get("forget_gaps")
    clean_forget = (
        [str(token).strip()[:80] for token in forget_raw if str(token).strip()][:4]
        if isinstance(forget_raw, list)
        else []
    )
    known = list(known) if known is not None else []
    known_ids = list(known_ids) if known_ids is not None else []
    events: list[dict[str, t.Any]] = []
    for fact in clean_facts:
        _feed, event = _save_funnel(fact, "fact", known, known_ids, cfg, account)
        if event:
            events.append(event)
    for procedure in clean_procedures:
        _feed, event = _save_funnel(procedure, "procedure", known, known_ids, cfg, account, state="provisional")
        if event:
            events.append(event)
    superseded = value.get("superseded")
    for pair in (superseded if isinstance(superseded, list) else [])[:3]:
        if not isinstance(pair, dict):
            continue
        new = str(pair.get("new") or "").strip()[:MAX_CONTENT]
        old = str(pair.get("old") or "").strip()[:MAX_CONTENT]
        if not new:
            continue
        hit = _nearest(old, known, account=account) if old and known else None
        if hit is not None:
            index, cosine = hit
            existing = known[index]
            target_id = known_ids[index] if index < len(known_ids) else None
            if cosine >= _dup_gate()[1] and target_id:
                known[index] = new
                events.append(
                    {"op": "update", "kind": "fact", "id": target_id, "content": new, "old": existing}
                )
                continue
        events.append({"op": "save", "kind": "fact", "content": new})
    # the backlog's eraser: a genuinely answered open question leaves it
    # (the small model names the id -- the resolver tolerates a content
    # match too, and dedups against the already-forgotten)
    forgotten: set[str] = set()
    for token in clean_forget:
        token_l = token.lower()
        for gid, gtext in gap_rows:
            if gid in forgotten:
                continue
            if token_l == gid.lower() or token_l in gtext.lower() or gtext.lower() in token_l:
                forgotten.add(gid)
                events.append({"op": "forget", "kind": "gap", "id": gid, "content": gtext})
                break
    return events, clean_tags[:8]


def _clean_list(raw: t.Any, cap: int) -> list[str]:
    """A schema string-array trimmed to self-contained, capped strings."""
    return (
        [str(item).strip()[:MAX_CONTENT] for item in raw if str(item).strip()][:cap] if isinstance(raw, list) else []
    )


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
        host = str(args.get("host") or "").strip()[:120] or None
        kind = str(args.get("kind") or "")
        if kind not in ("fact", "procedure", "lesson", "gap"):
            kind = "procedure" if host else "fact"
        local_known = list(known or [])
        local_ids = list(known_ids) if known_ids is not None else [None] * len(local_known)
        feed, event = _save_funnel(content, kind, local_known, local_ids, cfg, account)
        if event and event.get("op") == "save" and host:
            event["host"] = host
        return feed, event

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
