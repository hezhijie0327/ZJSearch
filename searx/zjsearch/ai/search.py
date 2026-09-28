# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: AI Search -- the model drives the keyword searches.

The tool-calling feature on the shared agent framework
(:py:mod:`searx.zjsearch.ai.agent`): the model analyses the question,
writes a one-line intent, then issues ``web_search`` calls that run as
REAL instance searches -- the same ``SearchWithPlugins`` path the results
page uses, plugins included -- in parallel worker threads.  Each search's
results are serialized through the very ``_result_data`` macro the
page-data uses, so the client renders sub-results with its standard
components; the model consumes a compacted, globally numbered ``[n]``
feed of the same sources and finally writes the cited answer (the AI
Overview renderer contract: ``[n]`` chips, GFM, think block).

Wire protocol (NDJSON, one JSON object per line; the stream never ends
silently):

- ``{"e": "think", "t"}`` / ``{"e": "delta", "t"}`` -- reasoning and prose
  deltas of the current turn (a turn's prose becomes the next event's
  intent);
- ``{"e": "calls", "round", "intent", "items": [{id, q, category}]}`` --
  a parallel batch announced (the model decides the batch size; calls
  beyond the remaining total budget settle as ``skipped`` right away);
- ``{"e": "search", "round", "id", "status", "n", "ms"}`` -- one search
  finished (ok / error / timeout / skipped);
- ``{"e": "results", "round", "id", "results"}`` -- page-data-shaped
  result list of that search;
- ``{"e": "sources", "items": [{n, round, id, idx, ...}]}`` -- the global
  ``[n]`` registry entries (citation chips jump to ``round``/``id``/``idx``);
- ``{"e": "error", "reason"}`` mid-stream, ``{"e": "end"}`` closes.

A stream that dies before its first line answers 502 with a truncated
upstream reason (same contract as the AI Overview).  Configuration: the
transport is the shared ``zjsearch.ai`` block; this feature ships
enabled and opts out via ``zjsearch.ai.search.enabled: false`` (the AI
Overview mirrors that under ``zjsearch.ai.overview.enabled``).
"""

import concurrent.futures
import importlib.util
import json
import logging
import re
import time
import typing as t
from html import escape

import flask

from searx.extended_types import sxng_request
from searx.search import SearchWithPlugins
from searx.webadapter import get_search_query_from_webapp
from searx.webutils import highlight_content
from searx.zjsearch.ai import agent, llm, prompts

logger = logging.getLogger(__name__)

TOOL_NAME = "web_search"

SEARCH_CATEGORIES = ("general", "news", "images", "videos", "it", "science", "files", "music")
"""The verticals the model may pick; each has a dedicated client layout."""

SEARCH_TIMEOUT = 25.0
"""Wall-clock budget for one parallel batch of searches (engines carry
their own per-request timeouts; this guards the executor)."""

MAX_PARALLEL = 3
"""Worker threads per parallel batch -- uncapped per-round call counts
(the model's call) queue behind these few slots so a chatty round cannot
stampede the instance; the batch's wall-clock timeout (scaled by the
number of waves) truncates whatever is still waiting."""

RESULTS_CAP = 30
"""Results per search sent to the client (the model only sees the feed)."""

FEED_DEEP = 5
FEED_SHALLOW = 5
FEED_SNIPPET_CHARS = 300
"""The model's compacted view of one search: 5 deep (title + snippet
head) + 5 shallow (title only), numbered with the global [n] registry."""


SEARCH_MODES = ("speed", "balanced", "quality", "goal")

_MODE_BUDGETS: dict[str, dict[str, int]] = {
    # speed: one focused round; balanced: main facets, optional gap-filler;
    # quality: multi-round deep research with cross-verification;
    # goal: the question is a target -- iterate in self-checked rounds until
    # the goal is demonstrably met (budget is still the hard ceiling).
    # Per-round call counts are the MODEL's call -- uncapped, the parallel
    # batch's wall-clock timeout is the backstop; the budgets bound rounds,
    # total calls and wall clock only.
    "speed": {"max_rounds": 2, "max_calls_total": 4, "budget_seconds": 150},
    "balanced": {"max_rounds": 4, "max_calls_total": 8, "budget_seconds": 300},
    "quality": {"max_rounds": 8, "max_calls_total": 16, "budget_seconds": 450},
    "goal": {"max_rounds": 16, "max_calls_total": 32, "budget_seconds": 600},
}


def _cfg() -> dict[str, t.Any]:
    """The ``zjsearch.ai.search`` settings block."""
    cfg = llm.ai_cfg().get("search")
    return cfg if isinstance(cfg, dict) else {}


def _enabled() -> bool:
    """The search feature flag: ``zjsearch.ai.search.enabled`` -- ``True``
    unless explicitly switched off."""
    return bool(_cfg().get("enabled", True))


def _budget(key: str, mode: str, default: int) -> int:
    """Budget for one run: an explicit ``zjsearch.ai.search.<key>`` setting
    wins, otherwise the mode's default, otherwise ``default``."""
    value = _cfg().get(key)
    if value is not None:
        try:
            return int(value)
        except (TypeError, ValueError):
            pass
    return _MODE_BUDGETS.get(mode, {}).get(key, default)


