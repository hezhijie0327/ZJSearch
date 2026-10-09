# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``POST /zjsearch/ai/search`` route.

Thin by design (Vane's api.ts, Morphic's app/api/chat/route.ts): parse
and authorize the request, run the pre-flight gates, assemble
:py:func:`agent.loop.run` with its tools / executor / writer, and
encode the timeline ops as NDJSON.  All the mechanics live in the
sibling modules.  After the loop's ``settle``, only two LATE events may
follow -- the related-questions fallback completion and the memory
extraction -- both suppressed on an ``awaiting`` run.  A run that
settles as an error BEFORE any content event becomes the plain-text 502
(prime before streaming, so the status code is honest).
"""

import json
import logging
import re
import threading
import time
import typing as t

import flask

from searx.extended_types import sxng_request
from searx.zjsearch.ai.tools import mcp
from searx.zjsearch.ai.tools import web_browser as web_browser_tool
from searx.zjsearch.ai.tools import web_reader as reader
from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.tools.past_research import parse_entries as parse_past_research
from searx.zjsearch.ai.tools.memory import extract_insights, parse_memories
from searx.zjsearch.ai.agent import loop as engine
from searx.zjsearch.ai.agent import wire
from searx.zjsearch.ai.core.ndjson import UpstreamDead as _UpstreamDead
from searx.zjsearch.ai.agent.fences import parse_fence_json
from searx.zjsearch.ai.llm import config as llm_config
from searx.zjsearch.ai.api import http
from searx.zjsearch.ai.llm import decision, jsongate
from searx.zjsearch.ai.llm import sdk as sdk_registry
from searx.zjsearch.ai.runs.search.context import _relevance_order
from searx.zjsearch.ai.runs.search.executor import Searches
from searx.zjsearch.ai.llm.decision import features as decision_features
from searx.zjsearch.ai.runs.report import outline as report_outline
from searx.zjsearch.ai.runs.report import synth as report_synth
from searx.zjsearch.ai.runs import attachments as uploads
from searx.zjsearch.ai.runs import host as run_host
from searx.zjsearch.ai.runs.search.progress import continuation_note, round_progress
from searx.zjsearch.ai.runs.search.gates import (
    clarify_gate,
    generate_title,
    related_questions,
    research_gate,
    sanitize_questions,
    standalone_question,
)
from searx.zjsearch.ai.runs.profile import budget, enabled, SEARCH_MODES
from searx.zjsearch.ai.prompts.researcher import initial_messages
from searx.zjsearch.ai.runs.search.writer import writer_messages
from searx.zjsearch.ai.tools import (
    ASK_TOOL,
    view_image_spec,
    ask_user_spec,
    calculator_spec,
    display_item,
    extract_spec,
    learnings_spec,
    page_spec,
    past_research_spec,
    research_subtask_spec,
    system_one_spec,
    task_write_spec,
    tool_spec,
    user_memory_spec,
)

logger = logging.getLogger(__name__)

_URL_RE = re.compile(r"https?://[^\s<>\"']+")

_CONTENT_EVENTS = (
    "open",
    "think",
    "say",
    "answer",
    "calls",
    "call",
    "close",
    "tasks",
    "learnings",
    "sources",
    "ask",
    "gallery",
    "outline",
    "artifact",
    "section",
)
"""The wire events that prove the upstream is alive: a ``settle`` before
any of these is the 502 path (the stream died before its first token)."""


def _ask_shape(arguments: str) -> dict[str, t.Any] | None:
    """The mid-run ``ask_user`` tool arguments -> the ask event's payload
    (the same sanitized shape the clarify gate emits); ``None`` when the
    model asked an unusable question."""
    value = jsongate.json_object_of(arguments) or {}
    questions = sanitize_questions(value.get("questions"))
    if not questions:
        return None
    return {"intro": str(value.get("intro") or "").strip()[:200], "questions": questions}


_RESUME_MAX_CHARS = 2_000_000
"""The replayed conversation's JSON budget (a deep run's transcript with
hundreds of sources lands well under it; a bigger payload is a corrupt
store -- fresh-conversation fallback, not a 413)."""

RESUME_NOTE = (
    "<resume_note>The transcript above is your own research from a previous"
    " process that died mid-run -- it is complete up to the last tool results"
    " shown. Continue it where it stands: re-affirm your task ledger"
    " (task_write) and findings ledger (learnings) first if they are not"
    " current in this transcript, do NOT repeat searches or page reads whose"
    " results already appear above (their sources keep their [n] numbers),"
    " then continue the open ledger items. The user experiences this as the"
    " same run resuming, not a restart.</resume_note>"
)
"""The researcher-facing continuation note appended AFTER the replayed
conversation (an honest English note -- the model never sees machine
keys)."""


def parse_resume(raw: t.Any, sources_base: int) -> dict[str, t.Any] | None:
    """The CONTINUE contract's replay payload: the client sends a dead
    attempt's exact conversation back (the ``ctx`` checkpoints the loop
    emitted -- the browser's store is the only conversation storage the
    stateless server has).  Returns ``None`` for an absent or malformed
    payload (the caller silently builds a fresh conversation instead);
    assistant ``thinking`` blocks are STRIPPED -- their signatures never
    survive a process border, and the transcript's text and tool turns
    carry everything the continuation needs."""
    if not isinstance(raw, dict):
        return None
    raw_messages = raw.get("messages")
    if not isinstance(raw_messages, list) or not raw_messages:
        return None
    messages: list[dict[str, t.Any]] = []
    for raw_message in raw_messages[:400]:
        if not isinstance(raw_message, dict) or not str(raw_message.get("role") or ""):
            return None
        message = dict(raw_message)
        content = message.get("content")
        if isinstance(content, list):
            message["content"] = [
                block for block in content if not (isinstance(block, dict) and block.get("type") == "thinking")
            ]
        messages.append(message)
    try:
        if len(json.dumps(messages, ensure_ascii=False)) > _RESUME_MAX_CHARS:
            return None
    except (TypeError, ValueError):
        return None

    def _clamped(key: str, ceiling: int) -> int:
        try:
            return min(abs(int(raw.get(key))), ceiling)
        except (TypeError, ValueError):
            return 0

    sources: list[dict[str, t.Any]] = []
    raw_sources = raw.get("sources")
    if isinstance(raw_sources, list):
        for item in raw_sources[:2000]:
            if not isinstance(item, dict):
                continue
            n = int(item.get("n") or 0)
            url = str(item.get("url") or "").strip()
            if n < 1 or n > sources_base or not url:
                continue
            sources.append({"n": n, "url": url[:500], "title": str(item.get("title") or "")[:300]})
    return {
        "messages": messages,
        "sources": sources,
        "entry_base": _clamped("entry_base", 100_000),
        "round_base": _clamped("round_base", 1000),
        # the interrupted REPORT's stored outline (best-effort -- the
        # client's snapshot is lossy, key_questions regenerate empty; the
        # TOC the user already saw stays stable, which is the point)
        "outline": raw.get("outline") if isinstance(raw.get("outline"), dict) else None,
    }


def _search(  # pylint: disable=too-many-branches, too-many-statements, too-many-locals
    degraded: bool = False,
) -> flask.Response:
    """AI Search: the researcher/writer split on the shared agent loop."""
    cfg = llm_config.llm_cfg()
    # every gate completion's token account lands here -- the settle's
    # usage carries the sum under ``gates`` (the gates are real model
    # calls and MUST NOT be dark matter in the run's account)
    gate_usage: list[dict[str, t.Any]] = []
    payload, q, _ctx = http.authorize(gate=enabled() and llm_config.configured(cfg))
    # the client-owned thread identity (browser-stored conversation): logged
    # for problem localization, never stored server-side -- the endpoint
    # stays stateless
    thread = str(payload.get("thread") or "").strip()[:64]
    if thread:
        logger.info("zjsearch_ai_search: thread %s", thread)
    # follow-up thread: prior Q&A turns + the global [n] numbering base
    raw_history = payload.get("history")
    history: list[dict[str, str]] = []
    if isinstance(raw_history, list):
        for item in raw_history[:4]:
            if isinstance(item, dict) and item.get("q") and item.get("a"):
                history.append({"q": str(item["q"])[:300], "a": str(item["a"])[:2000]})
    try:
        # the [n] base is the thread's GLOBAL counter -- a heavy deep run
        # gathers hundreds of sources, the old 200 clamp made a continue's
        # fresh mints collide with the dead attempt's numbers
        sources_base = min(abs(int(payload.get("sources_base"))), 2000)
    except (TypeError, ValueError):
        sources_base = 0
    # the CONTINUE replay: the client sends a dead attempt's exact
    # conversation back (the ctx checkpoints) -- the resumed run continues
    # THE conversation instead of restarting the research.  ``None`` (an
    # old client, a corrupt store) silently falls back to the fresh path.
    resume = parse_resume(payload.get("resume"), sources_base)
    if resume is not None:
        logger.info(
            "zjsearch_ai_search: resuming a dead run's conversation (%d messages, entry_base=%d, round_base=%d)",
            len(resume["messages"]),
            resume["entry_base"],
            resume["round_base"],
        )
    # the browser's research memory (the client recalls its PGlite corpus
    # before posting): WRITER-PHASE ONLY -- numbered after the live feed,
    # never seeded into the researcher (ready-made material kills the
    # live-search incentive).  The user-memory snapshot and the
    # past-research index (reader heads + corpus sources) ride the same
    # pre-send: the model searches them through their tools, saves flow
    # back as events.  Uploaded images travel as data URLs and are FORWARDED
    # verbatim to the researcher's first turn -- the server stores nothing
    # (the browser's knowledge base is the only attachment storage); a run
    # whose transport rejects them retries ONCE as text-only (below).
    user_memories = parse_memories(payload.get("user_memories"))
    past_research_entries = parse_past_research(payload.get("past_research"))
    image_parts, attached_files = ([], []) if degraded else uploads.parse_uploads(payload.get("attachments"))
    # the clarify gates are TEXT-only completions -- without this note they
    # answer "no image came through" about an image the researcher WILL see
    gate_note = (
        "\n(The user has attached image(s) to this question; the research" " agent can see them.)"
        if image_parts
        else ""
    )
    past_sources: list[dict[str, str]] = []
    raw_past = payload.get("history_sources")
    if isinstance(raw_past, list):
        for item in raw_past[:6]:
            if isinstance(item, dict) and item.get("url"):
                past_sources.append({"url": str(item["url"])[:500], "title": str(item.get("title") or "")[:200]})
    mode = str(payload.get("mode") or "balanced").strip().lower()
    if mode not in SEARCH_MODES:
        mode = "balanced"
    lang = http.answer_lang(payload)

    raw_search_language = str(payload.get("search_language") or "").strip()
    if raw_search_language.lower() in ("", "auto", "all"):
        raw_search_language = ""
    # the clarify round-trip: "ask" = the gate may fire (first run of a
    # gated mode), "answered"/"skipped" = the user responded -- the run
    # then researches with the confirmed direction (or without one)
    clarify_state = str(payload.get("clarify_state") or "ask").strip().lower()
    if clarify_state not in ("ask", "answered", "skipped"):
        clarify_state = "ask"
    clarifications = str(payload.get("clarifications") or "").strip()[:2000]
    if resume is not None:
        # a resume re-enters a conversation that already passed every
        # gate: no clarify (the direction is in the transcript), and the
        # research phase is the POINT of the call
        clarify_state = "answered"
        clarifications = ""
    # the REPORT shape: an outline-driven, per-section document -- only
    # for the deep modes (the ladder rung still sizes the research), and
    # always subject to the outline gate (a malformed skeleton falls back
    # to the single-write answer shape below)
    report_requested = bool(payload.get("report")) and mode in ("balanced", "deep")
    max_rounds = budget("max_rounds", mode, 2)
    # the delegation gate's rung: 0 unless the depth probe graded the
    # question -- subagents are the HEAVY question's tool (rung >= 3) and
    # never fire without the effort grader
    depth_rung = 0
    # the pre-flight gate (Vane's skipSearch, narrowed to our contract): a
    # question carrying a URL always researches (the page read IS the
    # research); everything else passes one small completion that skips
    # research only for greetings, chat and writing tasks -- a CONTINUE
    # always researches (the transcript IS the research, no gate spend)
    research_needed = resume is not None or bool(_URL_RE.search(q)) or research_gate(cfg, q, gate_usage)
    # the clarify PRE-GATE (fail-open): two decision nouls decide whether
    # the query even reaches the (expensive) clarify completion -- AMBIGUOUS
    # (the answer's key depends on unstated intent) or HIGH-STAKES (a
    # forecasting/investment/purchase/health/legal direction).  They are
    # separate questions ON PURPOSE: "which index fund should I buy" reads
    # perfectly clear and still must not run on a guess -- one bundled
    # noul let clear-but-risky queries through.  The gate itself stays as
    # the second opinion for everything ambiguous enough to reach it; the
    # pre-screen's verdict + spend join the 决策结果 card either way.
    clarify_worth_asking = True
    pre_usage: dict[str, int] = {"calls": 0, "tokens": 0}
    pre_entry: dict[str, t.Any] | None = None
    if research_needed and clarify_state == "ask" and not history:
        pre = decision_features("clarify_gate")
        if pre.get("enabled") and decision.enabled() and decision.configured():
            try:
                started = time.monotonic()
                pre_out = decision.judge(
                    q,
                    {
                        "ambiguous": {
                            "type": "noul",
                            "instructions": (
                                "Is this question genuinely ambiguous (the answer's key depends on"
                                " unstated user intent/scope/criteria, and guessing wrong wastes the"
                                " whole research)?"
                            ),
                        },
                        "high_stakes": {
                            "type": "noul",
                            "instructions": (
                                "Is this a high-stakes question (forecast, investment, purchase,"
                                " health, legal) whose assumptions change the answer?"
                            ),
                        },
                    },
                    timeout=5.0,
                )
                answers = pre_out.get("answers") if isinstance(pre_out, dict) else None
                ambiguous = answers.get("ambiguous") if isinstance(answers, dict) else None
                stakes = answers.get("high_stakes") if isinstance(answers, dict) else None
                if isinstance(ambiguous, dict) or isinstance(stakes, dict):
                    ambiguity = float(ambiguous.get("noul") or 0.0) if isinstance(ambiguous, dict) else 0.0
                    stakes_score = float(stakes.get("noul") or 0.0) if isinstance(stakes, dict) else 0.0
                    worth = ambiguity >= float(pre.get("ambiguous_min", 0.65))
                    clarify_worth_asking = worth or stakes_score >= float(pre.get("high_stakes_min", 0.60))
                raw_usage = pre_out.get("usage") if isinstance(pre_out, dict) else None
                pre_gate_usage = raw_usage if isinstance(raw_usage, dict) else {}
                if pre_gate_usage.get("input_tokens"):
                    pre_usage["calls"] += 1
                    pre_usage["tokens"] += int(pre_gate_usage.get("input_tokens") or 0)
                if isinstance(answers, dict) and answers:
                    pre_entry = {
                        "purpose": "clarify_gate",
                        "question": (
                            "Per question: ambiguous (intent-dependent) / high_stakes"
                            " (forecast/investment/health/legal) -- noul 0-1, either above its"
                            " threshold opens the clarify round-trip"
                        ),
                        "target": q[:200],
                        "answers": answers,
                        "record_questions": [
                            {"name": "ambiguous", "instructions": "The query reads intent-ambiguous"},
                            {"name": "high_stakes", "instructions": "The query is a high-stakes direction"},
                        ],
                        "worth_asking": clarify_worth_asking,
                        "ms": int((time.monotonic() - started) * 1000),
                    }
            except Exception:  # pylint: disable=broad-except
                clarify_worth_asking = True
    if research_needed and clarify_worth_asking and clarify_state == "ask" and not history:
        gate = clarify_gate(cfg, q, lang, gate_usage, attachments_note=gate_note)
        if gate:
            stream = _Ndjson(
                _clarify_events(gate),
                cfg,
                q,
                lang,
                gate_usage,
                decision_usage=pre_usage,
                judgments=[pre_entry] if pre_entry else None,
                preamble=[{"e": "decisions", "items": [pre_entry]}] if pre_entry else None,
            )
            return _respond(stream)
    # the page reader rides only when the reader (zjsearch.reader) block is
    # fully configured: an unconfigured reader simply leaves the tool
    # unregistered
    pages_on = reader.configured()
    # the interactive browser session rides when the built-in engine is
    # ready (zjsearch.browser): it is the login/interaction escape hatch
    browser_on = browser_config.ready()
    # the MCP bridge (zjsearch.mcp, streamable-HTTP servers): an
    # unconfigured or package-less deployment registers nothing; a large
    # surface switches to PROGRESSIVE DISCLOSURE (one discovery tool
    # instead of every schema)
    mcp_tools = mcp.tools_surface() if mcp.configured() and mcp.sdk_missing() is None else []
    if not research_needed:
        # the no-research run: the writer alone -- the zero-tool case of the
        # shared loop (one streamed write turn whose prose IS the answer)
        events = engine.run(
            cfg,
            writer_messages(
                q,
                lang,
                history,
                [],
                mode,
                None,
                False,
                sources_base,
                direct=True,
                image_parts=image_parts or None,
                attached_files=attached_files or None,
            ),
        )
        stream = _Ndjson(events, cfg, q, lang, gate_usage)
        response = _respond(stream)
        if response.status_code == 502 and image_parts and not degraded:
            logger.warning("zjsearch_ai_search: multimodal request rejected -- retrying text-only")
            return _search(degraded=True)
        return response

    # 万物皆工具: the task list registers for EVERY mode -- the mode's
    # BEHAVIOR note (speed's "do not bother") shapes its use, the surface
    # never gates it
    register_tasks = True
    research_q = (standalone_question(cfg, q, history, lang, gate_usage) if history else "") or q
    depth_probe_entry: dict[str, t.Any] | None = None
    # the DEPTH PROBE: the decision model grades how deep/broad the
    # question needs to be (one score call) and the mode's round LADDER
    # scales accordingly -- the model-controlled depth made literal (the
    # budget number is only the top rung; fail-open keeps the default)
    probe = decision_features("depth_probe")
    if probe.get("enabled") and mode in ("balanced", "deep") and decision.enabled() and decision.configured():
        try:
            ladder = [int(x) for x in (probe.get(f"ladder_{mode}") or [])]
            if ladder:
                started = time.monotonic()
                out = decision.judge(
                    (research_q if research_q else q) + gate_note,
                    {
                        "depth": {
                            "type": "score",
                            "instructions": (
                                "How deep and broad does the research for this question need to be"
                                " (0 = a quick lookup, 4 = an exhaustive multi-facet investigation)?"
                            ),
                            "criteria": [
                                "A quick lookup: one or two searches settle it",
                                "A facet overview: a handful of searches",
                                "Multi-facet research: definitions, mechanics, context",
                                "A full research project: cross-verification, multiple angles, page reads",
                                "An exhaustive investigation: many facets, comparisons, recent dynamics",
                            ],
                        }
                    },
                    timeout=8.0,
                )
                answers = out.get("answers") if isinstance(out, dict) else None
                depth = answers.get("depth") if isinstance(answers, dict) else None
                if isinstance(depth, dict) and depth.get("score") is not None:
                    rung = max(0, min(int(round(float(depth["score"]))), len(ladder) - 1))
                    max_rounds = ladder[rung]
                    depth_rung = rung
                    depth_probe_entry = {
                        "purpose": "depth_probe",
                        "question": "How deep and broad does the research need to be (score 0-4)?",
                        "target": (research_q or q)[:200],
                        "answer": depth,
                        "ms": int((time.monotonic() - started) * 1000),
                    }
        except Exception:  # pylint: disable=broad-except
            pass
    outline: dict[str, t.Any] | None = None
    # the report TEMPLATE rides the request body (presets AND user-defined
    # ones -- the server stays stateless): a valid template switches the
    # outline gate from free generation to FIXED-structure adaptation
    report_template = report_outline.parse_template(payload.get("template")) if report_requested else None
    if report_requested and payload.get("template") is not None and report_template is None:
        logger.info("zjsearch_ai_search: malformed report template -- falling back to the free outline")
    outline_attachments = [
        {"name": str(f.get("name") or "attachment"), "text": str(f.get("text") or "")} for f in (attached_files or [])
    ]
    # the knowledge base's METADATA recall: the client's pre-run corpus
    # recall distilled to TITLES (the red line -- the researcher's feed
    # never sees recalled content; the outline gate sees only topics)
    prior_topics = [str(topic).strip()[:120] for topic in (payload.get("history_topics") or []) if str(topic).strip()][
        :8
    ]
    if report_requested and resume is not None and resume.get("outline"):
        # THE CONTINUE's outline restoration: the interrupted report's
        # stored skeleton re-validated -- a fresh gate completion would
        # mint a DIFFERENT TOC mid-thread (the outline event replaces the
        # stored one client-side); a malformed restore falls through to
        # the gates below
        restored = report_outline.restored_outline(resume["outline"], research_q)
        if restored is not None:
            outline = restored
            logger.info(
                "zjsearch_ai_search: restored the interrupted report's outline (%d sections)", len(restored["sections"])
            )
    if report_requested and outline is None:
        if report_template is not None:
            outline = report_outline.build_outline_from_template(
                cfg,
                research_q,
                lang,
                clarifications if clarify_state == "answered" else "",
                report_template,
                gate_usage,
                attachments=outline_attachments,
            )
        else:
            outline = report_outline.build_outline(
                cfg,
                research_q,
                lang,
                clarifications if clarify_state == "answered" else "",
                gate_usage,
                attachments=outline_attachments,
            )
        if outline is None:
            logger.info("zjsearch_ai_search: report outline gate failed -- falling back to the single write")
    state = Searches(
        sxng_request.preferences,
        list(sxng_request.user_plugins),
        sources_base,
        search_language=raw_search_language,
        max_rounds=max_rounds,
        user_memories=user_memories,
        past_research_entries=past_research_entries,
        lang=lang,
        cfg=cfg,
    )
    state.question_held = research_q
    if resume is not None:
        # the dead attempt's [n] registry rejoins the run: a repeat of a
        # known url reuses ITS number (no duplicate source), the page-dedup
        # and the writers' citation identity carry over -- the transcript
        # references [n]s only these seeds can resolve
        for item in resume["sources"]:
            norm = reader.normalize_url(item["url"])
            if not norm or state.reg.known(norm) is not None:
                continue
            state.reg.note_url(norm, item["n"])
            state.reg.note_meta(norm, item["title"], "")
    # the loop-side gates (the entity gate's extraction) append to the SAME
    # list the settle's gates bucket folds
    state.gate_usage = gate_usage
    state.attached_files = [
        {"name": str(f.get("name") or "attachment"), "text": str(f.get("text") or "")} for f in (attached_files or [])
    ]
    if outline:
        # the outline's deliverable-entity screen: entities no section
        # researches become the researcher's <deliverable_entities> block
        # and plan_review's plan_complete question
        state.deliverable_entities = report_outline.uncovered_entities(outline)
        outline_entry = {
            "purpose": "outline",
            "question": "The report skeleton: sections and the deliverable entities they cover",
            "target": str(outline["title"])[:120],
            "sections": len(outline["sections"]),
            "entities": len(outline.get("entities") or []),
            "uncovered": len(state.deliverable_entities),
            "ms": 0,
        }
    else:
        outline_entry = None
    # the PRE-FLIGHT verdicts surface BEFORE the loop's first event (the
    # 决策结果 card opens with them): the clarify pre-screen, the depth
    # probe and the outline gate -- each already judged while the client
    # watched the boot skeleton
    preflight = [entry for entry in (pre_entry, depth_probe_entry, outline_entry) if entry]
    if depth_probe_entry:
        state.judgments.append(depth_probe_entry)
    if outline_entry:
        state.judgments.append(outline_entry)
    # the clarify pre-screen's spend + verdict join the run's account (the
    # awaiting path passes the same two straight to its own _Ndjson)
    if pre_usage.get("calls"):
        state.decision_usage["calls"] += pre_usage["calls"]
        state.decision_usage["tokens"] += pre_usage["tokens"]
    if pre_entry:
        state.judgments.append(pre_entry)

    past_ref: list[dict[str, t.Any]] = []

    def _take_template() -> dict[str, t.Any] | None:
        """The rail's 输出结构 channel: consume the ControlBox's pending
        template and RE-MINT the outline from it right here (the same
        adaptation gate the route-time outline used -- question, clarified
        direction and attachment heads all apply).  ``None`` = no pick."""
        if handle is None:
            return None
        template = handle.control.take_template()
        if template is None:
            return None
        return report_outline.build_outline_from_template(
            cfg,
            research_q,
            lang,
            clarifications if clarify_state == "answered" else "",
            template,
            gate_usage,
            attachments=outline_attachments,
            prior_topics=prior_topics,
        )

    def assign_past_sources() -> list[dict[str, t.Any]]:
        """Number the recalled past-research sources AFTER the live feed's
        final [n] (idempotent: the pre-write sources event and the writer
        prompt share one assignment).  A url the researcher already
        numbered (a ``past_research`` tool match, a re-read) keeps ITS
        number -- the same page never rides two [n] labels."""
        if not past_sources:
            return []
        if not past_ref:
            for item in past_sources:
                if state.reg.known(reader.normalize_url(item["url"])) is not None:
                    continue
                past_ref.append({**item, "n": state.next_n, "history": True})
                state.next_n += 1
        return past_ref

    async def write(halt: str | None) -> list[dict[str, t.Any]]:
        return writer_messages(
            research_q,
            lang,
            history,
            state.feed,
            mode,
            halt,
            state.round_no >= max_rounds,
            sources_base,
            galleries_on=bool(state.reg.gallery_pool),
            past_sources=assign_past_sources(),
            relevance=await _relevance_order(research_q, state.feed, usage=state.rerank_usage),
            learnings=state.facts,
            gaps=state.gaps,
        )

    def continuation() -> str | None:
        # the ledger-closure contract: a run may stop researching only
        # when BOTH open lists are empty -- otherwise the note names them
        # and the loop runs another turn (the loop caps the nudges)
        tasks, gaps = state.ledger_open_items()
        return continuation_note(tasks, gaps) if tasks or gaps else None

    def gallery_validator(body: str) -> list[dict[str, t.Any]]:
        """The zjs-images fence body -> validated gallery items: every URL
        must be verbatim from the run's image registry (the writer's
        prompt says never invent one; this is the enforcement)."""
        value = parse_fence_json(body)
        urls = value if isinstance(value, list) else []
        items: list[dict[str, t.Any]] = []
        for url in urls[:4]:
            n = state.reg.gallery_pool.get(str(url or ""))
            if n is not None:
                items.append({"u": str(url), "n": n})
        return items

    # THE RUN HOST: the handle exists BEFORE the loop generator (the
    # loop's control hooks close over it) -- the loop then executes on a
    # driver thread, events publish into the handle and this response
    # degrades into the first SUBSCRIBER -- a dropped connection detaches
    # instead of killing the run (reattach with X-Zjs-Run-Id + after_seq:
    # the same run), and a detached run wraps gracefully once its grace
    # window lapses
    handle = run_host.register(budget("detach_grace", mode, run_host.GRACE_DEFAULT))

    if resume is not None:
        # THE CONTINUE REPLAY: the dead attempt's exact conversation (its
        # ctx checkpoints, thinking blocks stripped) + the continuation
        # note -- the loop resumes the transcript where it stopped instead
        # of building a fresh first turn
        research_messages: list[dict[str, t.Any]] = [
            *resume["messages"],
            {"role": "user", "content": RESUME_NOTE},
        ]
    else:
        research_messages = initial_messages(
            research_q,
            lang,
            history,
            sources_base,
            mode,
            max_rounds=max_rounds,
            clarifications=clarifications if clarify_state == "answered" else "",
            clarify_skipped=clarify_state == "skipped",
            register_ask=True,
            page_tool=pages_on,
            task_tool=register_tasks,
            browser_tool=browser_on,
            steerable=handle is not None,
            # delegation gate: the depth probe's rung decides -- deep runs
            # delegate from rung 2 (the heavy tool for a clearly heavy
            # question), balanced from rung 4 (the comparison question with
            # genuinely independent facets earns it too); the old
            # deep-only rung-3 gate made delegation nearly unreachable
            subagent_tool=(mode == "deep" and depth_rung >= 2) or (mode == "balanced" and depth_rung >= 4),
            depth_rung=depth_rung,
            user_memories=user_memories,
            image_parts=image_parts or None,
            attached_files=attached_files or None,
            deliverable_entities=state.deliverable_entities,
        )

    events = engine.run(
        cfg,
        research_messages,
        tools=[tool_spec(pages_on, browser_on), calculator_spec(), user_memory_spec(), learnings_spec()]
        + (
            [system_one_spec()]
            if decision.enabled() and decision.configured() and decision.sdk_missing() is None
            else []
        )
        + ([past_research_spec()] if past_research_entries else [])
        + ([page_spec()] if pages_on else [])
        + ([web_browser_tool.web_browser_spec()] if browser_on else [])
        + [ask_user_spec()]
        + ([task_write_spec()] if register_tasks else [])
        + ([extract_spec()] if outline is not None else [])
        + (
            [research_subtask_spec()]
            if (mode == "deep" and depth_rung >= 2) or (mode == "balanced" and depth_rung >= 4)
            else []
        )
        + [view_image_spec()]
        + mcp_tools,
        executor=state.execute,
        post_round_injections=state.drain_image_injections,
        max_rounds=max_rounds,
        round_progress=round_progress(state, budget("stall_rounds", mode, 2), budget("max_seconds", mode, 0)),
        continuation=continuation,
        pre_write=state.evidence_check,
        ask_tool=ASK_TOOL,
        ask_shape=_ask_shape,
        display=lambda calls: [display_item(idx, call) for idx, call in enumerate(calls, 1)],
        **(
            {
                "synthesizer": report_synth.make_synthesizer(
                    cfg, state, outline, research_q, lang, gate_usage, take_template=_take_template
                ),
                "writer": None,
            }
            if outline is not None
            else {"writer": write}
        ),
        writer_sources=assign_past_sources,
        gallery_validator=gallery_validator,
        control=handle,
        entry_base=resume["entry_base"] if resume else 0,
        round_base=resume["round_base"] if resume else 0,
    )
    # the run host's DRIVER thread pulls the loop into the handle; the
    # settle's usage merges at generation (the executor's usage dicts are
    # final), the late work trails it -- a detached client costs neither
    tail = _SettleTail(
        cfg,
        research_q,
        lang,
        gate_usage,
        rerank_usage=state.rerank_usage,
        decision_usage=state.decision_usage,
        judgments=state.judgments,
        known_memories_fn=lambda: [str(m.get("content") or "") for m in user_memories] + state.saved_memories,
        outline_title=str(outline["title"]) if outline else None,
    )
    driver = threading.Thread(
        target=_drive,
        args=(
            handle,
            events,
            tail,
            [{"e": "decisions", "items": preflight}] if preflight else None,
        ),
        daemon=True,
        name="zjsearch-run-driver",
    )
    driver.start()
    response = _hosted_response(handle)
    if response.status_code == 502 and image_parts and not degraded:
        # the transport rejected the multimodal turn (a text-only model, a
        # vision-less gateway): the WHOLE run retries as text-only -- the
        # question itself never needed the images to be answerable.  The
        # orphaned run gets the stop instruction (its current turn runs
        # out, then the research closes without a writer).
        handle.control.stop()
        logger.warning("zjsearch_ai_search: multimodal request rejected -- retrying text-only")
        return _search(degraded=True)
    return response


def _respond(stream: "_Ndjson") -> flask.Response:
    """Prime the stream (proving the upstream alive) and answer: a dead
    upstream gets the plain-text 502 with its truncated reason."""
    try:
        stream.prime()
    except _UpstreamDead as dead:
        return http.upstream_error_response("error", str(dead))
    return http.streaming_response(iter(stream), "application/x-ndjson")


def _clarify_events(gate: dict[str, t.Any]) -> t.Iterator[dict[str, t.Any]]:
    """The clarify-gate run: the ask event then the settle -- a run that
    settles as ``awaiting`` (the user's answers travel on the next
    request).  The SAME wire event set as every other run."""
    yield {"e": "ask", **gate}
    yield wire.settle("awaiting", halt="awaiting the user's direction")


class _SettleTail:
    """The settle's usage merge (the gates/rerank/decision buckets plus
    the judgments) and the LATE post-settle work (the related fallback
    completion and the memory extraction, both suppressed on an
    ``awaiting`` run).  One definition, two consumers: the request-thread
    ``_Ndjson`` (the short clarify / no-research streams) and the run
    host's DRIVER thread (research runs -- the merge must happen at the
    settle's GENERATION point there, because the executor's usage dicts
    are only final once the loop is done, and a detached client must not
    cost the late work)."""

    def __init__(  # pylint: disable=too-many-arguments
        self,
        cfg: dict[str, t.Any],
        question: str,
        lang: str,
        gate_usage: list[dict[str, t.Any]],
        rerank_usage: dict[str, int] | None = None,
        decision_usage: dict[str, int] | None = None,
        judgments: list[dict[str, t.Any]] | None = None,
        known_memories_fn: t.Callable[[], list[str]] | None = None,
        outline_title: str | None = None,
    ):
        self.cfg = cfg
        self.question = question
        # the report's own title (the writer-side outline editor's) -- the
        # title pass's candidate when no fence title rode the answer
        self.outline_title = outline_title or None
        self.lang = lang
        self.gate_usage = gate_usage
        # the executor's rerank-model account (a LIVE dict -- the settle
        # reads it after the run's searches have mutated it)
        self.rerank_usage = rerank_usage
        # the decision model's account, same live-dict pattern
        self.decision_usage = decision_usage
        # the judgment ledger (the executor's structured verdicts) -- the
        # settle carries it verbatim so the knowledge base's run meta is
        # the one explainable record of every decision
        self.judgments = judgments if judgments is not None else []
        # the near-dup gate's comparison set for the memory extraction,
        # resolved LAZILY (the run's own saves land while the loop streams)
        self.known_memories_fn = known_memories_fn

    def merged_settle(self, event: dict[str, t.Any]) -> dict[str, t.Any]:
        """The settle with the GATES' token account folded into its usage:
        ``usage.gates = {input, output, calls}`` -- the client's meta row
        renders the whole flow, gates included.  The RERANK bucket forces
        the fold too: a transport that reports no usage (or a writer that
        died) must not silently drop the ranking cascade's spend."""
        usage = event.get("usage")
        rerank_spend = bool(self.rerank_usage and self.rerank_usage.get("calls"))
        decision_spend = bool(self.decision_usage and self.decision_usage.get("calls"))
        if self.gate_usage or isinstance(usage, dict) or rerank_spend or decision_spend:
            usage = (
                dict(usage)
                if isinstance(usage, dict)
                else {
                    "input": 0,
                    "output": 0,
                    "thoughts": None,
                    "cached": 0,
                    "cache_write": 0,
                }
            )
            usage["gates"] = self.gates_sum()
            rerank = self.rerank_usage
            if rerank and rerank.get("calls"):
                # the ranking cascade's endpoint spend, its own bucket (the
                # model stats page sums it separately from the LLM tokens)
                usage["rerank"] = {"calls": int(rerank["calls"]), "tokens": int(rerank.get("tokens") or 0)}
            decision_spend = self.decision_usage
            if decision_spend and decision_spend.get("calls"):
                # the system_one delegations' spend, its own bucket beside
                # the rerank one (input-only -- the decision model does
                # not generate)
                usage["decision"] = {
                    "calls": int(decision_spend["calls"]),
                    "tokens": int(decision_spend.get("tokens") or 0),
                }
            event = {**event, "usage": usage}
        if self.judgments:
            event = {**event, "judgments": self.judgments}
        return event

    def _title_pass(self, answer: str, fence_title: str | None) -> str | None:
        """The thread title's UNIFIED generation path, all three modes:
        the candidate is the WRITER's own fence title (every single-write
        answer carries one) or the report's outline title -- ONE decision
        noul judges it (a short specific subject noun phrase?); GOOD
        keeps it (the common case: no extra call), BAD or MISSING falls
        to one small generation completion.  Fail-open everywhere: a dead
        decision model or transport leaves the client's mechanical derive
        standing."""
        candidate = fence_title or self.outline_title
        if candidate and decision.enabled() and decision.configured():
            try:
                out = decision.judge(
                    {"question": self.question[:500], "title": candidate},
                    {
                        "good_title": {
                            "type": "noul",
                            "instructions": (
                                "Is this a good THREAD TITLE: a short, specific noun phrase naming the"
                                " research subject (in the question's language; not a generic label like"
                                " 'report' or 'research', not a question, no quotes or trailing"
                                " punctuation)?"
                            ),
                        }
                    },
                    timeout=5.0,
                )
                answers = out.get("answers") if isinstance(out, dict) else None
                verdict = answers.get("good_title") if isinstance(answers, dict) else None
                usage = out.get("usage") if isinstance(out.get("usage"), dict) else {}
                if self.decision_usage is not None and usage.get("input_tokens"):
                    self.decision_usage["calls"] += 1
                    self.decision_usage["tokens"] += int(usage.get("input_tokens") or 0)
                if isinstance(verdict, dict) and float(verdict.get("noul") or 0.0) >= 0.6:
                    return candidate
            except Exception as exc:  # pylint: disable=broad-except
                logger.debug("zjsearch_ai_search: title gate skipped: %r", exc)
        elif candidate:
            # the decision model is off: an existing writer/outline title
            # stands (no gate, no spend)
            return candidate
        try:
            return generate_title(self.cfg, self.question, answer, self.lang, self.outline_title, self.gate_usage)
        except Exception as exc:  # pylint: disable=broad-except
            logger.debug("zjsearch_ai_search: title generation failed: %r", exc)
            return None

    def late_events(  # pylint: disable=too-many-branches
        self, answer: str, awaiting: bool, related_seen: bool, fence_title: str | None = None
    ) -> t.Iterator[dict[str, t.Any]]:
        """The LATE events after the settle: the TITLE pass (decision-gate
        the writer's own fence title; regenerate only when it fails), the
        related fallback and the memory extraction (related/memory
        suppressed on an awaiting run), then the trailing usage event
        with the absolute gates sum."""
        if awaiting or not answer:
            return
        title = self._title_pass(answer, fence_title)
        if title:
            yield {"e": "title", "text": title}
        if not related_seen:
            # the post-settle fallback: the small completion generates the
            # follow-up suggestions the writer's fence skipped (it can
            # think for the better part of a minute -- that is why the
            # fence is the fast path and this trails the settle)
            try:
                found = related_questions(self.cfg, self.question, answer, self.lang, self.gate_usage)
            except Exception as exc:  # pylint: disable=broad-except
                logger.warning("zjsearch_ai_search: related fallback failed: %r", exc)
                found = []
            if found:
                yield {"e": "related", "items": found}
        try:
            known = self.known_memories_fn() if self.known_memories_fn else None
            facts, tags = extract_insights(self.cfg, self.question, answer, self.gate_usage, known=known)
            for fact in facts:
                yield {"e": "memory", "content": fact}
            if tags:
                # the tag graph's semantic layer: the client parks these on
                # the run, its settle writes them into the projections
                yield {"e": "tags", "items": tags}
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_ai_search: memory extraction failed: %r", exc)
        if self.gate_usage:
            # the trailing completions' spend: the absolute gates sum
            # replaces the settle's bucket (idempotent -- the client sets
            # it), so the WHOLE flow stays accounted
            yield {"e": "usage", "gates": self.gates_sum()}

    def gates_sum(self) -> dict[str, t.Any]:
        return {
            "input": sum(int(g.get("input") or 0) for g in self.gate_usage),
            "output": sum(int(g.get("output") or 0) for g in self.gate_usage),
            "calls": len(self.gate_usage),
        }


