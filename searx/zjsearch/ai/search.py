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
  a parallel batch announced;
- ``{"e": "search", "round", "id", "status", "n", "ms"}`` -- one search
  finished (ok / error / timeout);
- ``{"e": "results", "round", "id", "results"}`` -- page-data-shaped
  result list of that search;
- ``{"e": "sources", "items": [{n, round, id, idx, ...}]}`` -- the global
  ``[n]`` registry entries (citation chips jump to ``round``/``id``/``idx``);
- ``{"e": "error", "reason"}`` mid-stream, ``{"e": "end"}`` closes.

A stream that dies before its first line answers 502 with a truncated
upstream reason (same contract as the AI Overview).  Configuration: the
transport is the shared ``zjsearch.ai`` block; this feature ships
disabled and opts in via ``zjsearch.ai.search.enabled``.
"""

import concurrent.futures
import datetime
import importlib.util
import json
import logging
import time
import typing as t
from html import escape

import flask

from searx.extended_types import sxng_request
from searx.search import SearchWithPlugins
from searx.webadapter import get_search_query_from_webapp
from searx.webutils import highlight_content
from searx.zjsearch.ai import agent, llm

logger = logging.getLogger(__name__)

TOOL_NAME = "web_search"

SEARCH_CATEGORIES = ("general", "news", "images", "videos", "it", "science", "files", "music")
"""The verticals the model may pick; each has a dedicated client layout."""

SEARCH_TIMEOUT = 25.0
"""Wall-clock budget for one parallel batch of searches (engines carry
their own per-request timeouts; this guards the executor)."""

MAX_PARALLEL = 4
"""Worker threads per batch -- the per-round call cap mirrors it."""

RESULTS_CAP = 30
"""Results per search sent to the client (the model only sees the feed)."""

FEED_DEEP = 5
FEED_SHALLOW = 5
FEED_SNIPPET_CHARS = 300
"""The model's compacted view of one search: 5 deep (title + snippet
head) + 5 shallow (title only), numbered with the global [n] registry."""


SEARCH_MODES = ("speed", "balanced", "quality")

_MODE_BUDGETS: dict[str, dict[str, int]] = {
    # speed: one focused round; balanced: main facets, optional gap-filler;
    # quality: multi-round deep research with cross-verification
    "speed": {"max_rounds": 1, "max_calls_per_round": 2, "max_calls_total": 3, "budget_seconds": 150},
    "balanced": {"max_rounds": 2, "max_calls_per_round": 3, "max_calls_total": 6, "budget_seconds": 240},
    "quality": {"max_rounds": 4, "max_calls_per_round": 4, "max_calls_total": 10, "budget_seconds": 420},
}


def _cfg() -> dict[str, t.Any]:
    """The ``zjsearch.ai.search`` settings block."""
    cfg = llm.ai_cfg().get("search")
    return cfg if isinstance(cfg, dict) else {}


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
    if not (_cfg().get("enabled") and llm.configured(cfg)):
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
            " parallel calls over one broad query. Results arrive as globally"
            " numbered [n] sources to cite in the final answer."
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
            },
            "required": ["query"],
        },
    }


_SYSTEM_PROMPT = """\
You are the "AI Search" mode of the zjsearch metasearch engine: the user
asks a question, YOU decide which keyword searches answer it, run them
with the {tool} tool, then answer from their numbered sources.
Today is {today}.
How to search:
- First write ONE short sentence stating how you read the question's
  intent (the UI shows it as the lead of your search plan). Then call
  {tool} -- several calls in the same turn are encouraged: they run in
  parallel.
- ALWAYS run at least one {tool} call before writing the final answer --
  even for topics you already know: the user expects live, cited sources,
  not your memory.  No search results, no answer.
- No search-engine operators (site:, filetype:, "quotes") and no !bangs.
- If the first round leaves a real gap, run at most one more round; never
  repeat a query you already ran.
- When the sources suffice, write the final answer WITHOUT tool calls.
Answer rules:
- Write the answer in {lang}.
- Cite sources right after the statements they support: [1] for one
  source, [1,3] for several. Use [*] only for common knowledge that no
  source covers. Source numbers are the global [n] labels your search
  results carry.
- Format freely in GitHub-flavored markdown -- the renderer supports all
  of it: "## " section headings, bullet / numbered lists, **bold**,
  tables for comparisons, > blockquotes for short source quotes, `inline
  code` and fenced code blocks, definition lists, emoji shortcodes like
  :tada: used sparingly, and links when a source URL genuinely helps.