def capability() -> dict[str, str] | None:
    """The page-data ``ai_search`` payload (the shared token + model label);
    ``None`` when AI search is off or the transport is unconfigured -- the
    client hides its ``[classic|AI]`` mode switch then."""
    cfg = llm.ai_cfg()
    if not (_enabled() and llm.configured(cfg)):
        return None
    return {"tk": llm.issue_token(), "model": str(cfg.get("model"))}


def _int(key: str, default: int) -> int:
    try:
        return int(_cfg().get(key))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _tool_spec() -> dict[str, t.Any]:
    """The ``web_search`` tool in the dialect-neutral llm shape."""
    return {
        "name": TOOL_NAME,
        "description": (
            "Run one web search on the metasearch engine with specific keywords."
            " Search like a skilled human: short keyword sets (never full"
            " sentences), distinct facets of the question, alternative phrasings"
            " or translations when the wording is uncertain. Prefer several"
            " parallel calls over one broad query. Precision operators are"
            " applied authoritatively by the engine and are welcome when they"
            " sharpen the results: site: / -site:, filetype:, \"exact phrase\","
            " before:YYYY-MM-DD / after:YYYY-MM-DD. Optional filters"
            " (time_range) are not supported by every engine: when a filtered"
            " search comes back EMPTY, retry the same intent once without the"
            " filter before concluding. Never use bangs unless the user"
            " explicitly names an engine (then prefix the query, e.g. \"!baidu"
            " keywords\") -- a category search already fans out across every"
            " engine in that vertical. Results arrive as globally numbered [n]"
            " sources to cite in the final answer."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The keyword query to search for."},
                "category": {
                    "type": "string",
                    "enum": list(SEARCH_CATEGORIES),
                    "description": (
                        "Optional vertical (images for visual context, news for"
                        " current events); general when unsure."
                    ),
                },
                "time_range": {
                    "type": "string",
                    "enum": list(_TIME_RANGES),
                    "description": (
                        "Optional freshness window -- use it when the question"
                        " is about recent material (news, releases, changelogs);"
                        " omit otherwise."
                    ),
                },
            },
            "required": ["query"],
        },
    }


_DEPTH_PROMPTS: dict[str, str] = {
    # Round policy AND output shape live here and only here: the base
    # prompt must never contradict the chosen depth.
    "speed": "Depth: SPEED -- the user mostly wants to know WHAT this is."
    " One focused round, then answer in ONE short dense paragraph: name the"
    " subject (bold on first mention), define it in a sentence or two, add"
    " at most two or three key facts -- each cited.  NO headings, lists,"
    " tables or diagrams; if the subject is ambiguous, say which sense you"
    " picked in one clause.",
    "balanced": "Depth: BALANCED -- round out the main facets: what it is,"
    " how it works or why it matters, and whatever context the reader needs"
    " not to be misled.  One search round covers it; run a second only for a"
    " real gap.  Short paragraphs with the key terms in **bold**; a bullet"
    " list or definition list when enumerating; a table only for a genuine"
    " 2-3 way comparison.  Keep it moderate.",
    "quality": "Depth: QUALITY -- a thorough, structured answer in \"##\""
    " sections: definitions, mechanics, comparisons, recent developments."
    "  Cross-verify load-bearing claims against independent sources (several"
    " rounds are fine, but run only as many searches as the question actually"
    " needs) and cite every major claim.",
    "goal": "Depth: GOAL -- treat the question as a TARGET the user wants"
    " reached, not a casual question.  Work toward it iteratively: first"
    " state what evidence would demonstrate the goal is met, then search for"
    " it; after each round, explicitly check what is still missing and run"
    " further rounds until the goal is demonstrably achieved (verify"
    " load-bearing claims against independent sources).  Structure the final"
    " answer around the goal with \"##\" sections, and close with a GFM task"
    " list (- [x] met / - [ ] open) as the evidence ledger -- every checked"
    " item cited.  If the research budget runs out first, leave the missing"
    " items unchecked and name the evidence that would close them.",
}


