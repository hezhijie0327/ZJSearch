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


def _stream_section_once(
    cfg: dict[str, t.Any],
    messages: list[dict[str, t.Any]],
    section_id: str,
    tally: t.Any,
    gap_text: str,
    reset: bool = False,
) -> t.Iterator[dict[str, t.Any]]:
    """One section stream: answer deltas as ``section`` events; the usage
    lands in the tally; a transport error degrades THIS section to a
    visible gap note IN THE REPORT'S LANGUAGE (the document still
    ships).  ``reset`` marks the stream's FIRST delta ``reset: true`` --
    the wire contract that this stream REPLACES whatever the client
    already buffers for the section id (the citation gate's rewrite, and
    every re-synthesis a CONTINUE replays into a run whose earlier
    attempt had already written the section)."""
    stream = LlmStream(cfg, messages, relay_reasoning=False)
    produced = False
    try:
        while True:
            wait = _FIRST_TIMEOUT if not produced else _IDLE_TIMEOUT
            kind, payload = stream.next_event(wait)
            if kind == "delta":
                text = str(payload or "")
                if text:
                    first = not produced
                    produced = True
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
                break
            else:
                break
    finally:
        stream.cancel()
    if not produced:
        yield {"e": "section", "id": section_id, "t": f"*{gap_text}*\n"}