- When a diagram clarifies structure or flow better than prose, emit a
  ```mermaid fenced block (flowchart, sequence, state, ER, gantt, pie,
  mindmap, timeline).  Keep diagrams small -- around 15 nodes at most --
  and quote every node label that contains punctuation or parentheses.
- Math typesets as real equations -- write LaTeX: inline $E=mc^2$ or
  display $$\\\\int_0^1 f(x)\\\\,dx$$ blocks.  Each formula appears ONCE, in
  LaTeX only.  No raw HTML and no markdown images.
- If the searches do not answer the question, say so in one short line
  and answer from common knowledge marked with [*].
- Get to the point in the first sentence. No preamble, no closing remark.
"""  # noqa: E501  (the formatting rules mirror ai/overview.py -- keep in sync)

_RESULT_TEMPLATE = (
    '{%- from "zjsearch/data/macros.html" import result_data with context -%}'
    # the separator is a block-if ON PURPOSE: inline-if string literals come
    # out autoescaped ("&#34;, &#34;") and break the JSON (the repo gotcha)
    '[{%- for result in results %}{% if not loop.first %},{% endif %}{{ result_data(result) }}{%- endfor %}]'
)


def _initial_messages(
    question: str,
    lang: str,
    history: list[dict[str, str]],
    sources_base: int,
    depth: str,
) -> list[dict[str, t.Any]]:
    system = _SYSTEM_PROMPT.format(today=datetime.date.today().isoformat(), lang=lang, tool=TOOL_NAME)
    if sources_base:
        system += (
            f"\nThis is a follow-up in an ongoing research session: sources"
            f" [1]..[{sources_base}] were already found in earlier turns. Your"
            f" new searches continue the numbering from [{sources_base + 1}]."
            " Cite earlier sources by their numbers when they support the"
            " answer -- but unless they already answer THIS follow-up"
            " completely, run at least one fresh web_search for its"
            " specifics: never answer from the conversation history alone."
        )
    system += {
        "speed": "\nDepth: SPEED -- cover the question with one focused round and a"
        " compact answer; do not run extra rounds.",
        "balanced": "\nDepth: BALANCED -- cover the question's main facets in one"
        " round; run a second round only for a real gap.",
        "quality": "\nDepth: QUALITY -- you may use up to several rounds and"
        " cross-verify key claims against independent sources, but run only as"
        " many searches as the question actually needs; a simple question may"
        " need just one. Cover definitions, mechanics, comparisons and recent"
        " developments before synthesizing.",
    }.get(depth, "\nDepth: BALANCED.")
    messages: list[dict[str, t.Any]] = [{"role": "system", "content": system}]
    for turn in history:
        messages.append({"role": "user", "content": f"<q>{turn.get('q') or ''}</q>"})
        messages.append({"role": "assistant", "content": str(turn.get("a") or "")[:2000]})
    messages.append({"role": "user", "content": f"<q>{question}</q>"})
    return messages


def _parse_call(call: dict[str, t.Any]) -> tuple[str, str]:
    """(query, category) of one tool call -- sanitized: bangs stripped,
    whitespace collapsed, category whitelist-checked."""
    try:
        args = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    query = str(args.get("query") or "").replace("!", "")
    query = " ".join(query.split())[:200]
    category = str(args.get("category") or "general").strip().lower()
    if category not in SEARCH_CATEGORIES:
        category = "general"
    return query, category


def _serialize(raw_results: list[t.Any], query: str) -> list[dict[str, t.Any]]:
    """Ordered results as page-data-shaped dicts -- highlighted like the
    search view does, serialized through the very ``_result_data`` macro
    the page payload uses (runs in the request thread)."""
    for result in raw_results:
        if "content" in result and result["content"]:
            result["content"] = highlight_content(escape(result["content"][:1024]), query)
        if "title" in result and result["title"]:
            result["title"] = highlight_content(escape(result["title"] or ""), query)
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
    except (ValueError, TypeError) as exc:
        logger.warning(
            "zjsearch_ai_search: result serialization failed: %r -- head: %.240r",
            exc,
            rendered if isinstance(rendered, str) else b"",
        )
        return []


class _Searches:  # pylint: disable=too-few-public-methods
    """The ``web_search`` executor: real instance searches in a worker
    pool.  Yields the feature events for the wire protocol and ends with
    the agent framework's ``("tool_results", ...)`` alignment."""

    def __init__(self, prefs: t.Any, user_plugins: list[str], sources_base: int = 0):
        self.prefs = prefs
        self.user_plugins = user_plugins
        self.round_no = 0
        # follow-up runs continue the global [n] numbering after the base
        self.next_n = sources_base + 1

    def _search_one(self, query: str, category: str) -> list[t.Any]:
        """One real instance search -- the webapp path with a synthesized
        form (user preferences apply: language, safesearch, engines).
        Runs in a worker thread inside a COPIED request context (the
        executor submits it wrapped in ``copy_current_request_context``):
        SearchWithPlugins stores the request proxy and ``search()`` copies
        the context again for each of its engine threads."""
        form = {"q": query, "categories": category}
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
        submittable = [(idx, query, category) for idx, (query, category) in enumerate(prepared) if query]
        # the pool is deliberately NOT in a with-block: after the batch
        # deadline the timeout events must stream immediately -- a with-exit
        # would wait for the still-running searches and stall the response
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=min(max(1, len(submittable)), MAX_PARALLEL))
        try:
            yield from self._dispatch(pool, rnd, submittable, feeds)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        for wire_id, (query, _category) in enumerate(prepared, 1):
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
        submittable: list[tuple[int, str, str]],
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        futures: dict[concurrent.futures.Future, tuple[int, float]] = {}
        for idx, query, category in submittable:
            # the worker needs a request context of its own: SearchWithPlugins
            # stores the request proxy and search() copies the context again
            # for each of its engine threads (mirrors the webapp view thread)
            worker = flask.copy_current_request_context(self._search_one)
            futures[pool.submit(worker, query, category)] = (idx + 1, time.monotonic())
        pending = dict(futures)
        batch_deadline = time.monotonic() + SEARCH_TIMEOUT
        while pending:
            timeout = batch_deadline - time.monotonic()
            if timeout <= 0:
                break
            done, _not_done = concurrent.futures.wait(
                pending, timeout=timeout, return_when=concurrent.futures.FIRST_COMPLETED
            )
            for fut in done:
                wire_id, started = pending.pop(fut)
                _idx, query, category = submittable[wire_id - 1]
                yield from self._finish(rnd, wire_id, query, category, fut, started, feeds)
        for fut, (wire_id, _started) in pending.items():
            fut.cancel()
            feeds[wire_id - 1] = feeds[wire_id - 1] or "error: the search timed out"
            yield (
                "search",
                {"round": rnd, "id": wire_id, "status": "timeout", "n": 0, "ms": int(SEARCH_TIMEOUT * 1000)},
            )


def _display_item(idx: int, call: dict[str, t.Any]) -> dict[str, t.Any]:
    query, category = _parse_call(call)
    return {"id": idx, "q": query, "category": category}


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
        if kind == "error":
            return json.dumps({"e": "error", "reason": llm.reason_of(payload)}, ensure_ascii=False) + "\n"
        return json.dumps({"e": kind, **payload}, ensure_ascii=False) + "\n"

    # reasoning-channel guard: some models (LM Studio + qwen3.6) route the
    # whole answer into the think stream and leave the content channel empty
    # -- promote the final turn's reasoning so the user always gets a
    # readable answer
    think_parts: list[str] = []
    answer_parts: list[str] = []

    yield emit(*first)
    for event in events:
        kind, payload = event
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
    if not answer_text and think_parts:
        # the model routed the whole answer into the reasoning channel:
        # promote it so the user always gets a readable answer
        promoted = "".join(think_parts).strip()
        yield emit("delta", promoted)
        answer_parts.append(promoted)
        answer_text = promoted
    if answer_text:
        try:
            related = _related_questions(cfg, question, answer_text, lang)
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_ai_search: related questions failed: %r", exc)
            related = []
    else:
        related = []
    # `end` settles the run FIRST so the client's follow-up box opens
    # immediately; the related questions trail as a post-end event (the
    # small completion behind them can think for the better part of a
    # minute on reasoning models)
    yield json.dumps({"e": "end"}, ensure_ascii=False) + "\n"
    if related:
        yield emit("related", {"items": related})


def _search() -> flask.Response:
    """AI Search: the agent loop with the ``web_search`` tool."""
    cfg = llm.ai_cfg()
    if not (_cfg().get("enabled") and llm.configured(cfg)):
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

    state = _Searches(sxng_request.preferences, list(sxng_request.user_plugins), sources_base)
    events = agent.run_agent(
        cfg,
        _initial_messages(q, lang, history, sources_base, mode),
        tools=_tool_spec(),
        executor=state.execute,
        max_rounds=_budget("max_rounds", mode, 2),
        max_calls_per_round=_budget("max_calls_per_round", mode, 4),
        max_calls_total=_budget("max_calls_total", mode, 8),
        deadline=time.monotonic() + float(_budget("budget_seconds", mode, 240)),
    )
    try:
        first = next(events)
    except StopIteration:
        first = ("end", None)
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
    if not _cfg().get("enabled"):
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