class _Ndjson:  # pylint: disable=too-few-public-methods
    """The loop's timeline ops as NDJSON lines, with the LATE work after
    the settle -- the request-thread shape for the SHORT streams (the
    clarify gate, the no-research single write).  Research runs go
    through the run host's driver instead (see :py:func:`_drive`)."""

    def __init__(  # pylint: disable=too-many-arguments
        self,
        events: t.Iterator[dict[str, t.Any]],
        cfg: dict[str, t.Any],
        question: str,
        lang: str,
        gate_usage: list[dict[str, t.Any]],
        rerank_usage: dict[str, int] | None = None,
        decision_usage: dict[str, int] | None = None,
        judgments: list[dict[str, t.Any]] | None = None,
        preamble: list[dict[str, t.Any]] | None = None,
        known_memories_fn: t.Callable[[], list[str]] | None = None,
    ):
        self.events = events
        self.tail = _SettleTail(
            cfg,
            question,
            lang,
            gate_usage,
            rerank_usage=rerank_usage,
            decision_usage=decision_usage,
            judgments=judgments,
            known_memories_fn=known_memories_fn,
        )
        # events that precede the loop's own stream (the depth probe runs
        # BEFORE the executor exists) -- flushed first when iterating
        self.preamble = [wire.encode(e) for e in (preamble or [])]
        self.buffer: list[str] = []
        self.rest: t.Iterator[str] | None = None
        self.primed = False

    def _merged_settle(self, event: dict[str, t.Any]) -> dict[str, t.Any]:
        return self.tail.merged_settle(event)

    def prime(self) -> None:
        """Pull events until the upstream proves alive (or dies): the
        buffered lines replay first when the stream iterates."""
        answer_parts: list[str] = []
        awaiting = False
        related_seen = False
        for event in self.events:
            kind = event.get("e")
            if kind == "settle":
                if str(event.get("status") or "") == "error":
                    raise _UpstreamDead(str(event.get("halt") or "upstream returned an empty stream"))
                merged = self._merged_settle(event)
                self.buffer.append(wire.encode(merged))
                self.rest = self._late("".join(answer_parts).strip(), awaiting, related_seen)
                self.primed = True
                return
            if kind == "answer":
                answer_parts.append(str(event.get("t") or ""))
            elif kind == "section":
                answer_parts.append(str(event.get("t") or ""))
            elif kind == "related":
                related_seen = True
            elif kind == "ask":
                awaiting = True
            # EVERY pre-content event buffers (the phase spine's "plan"
            # precedes the first entry -- dropping it here would blind the
            # strip to the run's opening stage); the content check only
            # decides when the lazy tail takes over
            self.buffer.append(wire.encode(event))
            if kind in _CONTENT_EVENTS:
                self.rest = self._to_settle(answer_parts, awaiting, related_seen)
                self.primed = True
                return

    def _to_settle(self, answer_parts: list[str], awaiting: bool, related_seen: bool) -> t.Iterator[str]:
        """The events after the first content one, up to and including the
        settle -- then the late work."""
        settle_event: dict[str, t.Any] | None = None
        for event in self.events:
            kind = event.get("e")
            if kind == "settle":
                settle_event = event
                break
            if kind == "answer":
                answer_parts.append(str(event.get("t") or ""))
            if kind == "section":
                answer_parts.append(str(event.get("t") or ""))
            if kind == "ask":
                awaiting = True
            if kind == "related":
                related_seen = True
            yield wire.encode(event)
        if settle_event is None:
            # the loop guarantees exactly one settle; a missing one is a
            # protocol bug -- fail loudly rather than hang the client
            raise _UpstreamDead("the run ended without a settle event")
        merged = self._merged_settle(settle_event)
        yield wire.encode(merged)
        yield from self._late("".join(answer_parts).strip(), awaiting, related_seen)

    def _late(self, answer: str, awaiting: bool, related_seen: bool) -> t.Iterator[str]:
        """The LATE events after the settle."""
        for event in self.tail.late_events(answer, awaiting, related_seen):
            yield wire.encode(event)

    def __iter__(self) -> t.Iterator[str]:
        yield from self.preamble
        if not self.primed:
            self.prime()
        yield from self.buffer
        if self.rest is not None:
            yield from self.rest