def make_synthesizer(
    cfg: dict[str, t.Any],
    state: t.Any,
    outline: dict[str, t.Any],
    question: str,
    lang: str,
    gate_usage: list[dict[str, t.Any]],  # pylint: disable=unused-argument
    take_template: t.Callable[[bool], dict[str, t.Any] | None] | None = None,
    take_deck: t.Callable[[], bool | None] | None = None,
    deck: bool = False,
) -> t.Callable[[t.Any], t.Iterator[dict[str, t.Any]]]:
    """Bind the run's state and outline; returns the synthesizer the loop
    calls with the tally at write-phase time.  ``gate_usage`` receives the
    outline gate's spend on the route side; the citation gate's verdicts
    land in ``state.judgments`` (the 决策结果 card).  ``take_template`` is
    the rail's 输出结构 channel: ONE pending template consumed at the write
    boundary -- a template the user picked while the research ran REPLACES
    the route-time outline before the first section streams (the rebuilt
    skeleton arrives as the first ``outline`` snapshot; the client's TOC
    follows automatically); it receives the boundary-resolved shape (a
    run-time shape flip re-mints in the flipped dialect).  ``take_deck``
    is the shape-flip half of the same channel: the pending 报告|演示文稿
    pick rebinds the section dialect at the boundary (slide vs prose, the
    executive summary added/dropped, the snapshot's ``shape`` field).
    ``deck`` is the request-time shape the flips default from -- the
    machinery (packed context, streaming, citation gate + rewrite) is the
    report's own either way."""
    lang_directive = spine.language_directive(lang)
    # the run's own two languages (the client renders the catalog tag
    # verbatim into TOC entries): the synthesized sections' identity
    # text follows the run language, never a hardcoded default.  THIS
    # scope, not the synthesizer's -- the sibling `stream` closure below
    # yields it (a synthesizer-local was a NameError on the first real
    # report's first section)
    zh = lang.strip().lower().startswith("zh")
    gap_text = "本节生成失败" if zh else "Section generation failed upstream"
    section_system = deck_prompts.DECK_SECTION_SYSTEM if deck else report_prompts.SECTION_SYSTEM
    claim_re = _DECK_CLAIM_RE if deck else _CLAIM_RE

    def stream(
        messages: list[dict[str, t.Any]], section_id: str, tally: t.Any, reset: bool = False
    ) -> t.Iterator[dict[str, t.Any]]:
        yield from _stream_section_once(cfg, messages, section_id, tally, gap_text, reset=reset)

    def synthesizer(tally: t.Any) -> t.Iterator[dict[str, t.Any]]:
        nonlocal outline, deck, section_system, claim_re
        tally.phase = "write"
        # the write boundary's shape consume: the rail's last 输出结构
        # flip (if any) rebinds the dialect HERE -- the section prompt,
        # the claim gate's sampling window, the executive summary and the
        # snapshot's shape field all follow the flipped value
        flipped = take_deck() if take_deck is not None else None
        if flipped is not None and flipped != deck:
            logger.info("zjsearch report: output shape flipped at the write boundary (%s)", "deck" if flipped else "report")
            deck = flipped
            section_system = deck_prompts.DECK_SECTION_SYSTEM if deck else report_prompts.SECTION_SYSTEM
            claim_re = _DECK_CLAIM_RE if deck else _CLAIM_RE
        # the boundary's template consume: the rail's last 输出结构 pick
        # (if any) re-mints the skeleton HERE -- the research ran on
        # its own ledger either way, only the document's shape changes
        rebuilt = take_template(deck) if take_template is not None else None
        if rebuilt is not None:
            logger.info("zjsearch report: outline re-minted from a run-time template pick")
            outline = rebuilt
        summary_meta = (
            ("执行摘要", "全文最重要的判断与依据")
            if zh
            else ("Executive Summary", "The report's key judgments and the basis for them")
        )
        sections: list[dict[str, t.Any]] = [
            *([] if deck else [{"id": "summary", "title": summary_meta[0], "brief": summary_meta[1],
                                "key_questions": [], "status": "pending"}]),
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

        yield snapshot()
        written: dict[str, str] = {}
        status: dict[str, str] = {}
        prev_tail = ""
        for sec in outline["sections"]:
            status[sec["id"]] = "writing"
            yield snapshot(status)
            text = ""
            for event in _write_section(sec, prev_tail, written, status, tally):
                if event.get("e") == "section":
                    text += str(event.get("t") or "")
                yield event
            written[sec["id"]] = text.strip()
            status[sec["id"]] = "done"
            yield snapshot(status)
            prev_tail = text.strip()[-600:]
        # the executive summary: LAST, over the finished sections (the deck
        # shape has none -- the chapters' own closing slides carry the
        # conclusion)
        if not deck:
            status["summary"] = "writing"
            yield snapshot(status)
            text = ""
            for event in _write_summary(question, written, tally):
                if event.get("e") == "section":
                    text += str(event.get("t") or "")
                yield event
            written["summary"] = text.strip()
            status["summary"] = "done"
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
                batch = embed_service.run_batch(heads, timeout=8.0)
                if batch and len(batch[0]) == len(heads):
                    avoid_vectors = batch[0]
            except Exception:  # pylint: disable=broad-except
                avoid_vectors = []
        material = state.corpus.pack(query, k=14, budget=PACK_BUDGET_DEFAULT, avoid=avoid_vectors)
        system = "\n".join([section_system, lang_directive])
        # the findings ledger rides EVERY section (the same distillation
        # the single-write writer gets, bounded): facts retire from the
        # corpus as it evicts, the ledger is the run's authoritative
        # map -- a signal-card section in particular needs the whole
        # evidence trail, not only what this section's query retrieves
        active_facts = [str(f.get("text") or "").strip() for f in getattr(state, "facts", []) or [] if f.get("status") == "active"]
        ledger_block = ""
        if active_facts:
            shown: list[str] = []
            used = 0
            for fact in active_facts:
                if used + len(fact) > 4_000 or len(shown) >= 24:
                    break
                shown.append(f"- {fact}")
                used += len(fact) + 2
            ledger_block = (
                "<findings_ledger>\nThe research agent's distillation of what"
                " the sources established (active facts only; their [n] labels"
                " refer to the run's source registry):\n"
                + "\n".join(shown)
                + "\n</findings_ledger>"
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
    ) -> t.Iterator[dict[str, t.Any]]:
        """One section: the completion, then the citation gate (whose
        rewrite, when it fires, replaces the streamed text -- the client
        re-renders the section from the deltas it already has, so the
        rewrite stream APPENDS a full replacement block delimited by the
        section id)."""
        messages = _section_messages(sec, prev_tail, written, status)
        text = ""
        for event in stream(messages, sec["id"], tally, reset=True):
            if event.get("e") == "section":
                text += str(event.get("t") or "")
            yield event
        for event in _citation_gate(sec, text, written, tally):
            if event.get("e") == "section":
                text = str(event.get("t") or "")  # the rewrite REPLACES
            yield event

    def _citation_gate(
        sec: dict[str, t.Any], text: str, written: dict[str, str], tally: t.Any
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
            out = decision.judge(state_str[:6000], questions, timeout=12.0)
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
        for event in stream(
            [{"role": "system", "content": system}, {"role": "user", "content": revision}], sec["id"], tally, reset=True
        ):
            if event.get("e") == "section":
                rewrite += str(event.get("t") or "")
            yield event
        if rewrite.strip() and gap_text not in rewrite:
            # the replacement marker: the client resets the section buffer
            # on this event's reset flag, then this whole text IS the section
            yield {"e": "section", "id": sec["id"], "t": rewrite, "reset": True}

    def _write_summary(question: str, written: dict[str, str], tally: t.Any) -> t.Iterator[dict[str, t.Any]]:
        digest_parts = []
        used = 0
        for sec in outline["sections"]:
            block = f"## {sec['title']}\n{written.get(sec['id'], '')[:1400]}\n"
            if used + len(block) > 12_000:
                break
            digest_parts.append(block)
            used += len(block)
        system = "\n".join([report_prompts.SUMMARY_SYSTEM, lang_directive])
        user = report_prompts.SUMMARY_USER.format(q=question[:1000], digest="\n".join(digest_parts))
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
    parts = [f"<question>{title_line}</question>"]
    toc = "\n".join(
        f"- {'[done] ' if s['id'] in written else ('[this one] ' if s['id'] == sec['id'] else '')}{s['title']}"
        for s in outline["sections"]
    )
    parts.append(f"<report_outline>\n{toc}\n</report_outline>")
    parts.append(f"<this_section>\ntitle: {sec['title']}\nbrief: {sec['brief']}")
    if sec["key_questions"]:
        parts.append("key questions:\n" + "\n".join(f"- {q}" for q in sec["key_questions"]))
    parts.append("</this_section>")
    if prev_tail:
        parts.append(f"<previous_section_tail>\n{prev_tail}\n</previous_section_tail>")
    if ledger_block:
        parts.append(ledger_block)
    if material:
        header = "<key_material>\nThe numbered lines are this run's sources; cite them by their [n]."
        if attachments:
            header += (
                "\nLines WITHOUT a [n] that begin with a file name are the USER'S ATTACHED"
                " FRAMEWORK -- its rules are BINDING for this section's judgments: apply them"
                " by their rule ID (e.g. [RULE-CCM-02]) right after the claim they support,"
                " and never invent a rule ID the framework does not contain."
            )
        parts.append(header + "\n" + "\n".join(material) + "\n</key_material>")
        if attachments:
            names = ", ".join(f'\"{str(f.get("name") or "attachment")}\"' for f in attachments[:3])
            parts.append(
                "<attachments>\nThe user attached framework file(s) "
                + names
                + " -- the report's conclusions must FOLLOW the framework's rule set, and every"
                " opportunity/recommendation cites the rule IDs it applies.\n</attachments>"
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
        parts.append(
            "<recorded_tables>\nThese tables were verified during research -- reproduce them as-is"
            " (markdown tables render as real tables) and interpret them; do not retype their"
            " numbers in prose.\n" + "\n\n".join(tables) + "\n</recorded_tables>"
        )
    return "\n".join(p for p in parts if p)
