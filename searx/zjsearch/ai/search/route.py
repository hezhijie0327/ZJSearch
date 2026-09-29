# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``POST /ai/search`` route.

Thin by design (Vane's api.ts, Morphic's app/api/chat/route.ts): parse
and authorize the request, run the pre-flight gates, assemble the agent
loop with its tools / executor / writer, and hand the event stream to
the wire adapter.  All the mechanics live in the sibling modules.
"""

import itertools
import logging
import re
import typing as t

import flask

from searx.extended_types import sxng_request
from searx.zjsearch.ai import agent, http, llm
from searx.zjsearch.ai.capabilities import reader
from searx.zjsearch.ai.search.config import CLARIFY_MODES, PLAN_MODES, budget, enabled, SEARCH_MODES
from searx.zjsearch.ai.search.executor import Searches, round_progress
from searx.zjsearch.ai.search.gates import clarify_gate, research_gate, standalone_question
from searx.zjsearch.ai.search.prompts import initial_messages, writer_messages
from searx.zjsearch.ai.search.tools import (
    ASK_TOOL,
    PLAN_TOOL,
    ask_user_spec,
    page_spec,
    plan_spec,
    tool_spec,
)
from searx.zjsearch.ai.search.wire import clarify_stream, generate

logger = logging.getLogger(__name__)

_URL_RE = re.compile(r"https?://[^\s<>\"']+")


def _search() -> flask.Response:  # pylint: disable=too-many-branches, too-many-statements, too-many-locals
    """AI Search: the researcher/writer split on the shared agent loop."""
    cfg = llm.ai_cfg()
    payload, q, _ctx = http.authorize(gate=enabled() and llm.configured(cfg))
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
    max_rounds = budget("max_rounds", mode, 2)
    # the pre-flight gate (Vane's skipSearch, narrowed to our contract): a
    # question carrying a URL always researches (the page read IS the
    # research); everything else passes one small completion that skips
    # research only for greetings, chat and writing tasks
    research_needed = bool(_URL_RE.search(q)) or research_gate(cfg, q)
    # the clarify gate fires on the FIRST run of a gated mode only: a
    # follow-up's history already disambiguates the direction
    if research_needed and mode in CLARIFY_MODES and clarify_state == "ask" and not history:
        gate = clarify_gate(cfg, q, lang, mode)
        if gate:
            return http.streaming_response(clarify_stream(gate), "application/x-ndjson")
    # the page reader rides only when the reader (zjsearch.ai.browserless) block is fully
    # configured: an unconfigured reader simply leaves the tool unregistered
    pages_on = reader.configured()
    plans: list[str] = []
    if not research_needed:
        # the no-research run: the writer alone -- the zero-tool case of the
        # shared loop (one streamed turn whose prose IS the answer, no
        # executor, no rounds).  The `direct` marker event tells the client
        # to hide the research box for this run.
        state = Searches(
            sxng_request.preferences, list(sxng_request.user_plugins), sources_base, search_language=raw_search_language
        )
        events: t.Iterator[tuple[str, t.Any]] = itertools.chain(
            (("direct", None),),
            agent.run_agent(
                cfg,
                writer_messages(q, lang, history, [], [], mode, None, False, sources_base, direct=True),
            ),
        )
    else:
        # the mid-run ask_user escape hatch rides ONLY a first run of the
        # gated modes whose gate passed on asking: if the gate already asked
        # (state=answered) or the user skipped, the direction is settled
        register_ask = mode in CLARIFY_MODES and clarify_state == "ask"
        # the answer-planning tool rides every run of the structured tiers
        register_plan = mode in PLAN_MODES
        # the follow-up rewrite (Vane's standalone follow-up): a
        # thread-relative question becomes self-contained before it drives
        # research and writer (the thread still shows the user's own
        # wording; fail-open to the original on any gate failure)
        research_q = (standalone_question(cfg, q, history, lang) if history else "") or q
        state = Searches(
            sxng_request.preferences,
            list(sxng_request.user_plugins),
            sources_base,
            search_language=raw_search_language,
            max_rounds=max_rounds,
        )
        events = agent.run_agent(
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
                register_ask=register_ask,
                page_tool=pages_on,
                plan_tool=register_plan,
            ),
            tools=[tool_spec(pages_on)]
            + ([page_spec()] if pages_on else [])
            + ([ask_user_spec()] if register_ask else [])
            + ([plan_spec()] if register_plan else []),
            executor=state.execute,
            max_rounds=max_rounds,
            round_progress=round_progress(state, budget("stall_rounds", mode, 2)),
            ask_tool=ASK_TOOL if register_ask else None,
            plan_tool=PLAN_TOOL if register_plan else None,
            writer=lambda halt: writer_messages(
                research_q,
                lang,
                history,
                state.feed,
                plans,
                mode,
                halt,
                state.round_no >= max_rounds,
                sources_base,
                galleries_on=bool(state.gallery_pool),
            ),
        )
    try:
        first = next(events)
    except StopIteration:
        # an upstream that answers 200 with zero events (empty gateways do)
        first = ("error", RuntimeError("upstream returned an empty stream"))
    if first[0] == "error":
        logger.warning("zjsearch_ai_search: upstream failed before the first line: %s", first[1])
        return http.upstream_error_response(*first)
    # the executor serializes results through Jinja -- keep the request
    # context alive while the response streams
    return http.streaming_response(generate(first, events, cfg, q, lang, plans, state), "application/x-ndjson")


def install(app: flask.Flask) -> None:
    """Register the AI Search route; chained from the package install.
    Stays off unless ``zjsearch.ai.search.enabled`` and the shared
    transport are fully configured."""
    if not enabled():
        return
    if not llm.configured(llm.ai_cfg()):
        logger.warning("zjsearch.ai.search is enabled but the transport is missing -- AI search stays off")
        return
    package = llm.sdk_missing(llm.ai_cfg())
    if package is not None:
        logger.warning(
            "zjsearch.ai.search: the %r transport needs the %r package -- AI search stays off",
            llm.endpoint(llm.ai_cfg())[0],
            package,
        )
        return
    app.add_url_rule("/ai/search", "zjsearch_ai_search", _search, methods=["POST"])
