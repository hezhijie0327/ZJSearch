# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The outline-driven write phase (the REPORT and DECK shapes): one
completion PER SECTION -- each over ITS packed context (the run
corpus retrieval for the section's key questions, the recorded table
artifacts, the outline and the neighbouring sections) -- so a 10k+
character document never hangs on one attention window.  A
section-level citation gate samples the section's [n] claims against
their sources BEFORE delivery: a failing claim earns one targeted
rewrite, never a post-hoc badge.  The executive summary is written
LAST (it needs the finished sections); the DECK shape (``deck=True``)
speaks the slide dialect instead, has no summary section and marks its
outline snapshots ``shape: "deck"``.

FAILURE SHAPE: a section stream that dies before its first byte gets
ONE automatic retry (a tail section's long upstream queue is the
ordinary failure, and it is transient); a still-dead section ships the
gap placeholder and its outline snapshot marks it ``failed`` -- the
document still delivers, and the run handle's rewrite lane
(:py:func:`make_synthesizer`'s ``handle`` registration, served by
``POST /zjsearch/ask/run/section``) re-streams that one section against
the run's own write materials after the settle.

All wire events flow through the agent loop's synthesizer hook; the
usage lands in the same tally as the research phase."""

import logging
import re
import time
import typing as t

from searx.zjsearch.ai.agent import wire
from searx.zjsearch.ai.llm import decision
from searx.zjsearch.ai.llm import embed as embed_service
from searx.zjsearch.ai.llm.decision import features as decision_features
from searx.zjsearch.ai.llm.streaming import LlmStream
from searx.zjsearch.ai.prompts import deck as deck_prompts
from searx.zjsearch.ai.prompts import report as report_prompts
from searx.zjsearch.ai.prompts import spine
from searx.zjsearch.ai.runs.search.corpus import PACK_BUDGET_DEFAULT

logger = logging.getLogger(__name__)

_IDLE_TIMEOUT = 150.0
_FIRST_TIMEOUT = 150.0
"""Section streams get a slightly wider budget than the single writer:
a section is shorter, but a report run's tail sections ride a long
upstream queue."""

_CLAIM_RE = re.compile(r"[^。\n!！?？]{30,260}?\[\d+(?:[,，]\s*\d+)*\]")
"""One cited claim: a sentence-bearing span ending in its [n] marks."""

_DECK_CLAIM_RE = re.compile(r"[^。\n!！?？]{12,300}?\[\d+(?:[,，]\s*\d+)*\]")
"""The deck variant: slides speak in bullets, not sentences -- the
minimum claim span drops accordingly (the gate stays a spot check)."""

_MAX_GATE_CLAIMS = 3
"""The citation gate samples at most this many claims per section (one
decision pass; the gate is a spot check, not an audit)."""


def _pump_section(
    cfg: dict[str, t.Any],
    messages: list[dict[str, t.Any]],
    section_id: str,
    tally: t.Any,
    reset: bool,
    produced: list[bool],
) -> t.Iterator[dict[str, t.Any]]:
    """One stream ATTEMPT: answer deltas as ``section`` events; the usage
    lands in the tally; a transport error or idle timeout ends the attempt
    (the caller owns the retry and the gap note).  ``produced`` is a
    one-element flag flipped on the first delta -- the caller's retry
    verdict.  ``reset`` marks the attempt's FIRST delta ``reset: true`` --
    the wire contract that this stream REPLACES whatever the client
    already buffers for the section id (the citation gate's rewrite, and
    every re-synthesis a CONTINUE replays into a run whose earlier
    attempt had already written the section)."""
    stream = LlmStream(cfg, messages, relay_reasoning=False)
    try:
        while True:
            wait = _FIRST_TIMEOUT if not produced[0] else _IDLE_TIMEOUT
            kind, payload = stream.next_event(wait)
            if kind == "delta":
                text = str(payload or "")
                if text:
                    first = not produced[0]
                    produced[0] = True
                    yield {
                        "e": "section",
                        "id": section_id,
                        "t": text,
                        **({"reset": True} if reset and first else {}),
                    }
            elif kind == "finish":
                tally.absorb(payload)
            elif kind == "error":
                logger.warning("zjsearch report: section %s stream failed: %s", section_id, payload)
                return
            else:
                return
    finally:
        stream.cancel()


def make_synthesizer(
    cfg: dict[str, t.Any],
    state: t.Any,
    outline: dict[str, t.Any],
    question: str,
    lang: str,
    deck: bool = False,
    handle: t.Any = None,
) -> t.Callable[[t.Any], t.Iterator[dict[str, t.Any]]]:
    """Bind the run's state and outline; returns the synthesizer the loop
    calls with the tally at write-phase time.  ``outline`` and ``deck``
    arrive BOUNDARY-RESOLVED -- the route's shape resolver consumed every
    pending control-channel pick (template re-mint, dialect flip, the
    direct withdrawal) before minting them, so this scope holds the
    run's final structure.  The citation gate's
    verdicts land in ``state.judgments`` (the Decisions card).
    ``handle`` is the run host's handle: when given, the write phase
    registers the SECTION REWRITE LANE on it (a
    settled run's failed section re-streams against this closure's own
    write materials -- outline, written map, corpus, artifacts all stay
    live for the handle's terminal TTL)."""
    lang_directive = spine.language_directive(lang)
    tz = getattr(state, "tz", None)
    today = spine.today_line(tz)
    # the section-gap placeholder is English-only (server strings never
    # branch on the run language; the model's own content follows the
    # language_directive above).  THIS scope, not the synthesizer's --
    # the sibling `stream` closure below yields it (a synthesizer-local
    # was a NameError on the first real report's first section)
    gap_text = "Section generation failed upstream"
    section_system = deck_prompts.DECK_SECTION_SYSTEM if deck else report_prompts.SECTION_SYSTEM
    claim_re = _DECK_CLAIM_RE if deck else _CLAIM_RE

    def synthesizer(tally: t.Any) -> t.Iterator[dict[str, t.Any]]:
        tally.phase = "write"
        # the fixed lead section's structural identity is English-only
        # (machine contract; the section CONTENT is the model's, in the
        # run language via language_directive)
        summary_meta = ("Executive Summary", "The report's key judgments and the basis for them")
        sections: list[dict[str, t.Any]] = [
            *(
                []
                if deck
                else [
                    {
                        "id": "summary",
                        "title": summary_meta[0],
                        "brief": summary_meta[1],
                        "key_questions": [],
                        "status": "pending",
                    }
                ]
            ),
            *outline["sections"],
        ]

        def snapshot(over: dict[str, str] | None = None) -> dict[str, t.Any]:
            items = [{**s, "status": (over or {}).get(s["id"], s["status"])} for s in sections]
            snap: dict[str, t.Any] = {
                "e": "outline",
                "title": outline["title"],
                "subtitle": outline["subtitle"],
                "sections": items,
            }
            template_name = str(outline.get("template") or "").strip()
            if template_name:
                snap["template"] = template_name
            if deck:
                snap["shape"] = "deck"
            return snap

        def stream(
            messages: list[dict[str, t.Any]], section_id: str, tally: t.Any, reset: bool = False
        ) -> t.Iterator[dict[str, t.Any]]:
            """One section's stream with the failure ladder: a first
            attempt that dies BEFORE its first byte gets one automatic
            retry (the tail sections' long upstream queue is the ordinary
            transient), and only a second dead attempt degrades to the
            gap placeholder -- whose ``failed: true`` mark lets the
            caller's outline snapshot tell the truth.  The retry is
            preceded by a fresh outline snapshot line: the wire's silence
            between LINES is what the client's stream watchdog counts, so
            a second 150s first-byte wait must not ride behind a quiet
            failure."""
            produced = [False]
            yield from _pump_section(cfg, messages, section_id, tally, reset, produced)
            if not produced[0]:
                status[section_id] = "writing"
                yield snapshot(status)
                yield from _pump_section(cfg, messages, section_id, tally, reset, produced)
            if not produced[0]:
                yield {
                    "e": "section",
                    "id": section_id,
                    "t": f"*{gap_text}*\n",
                    "failed": True,
                    **({"reset": True} if reset else {}),
                }

        def _rewrite(section_id: str) -> t.Iterator[dict[str, t.Any]]:
            """ONE settled section's second life: re-run it against this
            closure's own write materials (the same packed context, the
            same citation gate, the sections written BEFORE it as
            continuity) and stream the replacement through the ordinary
            outline/section events -- snapshots carry the ``writing`` /
            ``done`` / ``failed`` states, the reset-marked deltas replace
            the client's buffered text.  Sections written AFTER this one
            were written against the old text and stand (the digest only
            looks backwards); the executive summary is rewritable too --
            it digests every section, so a body rewrite can be followed
            by a summary refresh."""
            status[section_id] = "writing"
            yield snapshot(status)
            text = ""
            failed = False
            try:
                if section_id == "summary":
                    source: t.Iterator[dict[str, t.Any]] = _write_summary(question, written, tally, stream)
                else:
                    idx = next(i for i, s in enumerate(outline["sections"]) if s["id"] == section_id)
                    prev_id = outline["sections"][idx - 1]["id"] if idx else ""
                    prev = "" if status.get(prev_id) == "failed" else str(written.get(prev_id) or "").strip()[-600:]
                    source = _write_section(outline["sections"][idx], prev, written, status, tally, stream)
                for event in source:
                    if event.get("e") == "section":
                        if event.get("failed"):
                            failed = True
                        text += str(event.get("t") or "")
                    yield event
            except Exception:  # pylint: disable=broad-except
                logger.exception("zjsearch report: rewrite of section %s failed", section_id)
                failed = True
                if not text:
                    yield {
                        "e": "section",
                        "id": section_id,
                        "t": f"*{gap_text}*\n",
                        "failed": True,
                        "reset": True,
                    }
            written[section_id] = text.strip()
            status[section_id] = "failed" if failed else "done"
            yield snapshot(status)

        def rewrite_entry(section_id: str) -> t.Iterator[dict[str, t.Any]]:
            """The handle's rewrite lane (the route calls this): validates
            the id EAGERLY (KeyError -- the route answers 404) so the
            HTTP status is precise, then returns the streaming
            generator."""
            if section_id not in {s["id"] for s in sections}:
                raise KeyError(section_id)
            return _rewrite(section_id)

        yield snapshot()
        written: dict[str, str] = {}
        status: dict[str, str] = {}
        if handle is not None:
            # the rewrite lane opens WITH the write phase: by the settle
            # (the route's precondition) the registration is long done
            handle.section_rewrite = rewrite_entry
        prev_tail = ""
        for sec in outline["sections"]:
            status[sec["id"]] = "writing"
            yield snapshot(status)
            text = ""
            failed = False
            for event in _write_section(sec, prev_tail, written, status, tally, stream):
                if event.get("e") == "section":
                    if event.get("failed"):
                        failed = True
                    text += str(event.get("t") or "")
                yield event
            written[sec["id"]] = text.strip()
            status[sec["id"]] = "failed" if failed else "done"
            yield snapshot(status)
            # a failed section's placeholder is not continuity: the next
            # section writes without a previous tail rather than chaining
            # off the failure note
            prev_tail = "" if failed else text.strip()[-600:]
        # the executive summary: LAST, over the finished sections (the deck
        # shape has none -- the chapters' own closing slides carry the
        # conclusion)
        if not deck:
            status["summary"] = "writing"
            yield snapshot(status)
            text = ""
            failed = False
            for event in _write_summary(question, written, tally, stream):
                if event.get("e") == "section":
                    if event.get("failed"):
                        failed = True
                    text += str(event.get("t") or "")
                yield event
            written["summary"] = text.strip()
            status["summary"] = "failed" if failed else "done"
            yield snapshot(status)
        yield wire.settle("done", **tally.settle_kwargs())

    def _section_messages(
        sec: dict[str, t.Any], prev_tail: str, written: dict[str, str], status: dict[str, str]
    ) -> list[dict[str, t.Any]]:
        query = " ".join([sec["title"], sec["brief"], *sec["key_questions"]])
        # the cross-section dedup's probe vectors: the already-written
        # sections' heads -- chunks repeating them get demoted from the
        # pack (fail-open: embedding off keeps every chunk eligible)
        avoid_vectors: list[list[float]] = []
        if embed_service.configured() and written:
            try:
                heads = [text[:400] for text in list(written.values())[-6:]]
                batch = embed_service.run_batch(heads, timeout=8.0, account=state.account)
                if batch and len(batch[0]) == len(heads):
                    avoid_vectors = batch[0]
            except Exception:  # pylint: disable=broad-except
                avoid_vectors = []
        material = state.corpus.pack(query, k=14, budget=PACK_BUDGET_DEFAULT, avoid=avoid_vectors)
        system = "\n".join([today, section_system, lang_directive])
        # the findings ledger rides EVERY section (the same distillation
        # the single-write writer gets, bounded): facts retire from the
        # corpus as it evicts, the ledger is the run's authoritative
        # map -- a signal-card section in particular needs the whole
        # evidence trail, not only what this section's query retrieves
        active_facts = [
            str(f.get("text") or "").strip() for f in getattr(state, "facts", []) or [] if f.get("status") == "active"
        ]
        ledger_block = ""
        if active_facts:
            shown: list[str] = []
            used = 0
            for fact in active_facts:
                if used + len(fact) > 4_000 or len(shown) >= 24:
                    break
                shown.append(f"- {fact}")
                used += len(fact) + 2
            facts_text = "\n".join(shown)
            ledger_block = spine.block(
                "findings_ledger",
                f"The research agent's distillation of what the sources established (active facts only; their [n] labels refer to the run's source registry):\n{facts_text}",
            )
        user = _section_user(
            sec, outline, prev_tail, written, material, state.artifacts, state.attached_files or None, ledger_block
        )
        _ = status
        return [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

    def _write_section(
        sec: dict[str, t.Any],
        prev_tail: str,
        written: dict[str, str],
        status: dict[str, str],
        tally: t.Any,
        stream: t.Callable[..., t.Iterator[dict[str, t.Any]]],
    ) -> t.Iterator[dict[str, t.Any]]:
        """One section: the completion, then the citation gate (whose
        rewrite, when it fires, replaces the streamed text -- the client
        re-renders the section from the deltas it already has, so the
        rewrite stream APPENDS a full replacement block delimited by the
        section id).  ``stream`` is the synthesizer's failure-laddered
        stream (synthesizer scope -- it carries the outline snapshots the
        retry and the gap note ride)."""
        messages = _section_messages(sec, prev_tail, written, status)
        text = ""
        for event in stream(messages, sec["id"], tally, reset=True):
            if event.get("e") == "section":
                text += str(event.get("t") or "")
            yield event
        for event in _citation_gate(sec, text, written, tally, stream):
            if event.get("e") == "section":
                text = str(event.get("t") or "")  # the rewrite REPLACES
            yield event

    def _citation_gate(
        sec: dict[str, t.Any],
        text: str,
        written: dict[str, str],
        tally: t.Any,
        stream: t.Callable[..., t.Iterator[dict[str, t.Any]]],
    ) -> t.Iterator[dict[str, t.Any]]:
        """The section-level citation gate: sample the cited claims, one
        decision pass judges each against its source's material; a
        failing claim earns ONE targeted rewrite -- the fix happens
        BEFORE delivery (the reason the old post-write audit was removed
        does not apply section-wise).  Fail-open everywhere."""
        if not text or not (decision.enabled() and decision.configured()):
            return
        gate_cfg = decision_features("citation_gate")
        if gate_cfg.get("enabled") is False:
            return
        # the sampling scales with the section (a 2k-char section warrants
        # more than three spot checks; 6 is the ceiling -- still a spot
        # check, never an audit)
        max_claims = max(_MAX_GATE_CLAIMS, min(6, len(text) // 800))
        claims = claim_re.findall(text)[:max_claims]
        if not claims:
            return
        needed: set[int] = set()
        for claim in claims:
            needed.update(int(x) for x in re.findall(r"\[(\d+)", claim))
        sources = {n: state.entries.get(n) or {} for n in needed if state.entries.get(n)}
        if not sources:
            return
        state_str = "\n\n".join(
            f"[{n}] {src.get('title', '')}: {src.get('snippet', '')}"[:900] for n, src in sources.items()
        )
        questions = {
            f"claim_{i}": {
                "type": "noul",
                "instructions": f"{report_prompts.CITATION_GATE_INSTRUCTIONS} Claim: {claim[:300]}",
            }
            for i, claim in enumerate(claims)
        }
        started = time.monotonic()
        try:
            out = decision.evaluate(state_str[:6000], questions, timeout=12.0, account=state.account)
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch report: citation gate failed: %r", exc)
            return
        answers = out.get("answers") if isinstance(out, dict) else None
        if not isinstance(answers, dict):
            return
        verdicts = []
        failed: list[str] = []
        for i, claim in enumerate(claims):
            answer = answers.get(f"claim_{i}")
            if not isinstance(answer, dict):
                continue
            p = float(answer.get("noul") or 0.0)
            verdicts.append({"claim": claim[:120], "p": round(p, 3)})
            if p < float(gate_cfg.get("support_min", 0.5)):
                failed.append(claim)
        # NAMED-VERDICT-MAP shape: one noul per sampled claim (name c_<i>),
        # claim texts in record.questions -- same protocol as the referee
        state.judgments.append(
            {
                "purpose": "citation_gate",
                "question": "Spot check: are the sampled citations supported by their sources?",
                "target": sec["title"][:120],
                "answers": {
                    f"c_{i}": {"type": "noul", "noul": round(float(v.get("p") or 0), 3)} for i, v in enumerate(verdicts)
                },
                "record_questions": [
                    {"name": f"c_{i}", "instructions": str(v.get("claim") or "")[:200]} for i, v in enumerate(verdicts)
                ],
                "rewritten": bool(failed),
                "ms": int((time.monotonic() - started) * 1000),
            }
        )
        if not failed:
            return
        fix_note = "\n".join(f"- {claim}" for claim in failed)
        revision = (
            _section_user(sec, outline, "", written, [], state.artifacts, state.attached_files or None)
            + "\n<revision>\nYou already wrote this section:\n<section>\n"
            + text[:6000]
            + "\n</section>\nThe following cited claims are NOT supported by their"
            " sources (verified): output the COMPLETE section again, fixing or"
            " dropping exactly those claims -- everything else stays.\n" + fix_note + "\n</revision>"
        )
        logger.info(
            "zjsearch report: section %s citation gate: %d claim(s) failed -- rewriting", sec["id"], len(failed)
        )
        rewrite = ""
        system = "\n".join([section_system, lang_directive])
        # the rewrite BUFFERS (it does not stream): its validity is only
        # known after the gap check, and the verified full text goes out
        # exactly once -- streaming it live would replace the client's
        # section on the FIRST delta (reset marks it) even when the check
        # then fails, and re-sending the whole text doubled the wire
        for event in stream(
            [{"role": "system", "content": system}, {"role": "user", "content": revision}], sec["id"], tally, reset=True
        ):
            if event.get("e") == "section":
                rewrite += str(event.get("t") or "")
        if rewrite.strip() and gap_text not in rewrite:
            # the replacement marker: the client resets the section buffer
            # on this event's reset flag, then this whole text IS the section
            yield {"e": "section", "id": sec["id"], "t": rewrite, "reset": True}

    def _write_summary(
        question: str,
        written: dict[str, str],
        tally: t.Any,
        stream: t.Callable[..., t.Iterator[dict[str, t.Any]]],
    ) -> t.Iterator[dict[str, t.Any]]:
        digest_parts = []
        used = 0
        for sec in outline["sections"]:
            block = f"## {sec['title']}\n{written.get(sec['id'], '')[:1400]}\n"
            if used + len(block) > 12_000:
                break
            digest_parts.append(block)
            used += len(block)
        system = "\n".join([today, report_prompts.SUMMARY_SYSTEM, lang_directive])
        user = report_prompts.summary_user(question[:1000], "\n".join(digest_parts))
        yield from stream([{"role": "system", "content": system}, {"role": "user", "content": user}], "summary", tally)

    return synthesizer


def _section_user(
    sec: dict[str, t.Any],
    outline: dict[str, t.Any],
    prev_tail: str,
    written: dict[str, str],
    material: list[str],
    artifacts: list[dict[str, t.Any]],
    attachments: list[dict[str, str]] | None = None,
    ledger_block: str = "",
) -> str:
    """One section's user turn: the outline snapshot (place + neighbours),
    the previous section's tail (continuity), the findings ledger, the
    packed key material and the recorded tables."""
    title_line = outline["title"] + (f" -- {outline['subtitle']}" if outline.get("subtitle") else "")
    parts = [spine.block("question", title_line)]
    toc = "\n".join(
        f"- {'[done] ' if s['id'] in written else ('[this one] ' if s['id'] == sec['id'] else '')}{s['title']}"
        for s in outline["sections"]
    )
    parts.append(spine.block("report_outline", toc))
    section_body = f"title: {sec['title']}\nbrief: {sec['brief']}"
    if sec["key_questions"]:
        # the join rides its own line under the label (the old inline
        # concat glued the first question to the colon)
        section_body += "\nkey questions:\n" + "\n".join(f"- {q}" for q in sec["key_questions"])
    parts.append(spine.block("this_section", section_body))
    if written:
        # the EARLIER sections' opening theses (the IterResearch-style
        # workspace refinement): every written section except the
        # immediately-previous one -- whose ending already rides
        # <previous_section_tail> -- contributes its title + first ~200
        # chars, so this section writes against ALL prior positions, not
        # just the previous one's last 600 chars.  Purely mechanical
        # (no extra model calls); the executive summary's call passes a
        # full ``written`` with no prev_tail, so it digests EVERYTHING.
        done_ids = [s["id"] for s in outline["sections"] if s["id"] in written]
        digest_ids = done_ids[:-1] if prev_tail else done_ids
        rows = []
        for sid in digest_ids:
            title = next((s["title"] for s in outline["sections"] if s["id"] == sid), sid)
            body = " ".join(str(written.get(sid) or "").split())
            if body:
                rows.append(f"- {title}: {body[:200]}")
        if rows:
            rows_text = "\n".join(rows)
            parts.append(
                spine.block(
                    "earlier_sections_digest",
                    f"""\
                    What the EARLIER sections already established (their
                    openings; stay consistent with their judgments and never
                    re-argue them):
                    {rows_text}""",
                )
            )
    if prev_tail:
        parts.append(spine.block("previous_section_tail", prev_tail))
    if ledger_block:
        parts.append(ledger_block)
    if material:
        key_body = "The numbered lines are this run's sources; cite them by their [n]."
        if attachments:
            key_body += f"""\

Lines WITHOUT a [n] that begin with a file name are the USER'S ATTACHED
FRAMEWORK -- its rules are BINDING for this section's judgments: apply
them by their rule ID (e.g. [RULE-CCM-02]) right after the claim they
support, and never invent a rule ID the framework does not contain."""
        parts.append(spine.block("key_material", key_body + "\n" + "\n".join(material)))
        if attachments:
            names = ", ".join(f'\"{str(f.get("name") or "attachment")}\"' for f in attachments[:3])
            parts.append(
                spine.block(
                    "attachments",
                    f"""\
                    The user attached framework file(s) {names} -- the
                    report's conclusions must FOLLOW the framework's rule
                    set, and every opportunity/recommendation cites the rule
                    IDs it applies.""",
                )
            )
    if artifacts:
        tables = []
        for artifact in artifacts[:6]:
            lines = [f"table {artifact['id']}: {artifact['title']}"]
            lines.append("| " + " | ".join(artifact["columns"]) + " |")
            lines.append("|" + "---|" * len(artifact["columns"]))
            for row in artifact["rows"]:
                cells = list(row["cells"]) + [""] * (len(artifact["columns"]) - len(row["cells"]))
                cite = (" [" + ",".join(str(r) for r in row["refs"]) + "]") if row.get("refs") else ""
                lines.append("| " + " | ".join(cells) + cite + " |")
            if artifact.get("note"):
                lines.append(f"note: {artifact['note']}")
            tables.append("\n".join(lines))
        tables_text = "\n\n".join(tables)
        parts.append(
            f"""\
<recorded_tables>
These tables were verified during research -- reproduce them as-is
(markdown tables render as real tables) and interpret them; do not
retype their numbers in prose.
{tables_text}
</recorded_tables>"""
        )
    return "\n".join(p for p in parts if p)