def _initial_messages(
    question: str,
    lang: str,
    history: list[dict[str, str]],
    sources_base: int,
    depth: str,
) -> list[dict[str, t.Any]]:
    """The conversation opener: the role + search policy, the depth branch
    (round policy AND output shape), then the SHARED answer contract from
    ai/prompts.py (language, citations, markdown, grounding, hygiene) --
    fragments composed, never hand-copied, so the two AI features cannot
    drift."""
    role = (
        "You are the \"AI Search\" mode of the zjsearch metasearch engine:"
        " the user asks a question, YOU decide which keyword searches answer"
        " it, run them with the {tool} tool, then answer from their numbered"
        " sources.".format(tool=TOOL_NAME)
    )
    follow_up = ""
    if sources_base:
        follow_up = (
            "\n- This is a follow-up in an ongoing research session: sources"
            f" [1]..[{sources_base}] were already found in earlier turns. Your"
            " new searches continue the numbering from"
            f" [{sources_base + 1}].  Cite earlier sources by their numbers"
            " when they support the answer -- but unless they already answer"
            " THIS follow-up completely, run at least one fresh web_search"
            " for its specifics: never answer from the conversation history"
            " alone."
        )
    how_to_search = [
        "How to search:",
        "- First write ONE short sentence stating how you read the question's"
        " intent (the UI shows it as the lead of your search plan). Then call"
        f" {TOOL_NAME} -- several calls in the same turn are encouraged: they"
        " run in parallel.",
        "- ALWAYS run at least one {tool} call before writing the final"
        " answer -- even for topics you already know: the user expects live,"
        " cited sources, not your memory.  No search results, no answer.".format(tool=TOOL_NAME),
        "- Optional filters (time_range) are not supported by every engine:"
        " when a filtered search comes back EMPTY, retry the same intent once"
        " without the filter before concluding there is nothing to find.",
        "- Never repeat a query you already ran; never use !bangs unless the"
        " user explicitly names an engine (then prefix the query with its"
        " engine bang, e.g. !baidu) -- without one, the category parameter"
        " already fans out across every engine in that vertical.",
    ]
    depth_line = _DEPTH_PROMPTS.get(depth, _DEPTH_PROMPTS["balanced"])
    answer_rules = [
        "Answer rules:",
        prompts.language_directive(lang),
        prompts.citation_rules() + " Source numbers are the global [n] labels your search results" " carry.",
        prompts.markdown_surface(),
        prompts.grounding_fallback("searches"),
        prompts.opening_rule(),
    ]
    lines = [role, prompts.today_line(), *how_to_search, depth_line, *answer_rules]
    if follow_up:
        lines.append(follow_up)
    messages: list[dict[str, t.Any]] = [{"role": "system", "content": "\n".join(lines)}]
    for turn in history:
        messages.append({"role": "user", "content": f"<q>{turn.get('q') or ''}</q>"})
        messages.append({"role": "assistant", "content": str(turn.get("a") or "")[:2000]})
    messages.append({"role": "user", "content": f"<q>{question}</q>"})
    return messages


_RESULT_TEMPLATE = (
    '{%- from "zjsearch/data/macros.html" import result_data with context -%}'
    # the separator is a block-if ON PURPOSE: inline-if string literals come
    # out autoescaped ("&#34;, &#34;") and break the JSON (the repo gotcha)
    '[{%- for result in results %}{% if not loop.first %},{% endif %}{{ result_data(result) }}{%- endfor %}]'
)


