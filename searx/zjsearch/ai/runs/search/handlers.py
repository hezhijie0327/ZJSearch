# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search executor: the TOOL DISPATCH.

:class:`DispatchMixin` owns :py:meth:`execute` -- one round of model
calls turned into tool executions and wire events -- plus the per-call
plan builder (``_search_plan``: the dedup key, the pool job and the
receipt scaffolding) and the decision-model verdict formatting.  Meta
tools (calculate, ledger writes, MCP, memory) run INLINE; the network
jobs (``search_web``) defer to :py:mod:`.gather`'s pool -- the browse
tool is the serialized session lane (open -> read, tabs, viewport)."""

import concurrent.futures
import logging
import time
import typing as t


from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.runs import attachments as uploads_fetch
from searx.zjsearch.ai.tools import search_tools
from searx.zjsearch.ai.tools import browse as browse_tool
from searx.zjsearch.ai.tools.browse import read as reader
from searx.zjsearch.ai.tools import calculate
from searx.zjsearch.ai.tools import calendar as calendar_tool
from searx.zjsearch.ai.tools import clock as clock_tool
from searx.zjsearch.ai.tools import recall_history as recall_history_cap
from searx.zjsearch.ai.tools import memory as memory_cap
from searx.zjsearch.ai.tools import list_engines as list_engines_tool
from searx.zjsearch.ai.tools import decode_code as decode_code_tool
from searx.zjsearch.ai.browser import session as browser_session
from searx.zjsearch.ai.tools import delegate_research as delegate_tool
from searx.zjsearch.ai.tools import message_subtask
from searx.zjsearch.ai.llm import decision
from searx.zjsearch.ai.runs.search import audit
from searx.zjsearch.ai.runs.search import entity_gate
from searx.zjsearch.ai.runs.search import recall as recall_slot
from searx.zjsearch.ai.runs.search.progress import (
    BUDGET_LAST_ROUND_NOTE,
    FEED_CONVERGE_NOTE,
    round_progress,
)
from searx.zjsearch.ai.runs.search.state import (
    ChildControl,
    SubagentHandle,
    state_block,
)
from searx.zjsearch.ai.runs.search.browser_dispatch import BrowserDispatchMixin
from searx.zjsearch.ai.runs.search.subagents import SubagentsMixin
from searx.zjsearch.ai.runs.report import outline as report_outline
from searx.zjsearch.ai.tools import (
    ASK_USER_TOOL,
    paid_bangs,
    INSPECT_IMAGE_TOOL,
    BROWSE_TOOL,
    DECODE_CODE_TOOL,
    EVALUATE_TOOL,
    RECORD_FINDINGS_TOOL,
    CALCULATE_TOOL,
    CALENDAR_TOOL,
    CLOCK_TOOL,
    parse_call,
    parse_record_findings_call,
    parse_query,
    parse_evaluate_call,
    parse_build_table_call,
    parse_plan_call,
    parse_inspect_image_call,
    parse_decode_code_call,
    parse_set_deliverable_call,
    BUILD_TABLE_TOOL,
    RECALL_HISTORY_TOOL,
    LIST_ENGINES_TOOL,
    SET_DELIVERABLE_TOOL,
    UPDATE_PLAN_TOOL,
    MEMORY_TOOL,
)

from searx.zjsearch.ai.core.text import raw_args
from searx.zjsearch.ai.runs.search.state import MAX_PARALLEL, _FEED_SOFT_LIMIT

logger = logging.getLogger(__name__)



def _score_level(answer: dict[str, t.Any]) -> str | None:
    """The score answer's nearest legend level: the wire's legend rides
    string keys, the typesafe family's own parse rides ints -- the
    lookup takes both (the round of the score names the level)."""
    try:
        key = int(round(float(answer.get("score") or 0)))
    except (TypeError, ValueError):
        return None
    legend = answer.get("legend") or {}
    level = legend.get(str(key))
    return level if level is not None else legend.get(key)


_TIME_FEED_CAP = 600
"""One time-tool digest line's ceiling -- the almanac's full block rides
the client card, the writer needs only the answer-bearing fields."""

def _time_tool_feed_line(tool_name: str, payload: dict[str, t.Any]) -> str:
    """One writer-feed digest line for a settled ``clock`` / ``calendar``
    payload -- the fields the FINAL ANSWER may quote (the instant, the
    target date's weekday/relation, the lunar line, the workday verdict,
    the scan's hits), English frame with the payload's own proper nouns
    verbatim.  The writer reads ``state.feed`` alone on researched tiers,
    so an instant-tool run loses its answer without this line."""
    zone = str(payload.get("timezone") or "the server's local clock")
    today = str(payload.get("today") or "")
    mode = str(payload.get("mode") or "")
    if tool_name == CLOCK_TOOL or mode == "now":
        moment = str(payload.get("time") or "")
        weekday = str(payload.get("weekday") or "")
        offset = str(payload.get("utc_offset") or "")
        return (
            f"From the run's clock tool (call-time answer, zone {zone}):"
            f" {weekday} {today} {moment} {offset}".strip()
        )[:_TIME_FEED_CAP]
    if mode == "date":
        target = str(payload.get("target") or "")
        # the TARGET's weekday (the payload's `weekday` is the zone ground,
        # TODAY's -- the target rides `target_weekday` since the collision
        # fix, the old key kept as the pre-fix payload's fallback)
        weekday = str(payload.get("target_weekday") or payload.get("weekday") or "")
        days = payload.get("days_from_today")
        relation = str(payload.get("relation") or "")
        lunar = payload.get("lunar") or {}
        lunar_line = ""
        if isinstance(lunar, dict) and lunar.get("month"):
            lunar_line = f"; lunar {lunar.get('year')}/{lunar.get('zodiac')} {lunar.get('month')}{lunar.get('day')}"
            workday = lunar.get("workday") or {}
            if isinstance(workday, dict) and workday.get("status"):
                lunar_line += f", statutory verdict {workday.get('status')}"
            if lunar.get("term"):
                lunar_line += f", solar term {lunar.get('term')}"
        return (
            f"From the run's calendar tool (zone {zone}): target {target}"
            f" is {weekday} ({relation}, {'+' if isinstance(days, int) and days >= 0 else ''}{days}d from today"
            f" {today}){lunar_line}".strip()
        )[:_TIME_FEED_CAP]
    if mode == "find":
        findings = payload.get("findings") or []
        hits = (
            "; ".join(f"{f.get('date')} ({', '.join(f.get('suited') or [])})" for f in findings[:10])
            if isinstance(findings, list)
            else ""
        )
        return (
            f"From the run's calendar tool (zone {zone}): auspicious scan for"
            f" {payload.get('activity')} over {payload.get('scanned_days')} days"
            f" -- {len(findings)} hit(s): {hits}".strip()
        )[:_TIME_FEED_CAP]
    if mode == "terms":
        terms = payload.get("terms") or []
        return (
            f"From the run's calendar tool (zone {zone}): the almanac's"
            f" activity vocabulary ({len(terms)} terms):"
            f" {', '.join(str(term) for term in terms[:40])}".strip()
        )[:_TIME_FEED_CAP]
    return f"From the run's {tool_name} tool (zone {zone}): today {today}".strip()[:_TIME_FEED_CAP]


PLAN_REMINDER_EVERY = 6
"""Rounds between task-card cadence reminders (B2)."""

_MAX_MODEL_SHOTS = 8
"""The per-run budget for browser screenshots injected into the model's
conversation (viewport + element close-ups share it) -- a captcha retry
loop must not turn the context into an image carousel."""


class DispatchMixin(BrowserDispatchMixin, SubagentsMixin):  # pylint: disable=no-member, too-few-public-methods
    def execute(  # pylint: disable=too-many-branches, too-many-statements, too-many-locals
        self, calls: list[dict[str, t.Any]]
    ) -> t.Iterator[tuple[str, t.Any]]:
        """Run one round of calls in parallel -- ``search_web`` and
        ``browse`` calls share the worker pool; feature events flow to
        the client while they complete.  Wire ids are the 1-based position
        of the call within this round.  Exact-duplicate queries and
        already-read pages settle instantly as ``duplicate`` -- they never
        hit the engines or the browser again; their feed tells the model
        to move on (the dedup marks are taken at COMPLETION: a failed
        search or read stays retryable).  EVERY ``call`` settlement carries
        the debug contract: ``ms`` (the call's wall time in milliseconds;
        pooled calls time submit -> settlement, inline branches time
        themselves) and ``feed`` (the head, 800 chars, of the exact
        tool-result text the model receives -- its receipt).  The round's
        tool results also carry the budget / context-pressure / progress
        notes: that is how the MODEL learns where the run stands (the
        static system prompt only states the policy once)."""
        self.round_no += 1
        rnd = self.round_no
        self.round_new_hits = 0
        feeds: list[str | None] = [None] * len(calls)
        judgment_mark = len(self.judgments)
        self.round_new_titles = []
        self.round_learned = False
        search_jobs: list[tuple[int, str, str, str, list[str], list[str], str]] = []
        browse_jobs: list[tuple[int, dict[str, t.Any]]] = []
        mcp_jobs: list[tuple[int, str, dict[str, t.Any]]] = []
        sub_jobs: list[tuple[int, dict[str, str]]] = []
        followup_jobs: list[tuple[int, dict[str, str]]] = []
        gathered = False
        for wire_id, call in enumerate(calls, 1):
            started = time.monotonic()
            tool_name = str(call.get("name") or "")
            if tool_name == ASK_USER_TOOL:
                # the ask intercept in the loop handles a SOLO ask call (the
                # prompted shape); one mixed into a parallel batch lands here
                # -- settle the row honestly instead of letting it fall
                # through to the search_web branch's empty-query error
                feed_text = (
                    "error: the ask_user tool must be the ONLY call of its turn -- ask again alone in the next turn."
                )
                feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "error",
                        "ms": int((time.monotonic() - started) * 1000),
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                    },
                )
                continue
            if tool_name == CALCULATE_TOOL:
                feed, event = calculate.run_call(call, rnd, wire_id)
                feeds[wire_id - 1] = feed
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": event.get("status", "ok"),
                        "result": event.get("result"),
                        "ms": int((time.monotonic() - started) * 1000),
                        "feed": feed[:800],
                        "raw": feed[:50_000],
                    },
                )
                continue
            if tool_name in (CALENDAR_TOOL, CLOCK_TOOL):
                # the clock (instant only) and the calendar (date lookups,
                # lunar/almanac, auspicious scan): instant local work (no
                # pool slot), anchored to the USER'S zone -- the payload
                # rides the event (key `calendar` for BOTH: the client's
                # row fold reads it) so the row renders the real value
                run = clock_tool.clock_run_call if tool_name == CLOCK_TOOL else calendar_tool.run_call
                feed, event = run(call, rnd, wire_id, self.tz)
                feeds[wire_id - 1] = feed
                # THE WRITER FEEDS TOO (the user_file precedent): a settled
                # payload also lands ONE digest line in the writer's
                # <context> -- an instant-tool run (a bare "what time is
                # it" whose only result is the clock, no sources) must not
                # lose the answer between the researcher and the writer,
                # which reads state.feed alone (<today> is date-only there
                # by design).  The digest is per-run turn content, so the
                # system prefix stays byte-stable.
                payload = event.get("calendar")
                if event.get("status") == "ok" and isinstance(payload, dict):
                    self.feed.append(_time_tool_feed_line(tool_name, payload))
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": event.get("status", "ok"),
                        "calendar": event.get("calendar"),
                        "ms": int((time.monotonic() - started) * 1000),
                        "feed": feed[:800],
                        "raw": feed[:50_000],
                    },
                )
                continue
            if tool_name == DECODE_CODE_TOOL:
                # the barcode payload from a public image URL -- text-only
                # read beside inspect_image (no injection, no vision spend)
                url = parse_decode_code_call(call)
                feed_text = decode_code_tool.run_call(url)
                feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "error" if feed_text.startswith("error") else "ok",
                        "ms": int((time.monotonic() - started) * 1000),
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                    },
                )
                continue
            if tool_name == LIST_ENGINES_TOOL:
                # the deployment inventory: instant read-only work (the
                # engine map is already in memory) -- the feed teaches the
                # model what this instance can search, the STRUCTURED
                # inventory rides the row's expanded body (category chips
                # + bang rows), n drives the metric
                feed_text, extras = list_engines_tool.run_call(raw_args(call))
                feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "ok",
                        "n": extras["n"],
                        "inventory": extras["inventory"],
                        "ms": int((time.monotonic() - started) * 1000),
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                    },
                )
                continue
            if tool_name == UPDATE_PLAN_TOOL:
                items = parse_plan_call(call)
                # the research plan: the orchestrator decomposes the request
                # into facets -- the task card tracks which facets have
                # sources, the researcher follows the plan step by step.
                # A re-write keeps the outgoing list's PROVENANCE (the
                # gathered-sources counts the round searches lit up) --
                # "keep the list TRUE" re-sends must not wipe the card's
                # evidence back to zero.
                self.coverage.carry_provenance(items)
                self.coverage.task_list = items
                # the plan REVIEW (fail-open): one decision pass per subtask -- the
                # weak ones get an early sharpen-note in the plan's feed
                self._plan_review(items)
                yield ("plan", {"round": rnd, "id": wire_id, "items": items})
                done = sum(1 for item in items if item["status"] == "done")
                summary = f"{done}/{len(items)}"
                # the row settles like every other (a plan write is instant
                # work -- leaving it pending read as interrupted at the settle)
                feed_text = f"""\
plan written: {done}/{len(items)} subtasks. Work the plan step by step;
statuses are yours to update (resend the complete list to revise it),
and the referee advises when a subtask's evidence runs thin."""
                if getattr(self, "weak_tasks", None):
                    feed_text += (
                        "\n(plan review: these subtasks look hard to research independently --"
                        " sharpen them into concrete searchable questions: "
                        + "; ".join(f'"{t}"' for t in self.weak_tasks[:3])
                        + ")"
                    )
                    self.weak_tasks = []
                if getattr(self, "entity_gap", None):
                    feed_text += (
                        "\n(plan review: the list does not yet cover these deliverable entities the"
                        " final answer makes claims about -- add a subtask or delegate a"
                        " delegate_research for each: " + "; ".join(self.entity_gap[:3]) + ")"
                    )
                    self.entity_gap = []
                # the deliverable-entity gate: ONCE per run, on the FIRST
                # plan write -- entities the final answer depends on but
                # no subtask covers become a feed note (the model closes
                # the gap itself); the referee's plan_complete question
                # keeps checking on later plan writes
                note = entity_gate.run_once(self, items)
                if note:
                    feed_text += note
                feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "ok",
                        "ms": int((time.monotonic() - started) * 1000),
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                    },
                )
                continue
            if tool_name == SET_DELIVERABLE_TOOL:
                # the deliverable flip: a CONTROL call in the paid-bang
                # family -- it flips the run's output shape and answers
                # with an acknowledgement; the document itself is written
                # at the write boundary (the route's synthesizer consumes
                # the minted skeleton).  No outline event here on purpose:
                # every report run's TOC lands at the write boundary, so
                # the flip run's timeline reads exactly like a native one.
                shape = parse_set_deliverable_call(call)
                if shape is None:
                    feed_text = (
                        'error: set_deliverable needs shape="report" (a written,'
                        ' section-structured document) or "deck" (a presentation'
                        " outline)."
                    )
                    feeds[wire_id - 1] = feed_text
                    yield (
                        "call",
                        {
                            "call": wire_id,
                            "status": "error",
                            "ms": int((time.monotonic() - started) * 1000),
                            "feed": feed_text[:800],
                            "raw": feed_text[:50_000],
                        },
                    )
                    continue
                peek_shape = getattr(self.run_control, "peek_shape", None)
                route_skeleton = self.route_outline is not None and (peek_shape is None or peek_shape() != "direct")
                if route_skeleton:
                    # the run already carries a route-time skeleton (and
                    # the reader has not taken it back to the direct
                    # answer): the structure is fixed, only the DIALECT
                    # may move -- the same control channel the reader's
                    # rail picker drives (temporal: a later reader pick
                    # still overwrites)
                    if self.run_control is not None:
                        self.run_control.set_shape(shape)
                    feed_text = (
                        f"this run already writes an outline-driven document; the"
                        f" {'deck' if shape == 'deck' else 'report'} dialect is noted for"
                        " the write phase. Keep researching -- the structure does not"
                        " change."
                    )
                    feeds[wire_id - 1] = feed_text
                    yield (
                        "call",
                        {
                            "call": wire_id,
                            "status": "ok",
                            "ms": int((time.monotonic() - started) * 1000),
                            "feed": feed_text[:800],
                            "raw": feed_text[:50_000],
                        },
                    )
                    continue
                outline = report_outline.build_outline(
                    self.cfg,
                    self.question_held,
                    self.lang,
                    self.clarified_direction,
                    account=self.account,
                    attachments=self.attached_files,
                    prior_topics=self.prior_topics,
                    deck=(shape == "deck"),
                    tz=self.tz,
                )
                if outline is None:
                    # fail-open: no skeleton, no flip -- the run keeps its
                    # direct-answer shape and the model learns it honestly
                    feed_text = (
                        "the outline gate could not mint a skeleton this time -- the"
                        " run keeps its direct-answer shape. Continue researching"
                        " normally; the answer will be written as usual."
                    )
                    feeds[wire_id - 1] = feed_text
                    yield (
                        "call",
                        {
                            "call": wire_id,
                            "status": "error",
                            "ms": int((time.monotonic() - started) * 1000),
                            "feed": feed_text[:800],
                            "raw": feed_text[:50_000],
                        },
                    )
                    continue
                self.flip_deliverable = {"outline": outline, "deck": shape == "deck"}
                feed_text = (
                    f"deliverable shape set to {shape}: an outline of"
                    f' {len(outline["sections"])} sections ("{outline["title"]}") was'
                    " minted. Keep researching exactly as planned -- every source you"
                    " gather is what the sections will cite; the document itself is"
                    " written at the write phase."
                )
                feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "ok",
                        "ms": int((time.monotonic() - started) * 1000),
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                    },
                )
                continue
            if tool_name == INSPECT_IMAGE_TOOL:
                # the researcher's eyes: fetch one result image and inject
                # it as the next round's user message
                url, source_n = parse_inspect_image_call(call)
                started_vi = time.monotonic()
                if not url:
                    feed_text = "error: inspect_image needs the img= URL copied verbatim from a source line."
                    feeds[wire_id - 1] = feed_text
                    yield (
                        "call",
                        {
                            "call": wire_id,
                            "status": "error",
                            "ms": int((time.monotonic() - started_vi) * 1000),
                            "feed": feed_text[:800],
                            "raw": feed_text[:50_000],
                        },
                    )
                    continue
                images_mode = str(self.cfg.get("images") or "base64").lower()
                if not uploads_fetch.check_image_url(url):
                    feed_text = f"error: refusing a non-public image URL: {url[:120]}"
                    feeds[wire_id - 1] = feed_text
                    yield (
                        "call",
                        {
                            "call": wire_id,
                            "status": "error",
                            "ms": int((time.monotonic() - started_vi) * 1000),
                            "feed": feed_text[:800],
                            "raw": feed_text[:50_000],
                        },
                    )
                    continue
                if images_mode == "url":
                    # URL passthrough: a public web image hands the
                    # reference to the endpoint to fetch itself (nothing
                    # lands on the server)
                    image_ref = url
                    how = "as a URL reference"
                else:
                    (fetched,) = uploads_fetch.fetch_image_data_urls([url])
                    if not fetched:
                        feed_text = "error: the image could not be fetched -- move on or re-run the search."
                        feeds[wire_id - 1] = feed_text
                        yield (
                            "call",
                            {
                                "call": wire_id,
                                "status": "error",
                                "ms": int((time.monotonic() - started_vi) * 1000),
                                "feed": feed_text[:800],
                                "raw": feed_text[:50_000],
                            },
                        )
                        continue
                    image_ref = fetched
                    how = "inline"
                label = f"source [{source_n}]" if source_n else url[:120]
                self.record_image_injection(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": f"Attached: the image from {label} ({how}). Read it now and factor what it shows into the research.",
                            },
                            {"type": "image_url", "image_url": {"url": image_ref}},
                        ],
                    }
                )
                feed_text = f"image attached ({how}) -- it is visible to you in the next turn ({label})."
                feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "ok",
                        "ms": int((time.monotonic() - started_vi) * 1000),
                        "preview": url[:600],
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                    },
                )
                continue
            if tool_name == BUILD_TABLE_TOOL:
                parsed = parse_build_table_call(call)
                if parsed is None:
                    feed_text = (
                        "error: build_table needs a title, 2+ columns and"
                        " at least one row -- a table the writer can cite."
                    )
                    feeds[wire_id - 1] = feed_text
                    yield (
                        "call",
                        {
                            "call": wire_id,
                            "status": "error",
                            "ms": int((time.monotonic() - started) * 1000),
                            "feed": feed_text[:800],
                            "raw": feed_text[:50_000],
                        },
                    )
                    continue
                self._artifact_seq += 1
                artifact = {"id": self._artifact_seq, **parsed}
                # per-row refs validation: drop any [n] not minted in this
                # run (the gallery whitelist's same trust model)
                valid_rows = []
                for row in artifact["rows"]:
                    refs = [ref for ref in row.get("refs") or [] if self.entries.get(ref)]
                    valid_rows.append({**row, "refs": refs})
                artifact["rows"] = valid_rows
                self.artifacts.append(artifact)
                lines = [
                    "| " + " | ".join(artifact["columns"]) + " |",
                    "|" + "---|" * len(artifact["columns"]),
                ]
                for row in artifact["rows"]:
                    cells = list(row["cells"]) + [""] * (len(artifact["columns"]) - len(row["cells"]))
                    cite = (" [" + ",".join(str(r) for r in row["refs"]) + "]") if row["refs"] else ""
                    lines.append("| " + " | ".join(cells) + cite + " |")
                self.corpus.add("\n".join(lines), ref_n=0, title=artifact["title"], kind="table")
                feed_text = f"""\
table {artifact['id']} recorded: {artifact['title']}
({len(artifact['rows'])} rows x {len(artifact['columns'])} columns).
It reaches the report as a real table -- interpret it in the relevant
section, do not re-type the numbers."""
                feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "ok",
                        "n": len(artifact["rows"]),
                        "ms": int((time.monotonic() - started) * 1000),
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                    },
                )
                yield ("artifact", {"id": artifact["id"], "item": artifact})
                continue
            if tool_name == EVALUATE_TOOL:
                parsed = parse_evaluate_call(call)
                if parsed is None:
                    logger.debug(
                        "zjsearch_decision: unusable call arguments: %.200s",
                        str(call.get("arguments") or ""),
                    )
                    feed_text = 'error: evaluate needs a compact state string and 1-4 named questions (type choice / score / noul).  Do NOT invent a verdict and do not attribute one to evaluate -- if you must conclude, present the conclusion as your own judgment.'
                    feeds[wire_id - 1] = feed_text
                    yield (
                        "call",
                        {
                            "call": wire_id,
                            "status": "error",
                            "ms": int((time.monotonic() - started) * 1000),
                            "feed": feed_text[:800],
                            "raw": feed_text[:50_000],
                        },
                    )
                    continue
                state, questions, images = parsed
                started = time.monotonic()
                out = decision.evaluate(state, questions, timeout=20.0, images=images, account=self.account)
                if out is None and not decision.available():
                    # the decision model's config-level absence rides the
                    # chat fallback (the same named-verdict shapes) -- a
                    # TRANSIENT decision failure does NOT (the feed below
                    # already says the model is unavailable; silently
                    # re-spending on the main model would surprise)
                    out = decision.judge_via_chat(state, questions, account=self.account)
                # ONE timing for the branch: the judgment ledger's latency IS
                # the row settlement's ``ms`` (never double-timed)
                ms = int((time.monotonic() - started) * 1000)
                if out is not None:
                    # SAME named-verdict-map protocol as the referee and the
                    # citation gate: answers + record_questions (name→label),
                    # so the client's one generic renderer covers the evaluate tool too
                    self.judgments.append(
                        {
                            "purpose": "evaluate",
                            "question": (
                                " / ".join(
                                    str(q.get("instructions") or "").strip() or name for name, q in questions.items()
                                )
                            )[:200],
                            "answers": (out.get("answers") if isinstance(out.get("answers"), dict) else {}),
                            "record_questions": [
                                {
                                    "name": name,
                                    "instructions": str(q.get("instructions") or "")[:200],
                                }
                                for name, q in questions.items()
                            ],
                            "ms": ms,
                        }
                    )
                verdict = self._judge_answers(out) if out is not None else None
                if out is None:
                    feed_text = (
                        "the decision model is unavailable -- make the judgment from the gathered evidence yourself."
                    )
                else:
                    feed_text = (
                        verdict + "\nTreat this as ONE signal -- it judged only the state you"
                        " handed it; facts still come from your cited sources."
                    )
                feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "ok" if out else "error",
                        "result": (self._judge_result(out, self.lang) if out is not None else ""),
                        "n": len(questions),
                        "ms": ms,
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                        # the STRUCTURED verdict rides the settlement too: the
                        # timeline row renders the same probability bars as the
                        # rail's decision card -- one judgment, one rendering
                        **(
                            {"answers": out.get("answers")}
                            if out is not None and isinstance(out.get("answers"), dict)
                            else {}
                        ),
                        **({"preview": verdict} if verdict else {}),
                    },
                )
                continue
            if tool_name == RECORD_FINDINGS_TOOL:
                # the BELIEF LEDGER: facts (with revision ops) + gaps -- the
                # model revises what it believes and tracks what it still
                # owes; the snapshot flies to the client, the writer reads
                # the active facts, the next rounds chase the open gaps
                ops = parse_record_findings_call(call)
                written, opened, closed = self.apply_learnings(ops, rnd)
                # the conflict scan: each NEW fact vs the previously
                # established ones (embedding nearest-neighbour + one
                # consistency noul) -- a flagged pair rides the fact, the
                # findings card renders the ⚡ AND a Resolve gap opens so
                # the loop's own continuation contract chases the
                # contradiction (fail-open: an unconfigured model simply
                # never flags)
                established = [str(fact.get("text") or "") for fact in self.facts[:-written]] if written else []
                auto_gaps = 0
                for fact in self.facts[-written:] if written else []:
                    conflict = audit.finding_conflict(str(fact.get("text") or ""), established, account=self.account)
                    if conflict is not None:
                        fact["conflict_with"] = self.facts[conflict].get("id")
                        if self.open_conflict_gap(fact, self.facts[conflict], rnd):
                            auto_gaps += 1
                self.round_learned = True
                yield (
                    "findings",
                    {
                        "round": rnd,
                        "id": wire_id,
                        "items": list(self.facts),
                        "gaps": list(self.gaps),
                    },
                )
                # the row settles like every other instant write (n = the
                # active-fact count -- the client renders it localized)
                active = sum(1 for fact in self.facts if fact["status"] == "active")
                parts = [f"wrote {written} fact(s)"]
                if opened:
                    parts.append(f"opened {opened} gap(s)")
                if closed:
                    parts.append(f"closed {closed} gap(s)")
                if auto_gaps:
                    parts.append(f"flagged {auto_gaps} conflict gap(s) to resolve")
                feed_text = (
                    "ledger updated: "
                    + ", ".join(parts)
                    + '.'
                    + self.ledger_echo()
                    + "\nFact texts stay self-contained and [n]-cited; the"
                    " writer reads the active facts, your next rounds chase"
                    " the open gaps."
                )
                feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "ok",
                        "n": active,
                        "ms": int((time.monotonic() - started) * 1000),
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                    },
                )
                continue
            if tool_name == RECALL_HISTORY_TOOL:
                query = parse_query(call)
                if self.live_recall:
                    # LIVE RECALL: the model's own query goes to the
                    # browser's knowledge base -- the recall wire event
                    # asks, the client answers through
                    # /zjsearch/ask/run/recall, the run parks on the slot
                    # meanwhile.  FAIL-OPEN: a timeout (tab gone, store
                    # never booted) feeds the no-matches line and the run
                    # continues on live search alone, exactly like an
                    # empty index answers.  The client RANKED the rows
                    # (its hybrid recall ran on this query), so the
                    # index rank is skipped; the parse sanitizes.
                    rid = recall_slot.open()
                    yield ("recall", {"id": rid, "q": query})
                    rows = recall_slot.wait(rid)
                    matches = recall_history_cap.parse_entries(rows) if rows else []
                else:
                    matches = recall_history_cap.rank(self.recall_entries, query)
                gathered = True
                if matches:
                    events: list[dict[str, t.Any]] = []
                    blocks: list[str] = []
                    fed_files = 0
                    for entry in matches:
                        if not entry["url"]:
                            # a USER-UPLOADED FILE from the knowledge base:
                            # locally archived material no reader can
                            # re-fetch -- its text head is the content, it
                            # mints no [n] (it is not a web source) and it
                            # joins the feed as a named context block.
                            # THE WRITER FEEDS TOO: the tool result feeds the
                            # RESEARCHER only -- without the append below the
                            # single-write writer never sees the file (its
                            # <context> is state.feed) and answers "cannot
                            # access it" over material the run just recalled.
                            file_block = f'<user_file name="{entry["title"]}">\n{entry["text"]}\n</user_file>'
                            blocks.append(file_block)
                            if fed_files < 3:
                                self.feed.append(
                                    f"From the user's knowledge base ({entry['title']}):\n\n{entry['text']}"
                                )
                                fed_files += 1
                            continue
                        # a url the live feed already numbered keeps ITS [n]:
                        # the past head supplements the existing source
                        # instead of minting a duplicate identity
                        known_n = self.reg.known(reader.normalize_url(entry["url"]))
                        if known_n is not None:
                            blocks.append(
                                f"[{known_n}] {entry['title']} -- {entry['url']}\n{entry['text']}"
                                if entry["text"]
                                else f"[{known_n}] {entry['title']} -- {entry['url']} (already among your sources)"
                            )
                            continue
                        n = self.next_n
                        self.next_n += 1
                        if entry["text"]:
                            blocks.append(f"[{n}] {entry['title']} -- {entry['url']}\n{entry['text']}")
                        else:
                            # the re-read pointer names the page reader only
                            # when it is actually registered -- never teach
                            # a tool the model does not have
                            re_read = (
                                f" re-read it with a {BROWSE_TOOL} read before relying on its details."
                                if reader.configured()
                                else ""
                            )
                            blocks.append(
                                f"[{n}] {entry['title']} -- {entry['url']}\n(past source, identity only.{re_read})"
                            )
                        events.append(
                            {
                                "n": n,
                                "title": entry["title"],
                                "url": entry["url"],
                                "netloc": entry.get("host") or "",
                                "history": True,
                            }
                        )
                    feed_text = (
                        "from the user's PAST research and uploads (past pages may"
                        " be outdated -- live sources take precedence; user files"
                        " are the user's own material):\n\n" + "\n\n".join(blocks)
                    )
                    feeds[wire_id - 1] = feed_text
                    if events:
                        yield ("sources", {"items": events})
                else:
                    feed_text = "(no page in the user's past research matches -- continue with live search)"
                    feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "ok",
                        "n": len(matches),
                        "ms": int((time.monotonic() - started) * 1000),
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                        **(
                            {
                                "preview": "\n".join(
                                    f"{entry.get('title') or ''} -- {entry.get('url') or ''}".strip(" -")
                                    for entry in matches
                                )[:600]
                            }
                            if matches
                            else {}
                        ),
                    },
                )
                continue
            if tool_name == MEMORY_TOOL:
                # the near-dup gate's comparison set: the memory snapshot
                # (pre-sent, or LIVE-pulled below) PLUS the saves this run
                # already accepted -- ids ride beside the snapshot rows (a
                # reinforce/update/forget must name its target), None
                # beside this run's own saves (the client mints ids at
                # insert; the server never knows them).
                # LIVE MEMORIES: the snapshot is not pre-sent -- the first
                # memory call (search OR save) pulls the store's
                # memory list through the recall slot (kind=memory), and
                # BOTH actions plus the near-dup gate read the pulled
                # list from here on.  Pull-once per run: the store barely
                # changes mid-run, and a save arriving before any search
                # still dedups against the real stored facts.
                if self.live_recall and not self.memories_pulled:
                    self.memories_pulled = True
                    rid = recall_slot.open()
                    yield ("recall", {"id": rid, "q": "user memories", "kind": "memory"})
                    rows = recall_slot.wait(rid)
                    if rows:
                        self.user_memories = memory_cap.parse_memories(rows)
                known_memories = [str(m.get("content") or "") for m in self.user_memories] + self.saved_memories
                known_ids = [m.get("id") or None for m in self.user_memories] + [None] * len(self.saved_memories)
                feed, event = memory_cap.run_call(
                    call,
                    self.user_memories,
                    known=known_memories,
                    known_ids=known_ids,
                    account=self.account,
                    cfg=self.cfg,
                )
                feeds[wire_id - 1] = feed
                ms = int((time.monotonic() - started) * 1000)
                if event:
                    # a mutation: the row event settles the timeline AND
                    # the late memory event carries the v2 op the client
                    # executes against its store
                    save_event = event
                    op = str(save_event.get("op") or "save")
                    target_id = save_event.get("id")
                    if op == "save":
                        self.saved_memories.append(str(save_event.get("content") or ""))
                    elif op == "update":
                        # the superseded wording leaves the run's dedup
                        # set: the snapshot row dies, the new wording joins
                        if target_id:
                            self.user_memories = [m for m in self.user_memories if m.get("id") != target_id]
                        self.saved_memories.append(str(save_event.get("content") or ""))
                    elif op == "forget":
                        if target_id:
                            self.user_memories = [m for m in self.user_memories if m.get("id") != target_id]
                        else:
                            self.saved_memories = [
                                c for c in self.saved_memories if c != str(save_event.get("content") or "")
                            ]
                    yield (
                        "call",
                        {
                            "call": wire_id,
                            "status": "ok",
                            "action": op,
                            "label": save_event["content"],
                            # update/forget carry the touched row's OLD
                            # wording as the preview -- the tool row
                            # renders old -> new (or what left)
                            **(
                                {"preview": str(save_event.get("old") or save_event.get("content") or "")}
                                if op in ("update", "forget")
                                else {}
                            ),
                            "ms": ms,
                            "feed": feed[:800],
                            "raw": feed[:50_000],
                        },
                    )
                    yield ("memory", save_event)
                else:
                    yield (
                        "call",
                        {
                            "call": wire_id,
                            "status": "ok",
                            "action": "search",
                            "label": str(raw_args(call).get("query") or ""),
                            "preview": feed[:600],
                            "ms": ms,
                            "feed": feed[:800],
                            "raw": feed[:50_000],
                        },
                    )
                continue
            if tool_name == search_tools.DISCOVERY_TOOL:
                # progressive disclosure: the discovery tool returns the
                # matched tools' full schemas (a text result like any
                # other) over BOTH indexes -- the external MCP servers'
                # tools and this run's disclosed internal long tail.
                # BOOKKEEPING, not gathering: a pure-discovery round must
                # not eat the stall detector's credits or draw the
                # no-new-sources nag -- the catalog listing is metadata,
                # the data starts at the first real tool call.
                feed_text, extras = search_tools.run_call(
                    str(raw_args(call).get("query") or ""), internal_specs=self.disclosed_specs
                )
                feeds[wire_id - 1] = feed_text
                yield (
                    "call",
                    {
                        "call": wire_id,
                        "status": "ok",
                        "n": extras["n"],
                        "tools": extras["tools"],
                        "preview": "",
                        "ms": int((time.monotonic() - started) * 1000),
                        "feed": feed_text[:800],
                        "raw": feed_text[:50_000],
                    },
                )
                continue
            if tool_name.startswith("mcp_"):
                # the MCP call rides the round's POOL (each hop is an
                # independent network round trip on the shared loop --
                # serializing them on the scan loop froze the driver for
                # up to 90s PER CALL before the searches even dispatched)
                mcp_jobs.append((wire_id, tool_name, raw_args(call)))
                gathered = True
                continue
            if str(call.get("name") or "") == BROWSE_TOOL:
                # every browse action is the SESSION lane now (Browser-use
                # semantics: open -> read, tabs, viewport) -- read with a
                # url is document-only and the service teaches the recipe
                # for page urls.  FAST actions ride the pool ALONGSIDE the
                # round's searches (the session lock serializes them among
                # themselves); the human-blocking ones (wait_user, close)
                # stay INLINE -- their mirror frames must stream live, not
                # arrive buffered at completion.  (A multi containing a
                # wait_user step is rejected up front by the batch engine
                # -- it has no actor there; this branch no longer routes
                # it to a death by "unknown action".)
                browser_args = browse_tool.parse_browse_call(call)
                if str(browser_args.get("action") or "") in ("wait_user", "close"):
                    if (yield from self._browser_call(call, wire_id, feeds)):
                        gathered = True
                    continue
                browse_jobs.append((wire_id, call))
                gathered = True
                continue
            if str(call.get("name") or "") == delegate_tool.DELEGATE_RESEARCH_TOOL:
                # the DELEGATION: one subagent per call, executed as the
                # round's own parallel batch (before the pool jobs -- a
                # delegation round usually carries only these)
                sub_jobs.append((wire_id, delegate_tool.parse_delegate_research_call(call)))
                gathered = True
                continue
            if str(call.get("name") or "") == message_subtask.MESSAGE_SUBTASK_TOOL:
                # the FOLLOW-UP: a message to a registered subagent -- it
                # resumes inside the context it built.  Executed AFTER the
                # round's delegation batch, so a same-round delegate+message
                # pair still finds its target in the registry.
                followup_jobs.append((wire_id, message_subtask.parse_message_subtask_call(call)))
                gathered = True
                continue
            feed, event, job = self._search_plan(call, wire_id)
            if feed:
                feeds[wire_id - 1] = feed
            if event:
                yield ("call", event)
            if job:
                search_jobs.append(job)
                gathered = True
                self.coverage.track(job[1])
        self.round_gathered = gathered
        if sub_jobs:
            yield from self._run_subagents(rnd, sub_jobs, feeds)
        if followup_jobs:
            yield from self._run_followups(rnd, followup_jobs, feeds)
        # the pool is deliberately NOT in a with-block: when the consumer
        # disappears (client disconnect / stop) the generator closes right
        # here -- a with-exit would wait for the still-running work and
        # stall the shutdown
        total = len(search_jobs) + len(browse_jobs) + len(mcp_jobs)
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=min(max(1, total), MAX_PARALLEL))
        try:
            yield from self._dispatch(pool, rnd, search_jobs, browse_jobs, feeds, mcp_jobs)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        # Jina's failure-becomes-information: an unproductive round tells
        # the coverage REFEREE (advice-only -- the update_plan TOOL is the
        # plan's single writer): grades open subtasks against this round's
        # new sources; the model writes statuses via update_plan itself
        self._coverage_referee(feeds)
        # the record-as-you-go discipline: material arrived but the ledger
        # stayed untouched -- nudge BEFORE the next round so facts/gaps are
        # recorded while fresh (end-of-run summaries lose the in-flight
        # context that produced them)
        if self.round_gathered and self.round_new_hits > 0 and not self.round_learned:
            self._append_note(
                feeds,
                "(ledger note: this round gathered sources but recorded NO"
                " findings -- record the established facts and any newly"
                " discovered gaps NOW (one findings call), then continue.)",
            )
        # the model WHY, one round before the stall detector would end the
        # research -- the next turn can change course (stall_rounds=2 modes
        # get one warning; goal's 3 get two)
        if self.round_gathered and self.round_new_hits == 0:
            self._append_note(
                feeds,
                "(progress note: this round produced NO new sources -- every"
                " query was a repeat, empty or failed.  Change the angle:"
                " different keywords, another facet, another category -- or"
                " stop researching and let the writer answer.)",
            )
        # the task-card CADENCE reminder (B2): a long run's plan drifts --
        # every PLAN_REMINDER_EVERY rounds the card's standing is nudged
        # through the same note channel as the budget/progress notes
        task_list = self.coverage.task_list
        if task_list and rnd - self.last_plan_reminder_round >= PLAN_REMINDER_EVERY:
            done = sum(1 for item in task_list if item.get("status") == "done")
            self._append_note(
                feeds,
                f"(plan reminder: the task card stands at {done}/{len(task_list)}"
                " done -- re-check it and revise it via update_plan if the"
                " plan has drifted.)",
            )
            self.last_plan_reminder_round = rnd
        # the model-facing budget note rides the round's tool results: the
        # next turn reads it with the results it describes (Vane injects
        # the iteration counter into the system prompt every turn -- this
        # is the cheap canonical-messages equivalent)
        if self.max_rounds and rnd == self.max_rounds - 1:
            self._append_note(feeds, BUDGET_LAST_ROUND_NOTE)
        elif self.feed_chars > _FEED_SOFT_LIMIT and not self.size_noted:
            self.size_noted = True
            self._append_note(feeds, FEED_CONVERGE_NOTE)
        yield (
            "tool_results",
            [(calls[idx], str(feed or "error: the call failed")) for idx, feed in enumerate(feeds)],
        )
        # the task card's current state: coverage ran at queue time
        # (active) and per-settlement in _finish (done + provenance) --
        # this re-emission syncs the card after the round's results
        yield ("plan", {"items": [dict(t) for t in self.coverage.task_list]})
        # the run's DECISION RESULTS (framework gates + model evaluate
        # summaries gathered THIS round): one wire batch per round -- the
        # sources rail's Decisions card reads it, raw answers included
        round_judgments = self.judgments[judgment_mark:]
        if round_judgments:
            yield (
                "decisions",
                {"round": rnd, "items": [dict(entry) for entry in round_judgments]},
            )

    SUB_MAX_PARALLEL = 4
    """Concurrent subagents per delegation batch (the design's cap)."""

    _sub_tool_notes: list[tuple[str, str]] = []
    """The last ``_sub_toolset()`` build's INSTRUCTIONS entries (set before
    the delegation batch registers its handles)."""

    def _search_plan(self, call: dict[str, t.Any], wire_id: int) -> tuple[str, dict[str, t.Any] | None, tuple | None]:
        """One ``search_web`` call's pre-pool plan: (feed, settle event,
        pool job) -- an empty query errors here, an exact repeat of an
        earlier round's query (site filters included) settles as a
        duplicate, a !bang on an API-BILLED engine without the user's
        approval is HELD (the feed teaches the ask_user confirmation --
        paid engines cost real money and the model must not spend it
        unsupervised), a fresh query is queued; the settle event carries
        its ``ms``/``feed`` (the debug contract).  The dedup mark itself
        is taken at completion (a failed search stays retryable)."""
        query, category, time_range, include, exclude, paid_ok = parse_call(call)
        if paid_ok:
            # the model's approval record: sticky for the run (a
            # process-restart resume rebuilds state and re-asks -- the
            # safe direction for spending)
            self.paid_ok = True
        # the ESCAPE HATCH: the model may deliberately re-run an executed
        # query (live material -- a score, a just-published release);
        # page-level dedup still applies (already-numbered urls keep
        # their [n]), only the query refusal is bypassed
        refresh = bool(raw_args(call).get("refresh"))
        if not query:
            feed_text = "error: empty query"
            return (
                feed_text,
                {
                    "call": wire_id,
                    "status": "error",
                    "n": 0,
                    "ms": 0,
                    "feed": feed_text[:800],
                    "raw": feed_text[:50_000],
                },
                None,
            )
        # THE PAID GATE: a !bang naming an API-billed engine spends the
        # user's money -- hold it until ONE ask_user confirmation lands,
        # then the sticky flag lets every later bang through
        if not self.paid_ok and (paid_hits := paid_bangs(query)):
            feed_text = f"""\
held: the bang targets {' , '.join(paid_hits)} -- an API-BILLED engine
(every call costs the user money) and this run has no approval yet.
Ask ONCE: call ask_user (as the ONLY call of a turn) with a short
confirmation naming the engine and that it is billed per call.  When
the user APPROVES, re-run this search with paid_ok: true -- the
approval covers the rest of the run.  If they decline, never set
paid_ok and stay on the free engines."""
            return (
                feed_text,
                {
                    "call": wire_id,
                    "status": "approval",
                    "n": 0,
                    "ms": 0,
                    "feed": feed_text[:800],
                    "raw": feed_text[:50_000],
                },
                None,
            )
        # the key must describe the search AS EXECUTED: exclude hosts wear
        # their operator (a role swap is a different search), and the
        # category/time_range ride along -- the prompt's own recovery
        # recipe ("a filtered search came back empty: retry without the
        # filter") must not settle as a duplicate
        dedup_key = " ".join(
            (
                query
                + " "
                + " ".join(f"site:{h}" for h in include)
                + " "
                + " ".join(f"-site:{h}" for h in exclude)
                + (f" cat:{category}" if category else "")
                + (f" tr:{time_range}" if time_range else "")
            )
            .lower()
            .split()
        )
        if dedup_key in self.reg.ran and not refresh:
            feed_text = """\
duplicate: this exact query already ran in an earlier round and its
outcome is already in the conversation (possibly empty) -- do not
repeat it; search a DIFFERENT facet or write the answer from the
sources you have.  (If the material itself may have changed -- a live
score, a just-published release -- re-run it with refresh: true.)"""
            return (
                feed_text,
                {
                    "call": wire_id,
                    "status": "duplicate",
                    "n": 0,
                    "ms": 0,
                    "feed": feed_text[:800],
                    "raw": feed_text[:50_000],
                },
                None,
            )
        return (
            "",
            None,
            (wire_id, query, category, time_range, include, exclude, dedup_key),
        )

    @staticmethod
    def _judge_answers(out: dict[str, t.Any]) -> str:
        """One decision-model judgment as per-question verdict lines (choice
        label + confidence, the score with its nearest legend level, the
        yes probability) -- the tool feed's payload AND the timeline row's
        debug preview."""
        lines: list[str] = ["decision model:"]
        for name, answer in (out.get("answers") or {}).items():
            if not isinstance(answer, dict):
                continue
            kind = answer.get("type")
            if kind == "choice":
                lines.append(f"{name}: {answer.get('choice')} (confidence {answer.get('confidence')})")
            elif kind == "score":
                level = _score_level(answer)
                lines.append(f"{name}: {answer.get('score')} ({level})" if level else f"{name}: {answer.get('score')}")
            else:
                try:
                    p = float(answer.get("noul"))
                except (TypeError, ValueError):
                    p = 0.0
                lines.append(f"{name}: yes {round(p * 100)}% / no {round((1 - p) * 100)}%")
        return "\n".join(lines)

    @staticmethod
    def _judge_result(out: dict[str, t.Any], lang: str) -> str:
        """One compact verdict line for the row's meta slot (the
        calculate's ``= result`` pattern): the answer VALUE per question
        -- the question text is the row's label, never repeated here."""
        values: list[str] = []
        for answer in (out.get("answers") or {}).values():
            if not isinstance(answer, dict):
                continue
            kind = answer.get("type")
            if kind == "choice":
                values.append(str(answer.get("choice") or ""))
            elif kind == "score":
                level = _score_level(answer)
                values.append(str(level or answer.get("score") or ""))
            else:
                try:
                    p = float(answer.get("noul"))
                except (TypeError, ValueError):
                    p = 0.0
                if lang.startswith("zh"):
                    values.append(f"{'yes' if p >= 0.5 else 'no'} {round(p * 100)}%")
                else:
                    values.append(f"yes {round(p * 100)}%")
        return " · ".join(v for v in values if v)[:80]
