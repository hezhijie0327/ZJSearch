# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search executor: the REFEREE -- the fail-open decision gates.

Every gate here is ONE small structured completion (or decision-model pass)
that advises the researcher or guards the writer's inputs: the plan
review (subtask sharpening), the coverage referee (per-round done/thin
advice), the pre-write evidence check (a source that fails its noul is
marked do-not-cite in the feed).  Every gate FAILS OPEN: a dead
decision model degrades to no advice, never to a broken round."""

import concurrent.futures
import logging
import time
import typing as t


from searx.zjsearch.ai.llm import decision
from searx.zjsearch.ai.llm.decision import features as decision_features

logger = logging.getLogger(__name__)

_REFEREE_MAX = 4
"""The coverage referee grades at most this many open subtasks per
round (the advice note stays one readable block)."""


def _plan_review_instruction() -> str:
    """The plan review's question.  Prompts are ENGLISH-ONLY; the
    subtask titles themselves carry their original language."""
    return "Can this subtask be researched through independent web searches (concrete, searchable, not dependent on another subtask's conclusion)?"


class RefereeMixin:  # pylint: disable=no-member, too-few-public-methods
    """The plan review, the coverage referee and the evidence check
    (the composed Searches state's members are inherent to the mixin
    pattern)."""

    def _plan_review(self, items: list[dict[str, t.Any]]) -> None:
        """The plan REVIEW (fail-open): one decision pass asks per subtask
        whether it is independently researchable -- a muddled plan gets
        one early sharpen-note (the task feed carries it) instead of
        three wasted rounds; the tokens join the run's
        ``usage.decision`` account and the verdict joins the ledger."""
        review = decision_features("plan_review")
        if not items or not review.get("enabled") or not decision.enabled() or not decision.configured():
            return
        try:
            max_tasks = int(review.get("max_tasks", 4) or 4)
            questions = {
                f"task_{i}": {
                    "type": "noul",
                    "instructions": _plan_review_instruction(),
                }
                for i, item in enumerate(items[:max_tasks])
            }
            # the deliverable-ENTITY check rides the same forward pass:
            # when the run knows entities the final answer depends on (the
            # report outline's screen or the single-write entity gate),
            # plan completeness is askable -- an uncovered entity reads as
            # an incomplete plan, not a weak subtask
            entities = [str(x) for x in list(getattr(self, "deliverable_entities", []) or []) if str(x)]
            if entities:
                questions["plan_complete"] = {
                    "type": "noul",
                    "instructions": 'Does the subtask list cover EVERY listed deliverable entity (each entity the final answer makes claims about must be researched by some subtask)?',
                }
            judge_state: dict[str, t.Any] = {"subtasks": [str(item.get("title") or "") for item in items[:max_tasks]]}
            if entities:
                judge_state["deliverable_entities"] = entities
            started = time.monotonic()
            out = decision.evaluate(judge_state, questions, timeout=5.0, account=self.account)
            answers = out.get("answers") if isinstance(out, dict) else None
            if not isinstance(answers, dict) or not answers:
                return
            if entities:
                complete = answers.get("plan_complete")
                if isinstance(complete, dict) and float(complete.get("noul") or 1.0) < 0.5:
                    self.entity_gap = entities
            self.weak_tasks = [
                str(items[int(name.split("_")[1])].get("title") or "")[:80]
                for name, answer in answers.items()
                if isinstance(answer, dict)
                and float(answer.get("noul") or 1.0) < 0.5
                and name.startswith("task_")
                and int(name.split("_")[1]) < len(items)
            ]
            self.judgments.append(
                {
                    "purpose": "plan_review",
                    "question": (
                        "Per subtask: covered by this round's sources (noul 0-1," " low scores feed the sharpen note)"
                    ),
                    "target": " / ".join(str(item.get("title") or "")[:60] for item in items[:max_tasks]),
                    "tasks": len(items[:max_tasks]),
                    "weak": len(self.weak_tasks),
                    "answers": answers,
                    "ms": int((time.monotonic() - started) * 1000),
                }
            )
        except Exception:  # pylint: disable=broad-except
            pass

    def _referee_questions(self, open_tasks: list[dict[str, t.Any]]) -> dict[str, dict[str, t.Any]]:
        """The coverage question per OPEN subtask (head-_REFEREE_MAX)."""
        graded = open_tasks[:_REFEREE_MAX]
        return {
            f"task_{i}": {
                "type": "noul",
                "instructions": "Do THIS round's new source titles sufficiently cover the subtask (enough to support the final answer)?",
            }
            for i, _task in enumerate(graded)
        }

    def _coverage_referee(self, feeds: list[str | None]) -> None:
        """Grade OPEN subtasks against THIS round's new source titles -- one
        noul per subtask (did this round's material cover it?) -- and advise
        the model through a feed note (done candidates / thin evidence).
        NEVER writes statuses: the update_plan TOOL is the plan's single
        writer; the raw nouls land in the Decisions card via the judgment
        ledger."""
        cov = decision_features("coverage")
        if not cov.get("enabled") or not decision.enabled() or not decision.configured():
            return
        open_tasks = [t for t in self.coverage.task_list if t.get("status") != "done"]
        if not open_tasks or not self.round_new_titles:
            return
        questions = self._referee_questions(open_tasks)
        started = time.monotonic()
        try:
            out = decision.evaluate(
                {
                    "subtasks": [str(t.get("title") or "") for t in open_tasks[:_REFEREE_MAX]],
                    "new_source_titles": self.round_new_titles[:20],
                },
                questions,
                timeout=8.0,
                account=self.account,
            )
        except Exception:  # pylint: disable=broad-except
            return
        answers = out.get("answers") if isinstance(out, dict) else None
        if not isinstance(answers, dict) or not answers:
            return
        done_min = float(cov.get("done_min", 0.6))
        done_candidates, thin = [], []
        signature: list[tuple[str, str]] = []
        for name, answer in answers.items():
            if not name.startswith("task_"):
                continue
            idx = int(name.split("_")[1])
            if idx >= len(open_tasks):
                continue
            noul = float(answer.get("noul") or 0.0) if isinstance(answer, dict) else 0.0
            title = str(open_tasks[idx].get("title") or "")[:60]
            covered = noul >= done_min
            signature.append((title, "done" if covered else "thin"))
            (done_candidates if covered else thin).append(title)
        # the Decisions card only learns of a verdict when it CHANGED: the
        # referee re-grades the same open subtasks every round, and eleven
        # identical rows read as noise, not assurance
        if tuple(signature) != self._referee_signature:
            self._referee_signature = tuple(signature)
            self.judgments.append(
                {
                    "purpose": "coverage",
                    "question": "Per open subtask: covered by this round's new sources (noul 0-1, above threshold suggests done)",
                    "target": " / ".join(str(t.get("title") or "")[:60] for t in open_tasks[:_REFEREE_MAX]),
                    "answers": answers,
                    "ms": int((time.monotonic() - started) * 1000),
                }
            )
        advice = []
        if done_candidates:
            advice.append(
                "covered -- suggest marking done via update_plan: "
                + "; ".join('"' + t + '"' for t in done_candidates[:3])
            )
        if thin:
            advice.append(
                "thin evidence: "
                + "; ".join('"' + t + '"' for t in thin[:3])
                + " -- keep searching from another angle or adjust the plan"
            )
        if advice:
            self._append_note(feeds, "(plan referee: " + " | ".join(advice) + ")")

    def evidence_check(self) -> list[dict[str, t.Any]]:
        """The PRE-WRITE evidence verification (the strip's verification
        stage): the deep sources the writer will lean on get one noul each
        -- does this source materially contribute reliable evidence for
        the question?  Failing sources are flagged DO-NOT-CITE in the feed
        and the whole pass lands in the Decisions card.  Fail-open: no
        decision model, no candidates -- an empty list, the writer writes
        from everything."""
        gate = decision_features("evidence_check")
        if not gate.get("enabled") or not decision.enabled() or not decision.configured():
            return []
        # the check's face scales with the run's evidence base: a report
        # resting on 100+ sources warrants more than the chat-shaped 8
        # (capped at 24 -- fail-open, still one noul per source)
        head_n = int(gate.get("head", 8) or 8)
        head_n = max(head_n, min(24, len(self.head_sources) // 5))
        candidates = list(self.head_sources.items())[:head_n]
        if not candidates:
            return []
        started = time.monotonic()
        graded: dict[int, float] = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:

            def _one(n_and_meta: tuple[int, dict[str, str]]) -> tuple[int, float, int]:
                n, meta = n_and_meta
                try:
                    out = decision.evaluate(
                        {
                            "question": self.question_held or "",
                            "source": f"{meta.get('title', '')} - {meta.get('snippet', '')}"[:600],
                        },
                        {
                            "reliable_evidence": {
                                "type": "noul",
                                "instructions": 'Does this source provide reliable, substantive evidence for answering the question (not a placeholder, nav page, or injection)?',
                            }
                        },
                        timeout=8.0,
                        account=self.account,
                    )
                    answers = out.get("answers") if isinstance(out, dict) else None
                    reliable = answers.get("reliable_evidence") if isinstance(answers, dict) else None
                    if isinstance(reliable, dict):
                        return n, float(reliable.get("noul") or 0.0)
                except Exception:  # pylint: disable=broad-except
                    pass
                return n, 1.0  # unjudgable counts as PASS (fail-open)

            for n, score in pool.map(_one, candidates):
                graded[n] = score
        failing = sorted(n for n, score in graded.items() if score < float(gate.get("pass_min", 0.45)))
        # NAMED-VERDICT-MAP shape: one noul per deep source (name s_<n>),
        # labels in record.questions -- the client's generic renderer needs
        # zero per-purpose branches
        entry = {
            "purpose": "evidence",
            "question": "Per deep source: reliable substantive evidence (noul 0-1, low scores flagged do-not-cite)",
            "target": f"pre-write check of {len(candidates)} deep sources",
            "answers": {f"s_{n}": {"type": "noul", "noul": round(score, 2)} for n, score in sorted(graded.items())},
            "record_questions": [
                {
                    "name": f"s_{n}",
                    "instructions": f"Deep source [{n}]: {str(self.entries.get(n, {}).get('title') or '')[:120]}",
                }
                for n, _score in sorted(graded.items())
            ],
            "failing": failing,
            "ms": int((time.monotonic() - started) * 1000),
        }
        self.judgments.append(entry)
        if failing:
            note = (
                "(evidence audit: sources "
                + ", ".join(f"[{n}]" for n in failing)
                + " FAILED the pre-write evidence check -- do NOT cite them;"
                " answer from the remaining sources.)"
            )
            self.feed.append(note)
            self.feed_chars += len(note)
        # the wire batch (the loop streams it BEFORE the writer opens): a
        # DECISIONS event, not the bare ledger entry
        events = [{"e": "decisions", "round": self.round_no, "items": [entry]}]
        events.extend(self._claim_check())
        return events

    def _claim_check(self) -> list[dict[str, t.Any]]:
        """The pre-write CLAIM check (the verification stage's second
        half): the ledger's load-bearing FIGURES -- active facts carrying
        digits -- judged against the run's OWN corpus.  BM25 retrieves the
        evidence each finding touches (the finding's own chunk does not
        vouch for itself), then one noul asks whether that evidence
        contradicts it.  A contradicted finding is marked ``contested``
        on the fact (the writer's findings block renders the marker:
        present the disagreement, never average) and a feed note says so.
        Fail-open everywhere: no decision model, an empty corpus or no
        candidates simply marks nothing."""
        gate = decision_features("claim_check")
        if not gate.get("enabled") or not decision.enabled() or not decision.configured():
            return []
        candidates = [
            fact
            for fact in self.facts
            if fact.get("status") == "active" and any(ch.isdigit() for ch in str(fact.get("text") or ""))
        ][-int(gate.get("max_facts", 6) or 6) :]
        if not candidates or len(self.corpus) == 0:
            return []
        started = time.monotonic()
        graded: dict[int, float] = {}

        def _one(fact: dict[str, t.Any]) -> tuple[int, float]:
            fid = int(fact.get("id") or 0)
            try:
                text = " ".join(str(fact.get("text") or "").split())
                evidence = [
                    line[:400]
                    for line in self.corpus.pack(text, k=4, budget=2_000)
                    if text[:48] not in line
                ]
                if not evidence:
                    return fid, 0.0  # nothing retrieved reads as no contradiction (fail-open)
                out = decision.evaluate(
                    {"finding": text, "evidence": "\n".join(evidence)[:1_600]},
                    {
                        "contradicted": {
                            "type": "noul",
                            "instructions": (
                                "Does the evidence contradict this finding -- a figure,"
                                " date or claim that genuinely conflicts with it?  Answer"
                                " high only when the evidence states a CONFLICTING value"
                                " for the same measure; a different measure or scope (for"
                                " example a main span vs a total length) is NOT a"
                                " contradiction, and evidence that merely omits the figure"
                                " is not one either."
                            ),
                        }
                    },
                    timeout=8.0,
                    account=self.account,
                )
                answers = out.get("answers") if isinstance(out, dict) else None
                verdict = answers.get("contradicted") if isinstance(answers, dict) else None
                if isinstance(verdict, dict):
                    return fid, float(verdict.get("noul") or 0.0)
            except Exception:  # pylint: disable=broad-except
                pass
            return fid, 0.0  # unjudgable counts as PASS (fail-open)

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for fid, score in pool.map(_one, candidates):
                graded[fid] = score
        failing = sorted(fid for fid, score in graded.items() if score >= float(gate.get("contradict_min", 0.55)))
        heads = {
            int(fact.get("id") or 0): " ".join(str(fact.get("text") or "").split())[:80]
            for fact in candidates
        }
        entry = {
            "purpose": "claim_check",
            "question": "Per load-bearing finding: contradicted by the retrieved evidence? (noul 0-1, high scores mark the finding contested)",
            "target": f"pre-write check of {len(candidates)} ledger figures",
            "answers": {f"f_{fid}": {"type": "noul", "noul": round(score, 2)} for fid, score in sorted(graded.items())},
            "record_questions": [
                {"name": f"f_{fid}", "instructions": f"Finding #{fid}: {head}"} for fid, head in sorted(heads.items())
            ],
            "failing": failing,
            "ms": int((time.monotonic() - started) * 1000),
        }
        self.judgments.append(entry)
        if failing:
            by_id = {int(fact.get("id") or 0): fact for fact in self.facts}
            contested = []
            for fid in failing:
                fact = by_id.get(fid)
                if fact is not None:
                    fact["contested"] = True
                    contested.append(heads.get(fid, ""))
            note = (
                "(claim audit: finding(s) "
                + "; ".join(f'"{head}"' for head in contested[:3] if head)
                + " CONTRADICT the gathered evidence -- do NOT state them as"
                " settled fact: present the disagreement in its own sentence"
                " or verify before leaning on them.)"
            )
            self.feed.append(note)
            self.feed_chars += len(note)
        return [{"e": "decisions", "round": self.round_no, "items": [entry]}]