_BANG_PREFIX_RE = re.compile(r"^(?:\s*![a-z0-9_-]+)*(?:\s+|$)", re.IGNORECASE)
_TIME_RANGES = ("day", "week", "month", "year")


def _parse_call(call: dict[str, t.Any]) -> tuple[str, str, str]:
    """(query, category, time_range) of one tool call -- sanitized: a
    LEADING group of engine bangs (e.g. "!baidu") survives because the
    model may only use one when the user explicitly names the engine;
    every other "!" is noise, whitespace collapses, the category and the
    freshness window are whitelist-checked."""
    try:
        args = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    query = str(args.get("query") or "")
    bang_match = _BANG_PREFIX_RE.match(query)
    bang = ""
    if bang_match and bang_match.group(0).strip():
        bang = " ".join(token.lower() for token in bang_match.group(0).split())
        query = query[bang_match.end() :]
    query = query.replace("!", "")
    query = " ".join((bang + " " + query).split())[:200]
    category = str(args.get("category") or "general").strip().lower()
    if category not in SEARCH_CATEGORIES:
        category = "general"
    time_range = str(args.get("time_range") or "").strip().lower()
    if time_range not in _TIME_RANGES:
        time_range = ""
    return query, category, time_range


def _serialize(raw_results: list[t.Any], query: str) -> list[dict[str, t.Any]]:
    """Ordered results as page-data-shaped dicts -- highlighted like the
    search view does, serialized through the very ``_result_data`` macro
    the page payload uses (runs in the request thread)."""
    for result in raw_results:
        if "content" in result and result["content"]:
            result["content"] = highlight_content(escape(result["content"][:1024]), query)
        if "title" in result and result["title"]:
            result["title"] = highlight_content(escape(result["title"] or ""), query)
    rendered = None
    try:
        # the macro speaks the render context's helper functions -- pass the
        # very same callables webapp.render / the stream mirror pass
        from searx import webapp  # pylint: disable=import-outside-toplevel,cyclic-import

        rendered = flask.render_template_string(
            _RESULT_TEMPLATE,
            results=raw_results,
            favicon_url=webapp.favicons.favicon_url,
            get_pretty_url=webapp.get_pretty_url,
            image_proxify=webapp.image_proxify,
        )
        return json.loads(rendered)
    except Exception as exc:  # pylint: disable=broad-except
        # a malformed field reaching the macro raises anything from
        # ValueError to jinja2.TemplateError; one bad result degrades to no
        # serialized feed for THAT search, never a crashed round
        logger.warning(
            "zjsearch_ai_search: result serialization failed: %r -- head: %.240r",
            exc,
            rendered if isinstance(rendered, str) else "",
        )
        return []


