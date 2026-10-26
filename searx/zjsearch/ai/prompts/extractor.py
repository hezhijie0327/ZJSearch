# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The post-run extractor prompts: the small json_completions that run
AFTER a settled answer -- durable-fact/tag extraction for the browser
knowledge base and concept-tag normalization.  Text lives here; the
executors (:py:mod:`tools.memory`, :py:mod:`api` (the route modules)) stay logic."""

USER_MEMORY_EXTRACT_SYSTEM = """\
Read this research exchange -- the question, the user's confirmed
direction (when present), the answer -- and return what it revealed.
facts: 0-3 DURABLE facts -- about the user (home city, occupation,
standing preferences, ongoing projects) AND about the entities or
projects the user is clearly tracking (a company's ownership, a
person's role, a product's standing -- the user researches these
repeatedly); only facts that stay true and useful
across future sessions; each self-contained, in the user's
language; no one-off details (today's weather is NOT a fact).
procedures: 0-2 learned PROCEDURES -- standing preferences about HOW
research or answers should be done for this user ("always wants
comparison tables", "prefers official primary sources"); only
directive-shaped, reusable preferences, each self-contained.
superseded: 0-3 detected CHANGES -- when the exchange shows a
stored-style fact no longer holds (a moved city, a switched tool),
"old" names the previous fact and "new" states the current one; only
genuine changes, not rephrases.
forget_gaps: the ids of the OPEN QUESTIONS (from the backlog list,
when one is provided) that this exchange genuinely ANSWERED -- a
resolved question leaves the backlog; only real answers, not partial
progress; or an empty array.
tags: 2-8 CONCEPT tags naming the exchange's topics -- short noun
phrases in the user's language (e.g. payment gateway fees, cross-border
settlement), no host names, no product versions, no verbatim query
echoes.
Respond with ONLY: {"facts": ["...", ...], "procedures": ["...", ...],
"superseded": [{"old": "...", "new": "..."}], "forget_gaps": ["..."],
"tags": ["...", ...]}
(empty arrays when nothing qualifies)."""

TAGS_NORMALIZE_SYSTEM = """\
You normalize knowledge-base tags.  Every item in the batch is one
document's RAW tag set (query tokens, host names, modes, rough
concepts).  For each item return 2-6 CONCEPT tags naming what the
document is ABOUT: short noun phrases, merge the languages the set
mixes (a Chinese document about Stripe fees gets Chinese tags), drop
host names, product versions, single generic words (compare, guide,
2026) and noise.  Do not invent topics the raw tags do not hint at.
Keep the item order.
Respond with ONLY a JSON object:
{"items": [{"tags": ["...", ...]}, ...]}"""

MEMORY_JUDGE_SYSTEM = """\
Two stored memories about the user are compared -- an EXISTING one and
a CANDIDATE the model wants to save.  Embeddings found them similar;
decide the relation.
verdict:
- "same": the candidate rephrases the existing memory -- no new
  information (wording differences only).
- "update": the candidate is the same KIND of fact but its CONTENT
  changed -- a moved city, a changed preference, a new role; the new
  wording should replace the old.
- "distinct": a different memory worth keeping on its own.
Respond with ONLY: {"verdict": "same" | "update" | "distinct"}"""