def _drive(  # pylint: disable=too-many-branches
    handle: run_host.RunHandle,
    events: t.Iterator[dict[str, t.Any]],
    tail: _SettleTail,
    preamble: list[dict[str, t.Any]] | None,
) -> None:
    """The run host's DRIVER thread: pull the loop's wire events into the
    run handle.  The settle's usage merges AT GENERATION (the executor's
    live usage dicts are final by then) and the LATE work runs right
    after -- a detached client costs neither.  The driver owns the
    handle's lifecycle: its finally marks the handle finished so every
    subscriber drains and exits, and a driver that dies without a settle
    publishes a synthetic one (no subscriber hangs)."""
    answer_parts: list[str] = []
    awaiting = False
    related_seen = False
    fence_title: str | None = None
    try:
        for event in preamble or []:
            handle.publish(event)
        for event in events:
            kind = event.get("e")
            if kind in ("answer", "section"):
                answer_parts.append(str(event.get("t") or ""))
            elif kind == "ask":
                awaiting = True
            elif kind == "related":
                related_seen = True
            elif kind == "title":
                fence_title = str(event.get("text") or "").strip()[:60] or None
            if kind == "settle":
                handle.publish(tail.merged_settle(event))
                for late in tail.late_events("".join(answer_parts).strip(), awaiting, related_seen, fence_title):
                    handle.publish(late)
                return
            handle.publish(event)
        handle.publish(wire.settle("error", halt="the run ended without a settle event"))
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_ai_search: the run driver failed: %s: %s", type(exc).__name__, str(exc)[:300])
        logger.warning("zjsearch_ai_search: driver traceback", exc_info=True)
        logger.warning("zjsearch_ai_search: last event repr: %s", repr(locals().get("event"))[:400])
        try:
            handle.publish(wire.settle("error", halt=f"the run driver failed: {exc}"))
        except Exception:  # pylint: disable=broad-except
            pass
    finally:
        handle.finish()


