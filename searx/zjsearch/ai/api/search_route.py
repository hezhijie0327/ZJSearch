# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``POST /zjsearch/ai/search`` route.

Thin by design (Vane's api.ts, Morphic's app/api/chat/route.ts): parse
and authorize the request, run the pre-flight gates, assemble
:py:func:`framework.loop.run` with its tools / executor / writer, and
encode the timeline ops as NDJSON.  All the mechanics live in the
sibling modules.  After the loop's ``settle``, only two LATE events may
follow -- the related-questions fallback completion and the memory
extraction -- both suppressed on an ``awaiting`` run.  A run that
settles as an error BEFORE any content event becomes the plain-text 502
(prime before streaming, so the status code is honest).
"""

import logging
import re
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
from searx.zjsearch.ai.runs.search.progress import continuation_note, round_progress
from searx.zjsearch.ai.runs.search.gates import (
    clarify_gate,
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
        sources_base = min(abs(int(payload.get("sources_base"))), 200)
    except (TypeError, ValueError):
        sources_base = 0
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
    # the REPORT shape: an outline-driven, per-section document -- only
    # for the deep modes (the ladder rung still sizes the research), and
    # always subject to the outline gate (a malformed skeleton falls back
    # to the single-write answer shape below)
    report_requested = bool(payload.get("report")) and mode in ("balanced", "deep")
    max_rounds = budget("max_rounds", mode, 2)
    depth_probe_entry: dict[str, t.Any] | None = None
    # the pre-flight gate (Vane's skipSearch, narrowed to our contract): a
    # question carrying a URL always researches (the page read IS the
    # research); everything else passes one small completion that skips
    # research only for greetings, chat and writing tasks
    research_needed = bool(_URL_RE.search(q)) or research_gate(cfg, q, gate_usage)
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
    if report_requested:
        outline = report_outline.build_outline(
            cfg, research_q, lang, clarifications if clarify_state == "answered" else "", gate_usage
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
    if depth_probe_entry:
        state.judgments.append(depth_probe_entry)
    # the clarify pre-screen's spend + verdict join the run's account (the
    # awaiting path passes the same two straight to its own _Ndjson)
    if pre_usage.get("calls"):
        state.decision_usage["calls"] += pre_usage["calls"]
        state.decision_usage["tokens"] += pre_usage["tokens"]
    if pre_entry:
        state.judgments.append(pre_entry)

    past_ref: list[dict[str, t.Any]] = []

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
            relevance=await _relevance_order(research_q, state.feed),
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

    events = engine.run(
        cfg,
        initial_messages(
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
            user_memories=user_memories,
            image_parts=image_parts or None,
            attached_files=attached_files or None,
        ),
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
                "synthesizer": report_synth.make_synthesizer(cfg, state, outline, research_q, lang, gate_usage),
                "writer": None,
            }
            if outline is not None
            else {"writer": write}
        ),
        writer_sources=assign_past_sources,
        gallery_validator=gallery_validator,
    )
    response = _respond(
        _Ndjson(
            events,
            cfg,
            research_q,
            lang,
            gate_usage,
            state.rerank_usage,
            state.decision_usage,
            state.judgments,
            (
                [
                    {
                        "e": "decisions",
                        "items": [depth_probe_entry],
                    }
                ]
                if depth_probe_entry
                else None
            ),
            known_memories_fn=lambda: [str(m.get("content") or "") for m in user_memories] + state.saved_memories,
        )
    )
    if response.status_code == 502 and image_parts and not degraded:
        # the transport rejected the multimodal turn (a text-only model, a
        # vision-less gateway): the WHOLE run retries as text-only -- the
        # question itself never needed the images to be answerable
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


class _Ndjson:  # pylint: disable=too-few-public-methods
    """The loop's timeline ops as NDJSON lines, with the LATE work after
    the settle: the related-questions fallback completion (when the
    writer skipped the in-stream fence) and the memory extraction -- both
    suppressed on an ``awaiting`` run."""

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
        self.cfg = cfg
        self.question = question
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
        # events that precede the loop's own stream (the depth probe runs
        # BEFORE the executor exists) -- flushed first when iterating
        self.preamble = [wire.encode(e) for e in (preamble or [])]
        self.buffer: list[str] = []
        self.rest: t.Iterator[str] | None = None
        self.primed = False

    def _merged_settle(self, event: dict[str, t.Any]) -> dict[str, t.Any]:
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
            usage["gates"] = {
                "input": sum(int(g.get("input") or 0) for g in self.gate_usage),
                "output": sum(int(g.get("output") or 0) for g in self.gate_usage),
                "calls": len(self.gate_usage),
            }
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
        """The LATE events after the settle: the related fallback and the
        memory extraction (both suppressed on an awaiting run)."""
        if awaiting or not answer:
            return
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
                yield wire.encode({"e": "related", "items": found})
        try:
            known = self.known_memories_fn() if self.known_memories_fn else None
            facts, tags = extract_insights(self.cfg, self.question, answer, self.gate_usage, known=known)
            for fact in facts:
                yield wire.encode({"e": "memory", "content": fact})
            if tags:
                # the tag graph's semantic layer: the client parks these on
                # the run, its settle writes them into the projections
                yield wire.encode({"e": "tags", "items": tags})
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_ai_search: memory extraction failed: %r", exc)
        if self.gate_usage:
            # the trailing completions' spend: the absolute gates sum
            # replaces the settle's bucket (idempotent -- the client sets
            # it), so the WHOLE flow stays accounted
            yield wire.encode({"e": "usage", "gates": self._gates_sum()})

    def _gates_sum(self) -> dict[str, t.Any]:
        return {
            "input": sum(int(g.get("input") or 0) for g in self.gate_usage),
            "output": sum(int(g.get("output") or 0) for g in self.gate_usage),
            "calls": len(self.gate_usage),
        }

    def __iter__(self) -> t.Iterator[str]:
        yield from self.preamble
        if not self.primed:
            self.prime()
        yield from self.buffer
        if self.rest is not None:
            yield from self.rest


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