class _Searches:  # pylint: disable=too-few-public-methods
    """The ``web_search`` executor: real instance searches in a worker
    pool.  Yields the feature events for the wire protocol and ends with
    the agent framework's ``("tool_results", ...)`` alignment."""

    def __init__(self, prefs: t.Any, user_plugins: list[str], sources_base: int = 0, search_language: str = ""):
        self.prefs = prefs
        self.user_plugins = user_plugins
        self.search_language = search_language
        self.round_no = 0
        # follow-up runs continue the global [n] numbering after the base
        self.next_n = sources_base + 1

    def _search_one(self, query: str, category: str, time_range: str) -> list[t.Any]:
        """One real instance search -- the webapp path with a synthesized
        form (user preferences apply: safesearch, engines; the page's
        result language filter applies via ``search_language``).  Runs in a
        worker thread inside a COPIED request context (the executor
        submits it wrapped in ``copy_current_request_context``):
        SearchWithPlugins stores the request proxy and ``search()`` copies
        the context again for each of its engine threads."""
        form = {"q": query, "categories": category}
        if time_range:
            form["time_range"] = time_range
        if self.search_language:
            form["language"] = self.search_language
        search_query, _raw, _unknown, _notoken, _locale = get_search_query_from_webapp(self.prefs, form)
        search_obj = SearchWithPlugins(search_query, sxng_request, self.user_plugins)
        return search_obj.search().get_ordered_results()

    def _finish(
        self,
        rnd: int,
        idx: int,
        query: str,
        category: str,
        fut: "concurrent.futures.Future[list[t.Any]]",
        started: float,
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        ms = int((time.monotonic() - started) * 1000)
        try:
            raw = fut.result()[:RESULTS_CAP]
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_ai_search: search %d/%d failed: %r", rnd, idx, exc)
            feeds[idx - 1] = "error: the search failed"
            yield ("search", {"round": rnd, "id": idx, "status": "error", "n": 0, "ms": ms})
            return
        items = _serialize(raw, query)
        entries: list[dict[str, t.Any]] = []
        feed_lines = [f'Search "{query}" (category: {category}) returned {len(items)} results:']
        for pos, item in enumerate(items[: FEED_DEEP + FEED_SHALLOW]):
            n = self.next_n
            self.next_n += 1
            entries.append(
                {
                    "n": n,
                    "round": rnd,
                    "id": idx,
                    "idx": pos,
                    "title": str(item.get("title_text") or "")[:200],
                    "url": str(item.get("url") or ""),
                    "netloc": str(item.get("netloc") or ""),
                    "favicon": str(item.get("favicon") or ""),
                    "pretty_url": str(item.get("pretty_url") or ""),
                    "published_date": str(item.get("published_date") or ""),
                }
            )
            if pos < FEED_DEEP:
                head = str(item.get("content_text") or "")[:FEED_SNIPPET_CHARS]
                feed_lines.append(f"[{n}] {item.get('netloc', '')}: {item.get('title_text', '')} - {head}")
            else:
                feed_lines.append(f"[{n}] {item.get('netloc', '')}: {item.get('title_text', '')}")
        feeds[idx - 1] = "\n".join(feed_lines)
        yield ("search", {"round": rnd, "id": idx, "status": "ok", "n": len(items), "ms": ms})
        if items:
            yield ("results", {"round": rnd, "id": idx, "results": items})
        if entries:
            yield ("sources", {"items": entries})

    def execute(self, calls: list[dict[str, t.Any]]) -> t.Iterator[tuple[str, t.Any]]:
        """Run one round of calls in parallel; feature events flow to the
        client while the searches complete.  Wire ids are the 1-based
        position of the call within this round."""
        self.round_no += 1
        rnd = self.round_no
        prepared = [_parse_call(call) for call in calls]
        feeds: list[str | None] = [None] * len(calls)
        submittable = [
            (idx, query, category, time_range) for idx, (query, category, time_range) in enumerate(prepared) if query
        ]
        # the pool is deliberately NOT in a with-block: after the batch
        # deadline the timeout events must stream immediately -- a with-exit
        # would wait for the still-running searches and stall the response
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=min(max(1, len(submittable)), MAX_PARALLEL))
        try:
            yield from self._dispatch(pool, rnd, submittable, feeds)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        for wire_id, (query, _category, _time_range) in enumerate(prepared, 1):
            if not query:
                feeds[wire_id - 1] = "error: empty query"
                yield ("search", {"round": rnd, "id": wire_id, "status": "error", "n": 0, "ms": 0})
        yield (
            "tool_results",
            [(calls[idx], str(feed or "error: the search failed")) for idx, feed in enumerate(feeds)],
        )

    def _dispatch(  # pylint: disable=too-many-locals
        self,
        pool: concurrent.futures.ThreadPoolExecutor,
        rnd: int,
        submittable: list[tuple[int, str, str, str]],
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        futures: dict[concurrent.futures.Future, tuple[int, float]] = {}
        for idx, query, category, time_range in submittable:
            # the worker needs a request context of its own: SearchWithPlugins
            # stores the request proxy and search() copies the context again
            # for each of its engine threads (mirrors the webapp view thread)
            worker = flask.copy_current_request_context(self._search_one)
            futures[pool.submit(worker, query, category, time_range)] = (idx + 1, time.monotonic())
        pending = dict(futures)
        # the batch timeout covers every WAVE of the bounded pool: a chatty
        # uncapped round queues behind MAX_PARALLEL slots, and the queued
        # searches get their full SEARCH_TIMEOUT too instead of inheriting
        # whatever the first wave left of a flat deadline
        waves = max(1, -(-len(submittable) // MAX_PARALLEL))
        batch_deadline = time.monotonic() + SEARCH_TIMEOUT * waves
        while pending:
            timeout = batch_deadline - time.monotonic()
            if timeout <= 0:
                break
            done, _not_done = concurrent.futures.wait(
                pending, timeout=timeout, return_when=concurrent.futures.FIRST_COMPLETED
            )
            for fut in done:
                wire_id, started = pending.pop(fut)
                _idx, query, category, _time_range = submittable[wire_id - 1]
                yield from self._finish(rnd, wire_id, query, category, fut, started, feeds)
        for fut, (wire_id, _started) in pending.items():
            fut.cancel()
            feeds[wire_id - 1] = feeds[wire_id - 1] or "error: the search timed out"
            yield (
                "search",
                {
                    "round": rnd,
                    "id": wire_id,
                    "status": "timeout",
                    "n": 0,
                    "ms": int(SEARCH_TIMEOUT * waves * 1000),
                },
            )


def _display_item(idx: int, call: dict[str, t.Any]) -> dict[str, t.Any]:
    query, category, time_range = _parse_call(call)
    return {"id": idx, "q": query, "category": category, "time_range": time_range or None}


def _related_questions(cfg: dict[str, t.Any], question: str, answer: str, lang: str) -> list[str]:
    """Three follow-up questions for the Related section -- one small
    non-tool completion after the answer settles; empty on any failure."""
    messages = [
        {
            "role": "system",
            "content": (
                "Suggest follow-up questions for a search session. Output ONLY a"
                " JSON array of exactly 3 short question strings -- no prose, no"
                " markdown, no code fences."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Question: {question}\n\nAnswer given:\n{answer[:1200]}\n\n" f"Language for the questions: {lang}"
            ),
        },
    ]
    # relay_reasoning stays ON even though the think text is not parsed:
    # a reasoning model (gemma-4 in LM Studio) streams a long think phase
    # first -- with the channel dropped the queue stays silent and the idle
    # timeout kills the completion before any content arrives
    stream = llm.LlmStream(cfg, messages, relay_reasoning=True)
    text = ""
    deadline = time.monotonic() + 45.0
    while time.monotonic() < deadline:
        kind, payload = stream.next_event(20.0)
        if kind == "delta":
            text += str(payload or "")
        elif kind in ("error", "end"):
            break
    stream.cancel()
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end <= start:
        return []
    try:
        parsed = json.loads(text[start : end + 1])
    except ValueError:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item).strip()[:200] for item in parsed if isinstance(item, str) and item.strip()][:3]


def _generate(
    first: tuple[str, t.Any],
    events: t.Iterator[tuple[str, t.Any]],
    cfg: dict[str, t.Any],
    question: str,
    lang: str,
) -> t.Iterator[str]:
    """Map agent/executor events to the NDJSON wire protocol."""

    def emit(kind: str, payload: t.Any) -> str:
        if kind == "think":
            return json.dumps({"e": "think", "t": str(payload or "")}, ensure_ascii=False) + "\n"
        if kind == "delta":
            return json.dumps({"e": "delta", "t": str(payload or "")}, ensure_ascii=False) + "\n"
        if kind == "calls":
            return (
                json.dumps(
                    {
                        "e": "calls",
                        "round": payload["round"],
                        "intent": payload["intent"],
                        "items": [_display_item(idx, call) for idx, call in enumerate(payload["calls"], 1)],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
        if kind == "call_skipped":
            # an over-total-budget call: settle its timeline row on the
            # existing "search" wire shape so the client never spins
            return (
                json.dumps(
                    {"e": "search", "round": payload["round"], "id": payload["id"], "status": "skipped", "n": 0},
                    ensure_ascii=False,
                )
                + "\n"
            )
        if kind == "error":
            return json.dumps({"e": "error", "reason": llm.reason_of(payload)}, ensure_ascii=False) + "\n"
        return json.dumps({"e": kind, **payload}, ensure_ascii=False) + "\n"

    # reasoning-channel guard: some models (LM Studio + qwen3.6) route the
    # whole answer into the think stream and leave the content channel empty
    # -- promote the final turn's reasoning so the user always gets a
    # readable answer
    think_parts: list[str] = []
    answer_parts: list[str] = []

    last_kind = first[0]
    yield emit(*first)
    for event in events:
        kind, payload = event
        last_kind = kind
        if kind == "think":
            think_parts.append(str(payload or ""))
        elif kind == "delta":
            answer_parts.append(str(payload or ""))
        elif kind == "calls":
            # a new turn begins: its answer is judged on its own
            think_parts.clear()
            answer_parts.clear()
        yield emit(*event)
    answer_text = "".join(answer_parts).strip()
    if last_kind != "error" and not answer_text and think_parts:
        # the model routed the whole answer into the reasoning channel:
        # promote it so the user always gets a readable answer
        promoted = "".join(think_parts).strip()
        yield emit("delta", promoted)
        answer_parts.append(promoted)
        answer_text = promoted
    # `end` settles the run FIRST so the client's follow-up box opens
    # immediately; the related questions trail as a post-end event (the
    # small completion behind them can think for the better part of a
    # minute on reasoning models -- the client accepts `related` after
    # phase=done by design)
    yield json.dumps({"e": "end"}, ensure_ascii=False) + "\n"
    if answer_text:
        try:
            related = _related_questions(cfg, question, answer_text, lang)
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_ai_search: related questions failed: %r", exc)
            related = []
    else:
        related = []
    if related:
        yield emit("related", {"items": related})


def _search() -> flask.Response:
    """AI Search: the agent loop with the ``web_search`` tool."""
    cfg = llm.ai_cfg()
    if not (_enabled() and llm.configured(cfg)):
        flask.abort(404)
    payload = sxng_request.get_json(silent=True) or {}
    if not llm.check_token(str(payload.get("tk") or "")):
        flask.abort(403)
    q = str(payload.get("q") or "").strip()
    if not q:
        flask.abort(422)
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
    lang = str(payload.get("lang") or "").strip()
    if lang in ("", "all", "auto"):
        lang = "en"

    raw_search_language = str(payload.get("search_language") or "").strip()
    if raw_search_language.lower() in ("", "auto", "all"):
        raw_search_language = ""
    state = _Searches(
        sxng_request.preferences, list(sxng_request.user_plugins), sources_base, search_language=raw_search_language
    )
    events = agent.run_agent(
        cfg,
        _initial_messages(q, lang, history, sources_base, mode),
        tools=_tool_spec(),
        executor=state.execute,
        max_rounds=_budget("max_rounds", mode, 2),
        max_calls_total=_budget("max_calls_total", mode, 8),
        deadline=time.monotonic() + float(_budget("budget_seconds", mode, 300)),
    )
    try:
        first = next(events)
    except StopIteration:
        # an upstream that answers 200 with zero events (empty gateways do)
        first = ("error", RuntimeError("upstream returned an empty stream"))
    if first[0] == "error":
        logger.warning("zjsearch_ai_search: upstream failed before the first line: %s", first[1])
        resp = flask.Response(f"AI upstream error: {llm.reason_of(first[1])}", status=502, mimetype="text/plain")
        resp.headers["Cache-Control"] = "no-cache"
        return resp
    # the executor serializes results through Jinja -- keep the request
    # context alive while the response streams
    resp = flask.Response(
        flask.stream_with_context(_generate(first, events, cfg, q, lang)), mimetype="application/x-ndjson"
    )
    resp.headers["X-Accel-Buffering"] = "no"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


def install(app: flask.Flask) -> None:
    """Register the AI Search route; chained from the package install.
    Stays off unless ``zjsearch.ai.search.enabled`` and the shared
    transport are fully configured."""
    cfg = llm.ai_cfg()
    if not _enabled():
        return
    if not llm.configured(cfg):
        logger.warning("zjsearch.ai.search is enabled but the transport is missing -- AI search stays off")
        return
    kind = llm.endpoint(cfg)[0]
    package = llm.SDK_PACKAGES[kind]
    if importlib.util.find_spec(package) is None:
        logger.warning(
            "zjsearch.ai.search: the %r transport needs the %r package -- AI search stays off", kind, package
        )
        return
    app.add_url_rule("/ai/search", "zjsearch_ai_search", _search, methods=["POST"])