def _hosted_response(handle: run_host.RunHandle) -> flask.Response:
    """The research run's response FROM the run handle: prime from the
    subscription (a dead upstream still answers the plain-text 502),
    then stream the same subscription to the end.  The run key rides the
    ``X-Zjs-Run-Id`` response header -- the client's reattach handle for
    a dropped connection (the SAME run, never a restart).

    Priming consumes from ONE flattened queue -- the backlog first (the
    events published before we attached), then the live pulls -- and
    NEVER discards a pulled line: the pending list holds the batch tail
    while the content check decides."""
    sub = handle.subscribe(0)
    primed: list[str] = []
    pending: list[str] = list(sub.backlog)
    verdict = ""
    deadline = time.monotonic() + 300.0
    while not verdict:
        if pending:
            line = pending.pop(0)
        else:
            lines = handle.pull(sub, 0.5)
            if not lines:
                if handle.finished:
                    # the driver finished without any event at all -- a run
                    # that died before its first token
                    verdict = "upstream returned an empty stream"
                    break
                if time.monotonic() > deadline:
                    verdict = "the run produced no content in time"
                continue
            pending = lines
            continue
        primed.append(line)
        event = json.loads(line)
        kind = str(event.get("e") or "")
        if kind == "settle":
            if str(event.get("status") or "") == "error":
                verdict = str(event.get("halt") or "upstream returned an empty stream")
            else:
                # settled before any content event (an awaiting /
                # error-free empty run): the tail still streams
                verdict = "alive"
            break
        if kind in _CONTENT_EVENTS:
            verdict = "alive"
            break
        if time.monotonic() > deadline:
            verdict = "the run produced no content in time"
    if verdict != "alive":
        handle.unsubscribe(sub)
        return http.upstream_error_response("error", verdict)

    def rest() -> t.Iterator[str]:
        try:
            yield from primed
            while True:
                lines = handle.pull(sub)
                if lines:
                    yield from lines
                    continue
                if handle.finished:
                    return
        finally:
            handle.unsubscribe(sub)

    response = http.streaming_response(rest(), "application/x-ndjson")
    response.headers["X-Zjs-Run-Id"] = handle.key
    return response


def install(app: flask.Flask) -> None:
    """Register the AI Search route; chained from the package install.
    Stays off unless ``zjsearch.feature.ai_search.enabled`` and the shared
    transport are fully configured."""
    if not enabled():
        return
    if not llm_config.configured(llm_config.llm_cfg()):
        logger.warning("zjsearch.feature.ai_search is enabled but the transport is missing -- AI search stays off")
        return
    package = sdk_registry.sdk_missing(llm_config.llm_cfg())
    if package is not None:
        logger.warning(
            "zjsearch.feature.ai_search: the %r transport needs the %r package -- AI search stays off",
            llm_config.endpoint(llm_config.llm_cfg())[0],
            package,
        )
        return
    app.add_url_rule("/zjsearch/ai/search", "zjsearch_ai_search", _search, methods=["POST"])
