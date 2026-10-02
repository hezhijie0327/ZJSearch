# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the tool executor -- real instance searches and page reads.

:class:`Searches` runs one round of model calls in a worker pool:
``web_search`` as the REAL ``SearchWithPlugins`` webapp path (plugins,
preferences and the site operators included) and ``web_reader``
through the Browserless reader.  It owns the run's registries (the
global ``[n]`` numbering, dedup, the gallery whitelist), compiles the
compact ``[n]`` feed the writer reads, yields the feature events for
the wire protocol and carries the model-facing budget notes
(Vane's per-iteration awareness, in canonical-messages form).
"""

import concurrent.futures
import json
import logging
import time
import typing as t
from urllib.parse import urlsplit

import flask

from searx.extended_types import sxng_request
from searx.search import SearchWithPlugins
from searx.webadapter import get_search_query_from_webapp
from searx.zjsearch.ai.capabilities import calculator, mcp, reader
from searx.zjsearch.ai.capabilities import past_research as past_research_cap
from searx.zjsearch.ai.capabilities import user_memory as user_memory_cap
from searx.zjsearch.ai.runtime.coverage import Coverage
from searx.zjsearch.ai.runtime.feed import RESULTS_CAP, build_search_feed, serialize_results
from searx.zjsearch.ai.runtime.prompts import STALL_NOTE
from searx.zjsearch.ai.runtime.rank import RERANK_HEAD, bm25_order, rerank_doc, rerank_order
from searx.zjsearch.ai.runtime.registry import SourcesRegistry
from searx.zjsearch.ai.runtime.tools import (
    ASK_TOOL,
    PAGE_TOOL,
    parse_call,
    parse_page_call,
    parse_task_call,
    TASK_TOOL,
)

logger = logging.getLogger(__name__)

MAX_PARALLEL = 3
"""Worker threads per parallel batch -- uncapped per-round call counts
(the model's call) queue behind these few slots so a chatty round cannot
stampede the instance.  Every queued search gets to run; each engine
request carries its own per-request timeout, which is what bounds a
batch -- no artificial wall clock."""

_FEED_SOFT_LIMIT = 24_000
"""Accumulated feed size at which the executor tells the model to start
converging -- the context-pressure signal reaches the MODEL (with the
round's tool results) instead of only shaping the writer's input."""


class Searches:  # pylint: disable=too-few-public-methods, too-many-instance-attributes
    """The ``web_search`` executor: real instance searches in a worker
    pool.  Yields the feature events for the wire protocol and ends with
    the agent framework's ``("tool_results", ...)`` alignment."""

    def __init__(  # pylint: disable=too-many-arguments
        self,
        prefs: t.Any,
        user_plugins: list[str],
        sources_base: int = 0,
        user_memories: list[dict[str, str]] | None = None,
        past_research_entries: list[dict[str, str]] | None = None,
        search_language: str = "",
        max_rounds: int = 0,
        lang: str = "",
        cfg: dict[str, t.Any] | None = None,
    ):
        self.prefs = prefs
        self.user_plugins = user_plugins
        self.search_language = search_language
        self.max_rounds = max_rounds
        self.lang = lang
        self.cfg = cfg or {}
        self.round_no = 0
        # the browser's user-memory snapshot (pre-sent with the run): the
        # user_memory tool searches it; saves flow back as wire events
        self.user_memories = user_memories or []
        # the past-research index (reader pages WITH text heads + corpus
        # sources identity-only): the tool's matches get numbered as real
        # history sources -- full-text matches return their content head,
        # source-only matches point back at web_reader for a live re-read
        self.past_research_entries = past_research_entries or []
        # the run's source registries (the [n] numbering, the two dedup
        # sets, the gallery whitelist) -- one object, see registry.py
        self.reg = SourcesRegistry(sources_base)
        # the task card's coverage tracker (coverage.py)
        self.coverage = Coverage()
        # the accumulated source feed for the WRITER: one block per search
        # (its [n] lines) and per page read -- the writer's whole context
        self.feed: list[str] = []
        # the run's inline image galleries (validated zjs-images fences):
        # index -> items -- the answer's {{zjs-gallery:i}} placeholders
        # reference these
        self.galleries: list[list[dict[str, t.Any]]] = []
        # total feed characters (the context-pressure signal for the model)
        self.feed_chars = 0
        self.size_noted = False
        # progress bookkeeping for the stall detector: fresh queries with
        # results / fresh page reads in the CURRENT round, and the
        # consecutive-round count of rounds without any
        self.round_new_hits = 0
        self.stalled_rounds = 0
        # whether the CURRENT round queued real gathering work (searches,
        # page reads, MCP calls, past-research lookups) -- a round of pure
        # bookkeeping (plan writes, learnings, memory saves) is neither
        # progress nor stall for the detector
        self.round_gathered = False
        # the rerank model's account (zjsearch.rerank): one entry per
        # endpoint call + its prompt tokens -- the settle folds it into
        # ``usage.rerank`` and the knowledge base's model stats sum it
        self.rerank_usage = {"calls": 0, "tokens": 0}

    @property
    def next_n(self) -> int:
        """The global [n] counter (the route's past-source numbering base
        continues after it)."""
        return self.reg.next_n

    @next_n.setter
    def next_n(self, value: int) -> None:
        self.reg.next_n = value

    def _search_one(
        self, query: str, category: str, time_range: str, include: list[str], exclude: list[str]
    ) -> list[t.Any]:
        """One real instance search -- the webapp path with a synthesized
        form (user preferences apply: safesearch, engines; the page's
        result language filter applies via ``search_language``).  The site
        filters travel as ``site:``/``-site:`` operators in the query: the
        advanced_search_syntax plugin strips them from the engine query and
        enforces them authoritatively on every result.  Runs in a worker
        thread inside a COPIED request context (the executor submits it
        wrapped in ``copy_current_request_context``): SearchWithPlugins
        stores the request proxy and ``search()`` copies the context again
        for each of its engine threads."""
        parts = [f"site:{host}" for host in include] + [f"-site:{host}" for host in exclude]
        if parts:
            query = f"{query} {' '.join(parts)}"
        form = {"q": query, "categories": category}
        if time_range:
            form["time_range"] = time_range
        if self.search_language:
            form["language"] = self.search_language
        search_query, _raw, _unknown, _notoken, _locale = get_search_query_from_webapp(self.prefs, form)
        search_obj = SearchWithPlugins(search_query, sxng_request, self.user_plugins)
        return search_obj.search().get_ordered_results()

    def _ranked(self, query: str, raw: list[t.Any]) -> list[t.Any]:
        """One search's results through the ranking cascade: engine order
        -> BM25 text relevance -> the rerank model re-scoring the head.
        Every stage fails open into the previous order (rank.py); the
        rerank model's token usage joins the run's account (the settle
        carries it as ``usage.rerank``)."""
        try:
            order = bm25_order(query, raw)
            if order is None:
                return raw
            head = order[:RERANK_HEAD]
            if len(head) >= 2:
                sub_order, tokens = rerank_order(query, [rerank_doc(raw[i]) for i in head])
                if tokens:
                    self.rerank_usage["calls"] += 1
                    self.rerank_usage["tokens"] += tokens
                if sub_order is not None:
                    order = [head[i] for i in sub_order] + order[RERANK_HEAD:]
            return [raw[i] for i in order]
        except Exception:  # pylint: disable=broad-except
            # one odd result shape must never take the round's remaining
            # settlements down with it -- the engine order stands
            logger.exception("zjsearch_ai_search: ranking cascade failed -- keeping the engine order")
            return raw

    def _finish(  # pylint: disable=too-many-locals, too-many-branches, too-many-statements
        self,
        rnd: int,
        idx: int,
        query: str,
        category: str,
        dedup_key: str,
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
            yield ("call", {"call": idx, "status": "error", "n": 0, "ms": ms})
            return
        # the dedup mark lands on COMPLETION, never at plan time: a query
        # whose engines errored stays retryable (an executed query -- empty
        # or not -- is honestly remembered; its outcome is in the feed)
        self.reg.note_query(dedup_key, query)
        raw = self._ranked(query, raw)
        items = serialize_results(raw, query)
        if items:
            self.round_new_hits += 1
        feed_block, entries = build_search_feed(self.reg, query, category, items)
        for entry in entries:
            entry["round"] = rnd
            entry["id"] = idx
        feeds[idx - 1] = feed_block
        self.feed.append(feeds[idx - 1])
        self.feed_chars += len(feeds[idx - 1])
        # the task card's coverage tracking with the REAL titles: the
        # matched subtask goes active/done and the fresh [n] numbers ride
        # it as provenance (the card's per-subtask source count)
        if self.coverage.task_list:
            titles = [str(entry.get("title") or "") for entry in entries]
            self.coverage.track(query, titles, [int(entry["n"]) for entry in entries])
        yield ("call", {"call": idx, "status": "ok", "n": len(items), "ms": ms})
        if entries:
            yield ("sources", {"items": entries})

    def _read_one(self, url: str) -> tuple[str, str]:
        """One ``web_reader`` read -- Browserless render + extraction over
        the instance's default network; needs no request context."""
        return reader.read_page(url)

    def _finish_page(
        self,
        rnd: int,
        idx: int,
        url: str,
        fut: "concurrent.futures.Future[tuple[str, str]]",
        started: float,
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        ms = int((time.monotonic() - started) * 1000)
        try:
            title, text = fut.result()
        except Exception as exc:  # pylint: disable=broad-except
            # PageReadError or a worker-level surprise -- one dead-end line
            # for the model, an error row for the client
            logger.warning("zjsearch_ai_search: page %d/%d failed (%s): %r", rnd, idx, url[:120], exc)
            feeds[idx - 1] = f"error: {str(exc)[:300] or type(exc).__name__}"
            yield ("call", {"call": idx, "status": "error", "url": url, "ms": ms})
            return
        norm = reader.normalize_url(url)
        # the read's dedup mark lands on COMPLETION, never at plan time: a
        # page whose read failed stays retryable
        self.reg.note_read(norm)
        known_n = self.reg.known(norm)
        if known_n is not None:
            n = known_n
            cite = f"source [{n}] (already among your sources -- cite it as [{n}])"
        else:
            n = self.reg.mint()
            self.reg.note_url(norm, n)
            cite = f"NEW source [{n}] -- cite it as [{n}]"
        netloc = urlsplit(url).netloc
        feeds[idx - 1] = f'Opened {url} (title: "{title}"; {cite}):\n\n{text}'
        self.feed.append(feeds[idx - 1])
        self.feed_chars += len(feeds[idx - 1])
        self.round_new_hits += 1
        # the read's subtask coverage with the REAL title: the matched
        # subtask goes done and the opened page's [n] rides its provenance
        if self.coverage.task_list:
            self.coverage.track(url, [title], [n])
        # the read page always rides a sources event FIRST: a NEW url
        # registers its card, an already-numbered one re-emits its [n] with
        # ``crawled`` set -- the client upgrades the existing card in place
        # (the read-in-full badge marks what the model verified
        # first-hand).  Sources lead so the call settlement below can look
        # the title up on the card when it archives the page.
        yield (
            "sources",
            {
                "items": [
                    {
                        "n": n,
                        "round": rnd,
                        "id": idx,
                        "idx": 0,
                        "title": title,
                        "url": url,
                        "netloc": netloc,
                        "favicon": "",
                        "pretty_url": url,
                        "published_date": "",
                        "crawled": True,
                    }
                ]
            },
        )
        # the row settlement is a CALL event (wire v2's closed set -- the
        # reader's payload rides the row exactly like an MCP preview):
        # chars for the count, text for the READING PANE (what did the
        # model actually see?) and the reader-cache archive.  The pre-v2
        # tuple name "page" never joined the closed set -- every
        # successful read crashed the whole stream with
        # ``unknown wire event: 'page'``.
        yield (
            "call",
            {
                "call": idx,
                "status": "ok",
                "url": url,
                "ms": ms,
                "chars": len(text),
                "text": text,
            },
        )

    def execute(  # pylint: disable=too-many-branches, too-many-statements, too-many-locals
        self, calls: list[dict[str, t.Any]]
    ) -> t.Iterator[tuple[str, t.Any]]:
        """Run one round of calls in parallel -- ``web_search`` and
        ``web_reader`` calls share the worker pool; feature events flow to
        the client while they complete.  Wire ids are the 1-based position
        of the call within this round.  Exact-duplicate queries and
        already-read pages settle instantly as ``duplicate`` -- they never
        hit the engines or the browser again; their feed tells the model
        to move on (the dedup marks are taken at COMPLETION: a failed
        search or read stays retryable).  The round's tool results also
        carry the budget / context-pressure / progress notes: that is how
        the MODEL learns where the run stands (the static system prompt
        only states the policy once)."""
        self.round_no += 1
        rnd = self.round_no
        self.round_new_hits = 0
        feeds: list[str | None] = [None] * len(calls)
        search_jobs: list[tuple[int, str, str, str, list[str], list[str], str]] = []
        page_jobs: list[tuple[int, str]] = []
        gathered = False
        for wire_id, call in enumerate(calls, 1):
            tool_name = str(call.get("name") or "")
            if tool_name == ASK_TOOL:
                # the ask intercept in the loop handles a SOLO ask call (the
                # prompted shape); one mixed into a parallel batch lands here
                # -- settle the row honestly instead of letting it fall
                # through to the web_search branch's empty-query error
                feeds[wire_id - 1] = (
                    "error: the ask_user tool must be the ONLY call of its turn -- ask again alone in the next turn."
                )
                yield ("call", {"call": wire_id, "status": "error", "q": ""})
                continue
            if tool_name == calculator.CALCULATOR_TOOL:
                feed, event = calculator.evaluate_call(call, rnd, wire_id)
                feeds[wire_id - 1] = feed
                yield ("call", {"call": wire_id, "status": event.get("status", "ok"), "result": event.get("result")})
                continue
            if tool_name == TASK_TOOL:
                items = parse_task_call(call)
                # the research plan: the orchestrator decomposes the request
                # into facets -- the task card tracks which facets have
                # sources, the researcher follows the plan step by step
                self.coverage.task_list = items
                yield ("tasks", {"round": rnd, "id": wire_id, "items": items})
                done = sum(1 for item in items if item["status"] == "done")
                summary = f"{done}/{len(items)}"
                # the row settles like every other (a plan write is instant
                # work -- leaving it pending read as 已中断 at the settle)
                yield ("call", {"call": wire_id, "status": "ok", "q": summary})
                feeds[wire_id - 1] = (
                    f"plan written: {done}/{len(items)} subtasks covered."
                    " Search each subtask's keywords; a subtask with sources"
                    " is marked done automatically."
                )
                continue
            if tool_name == past_research_cap.PAST_RESEARCH_TOOL:
                query = past_research_cap.parse_query(call)
                matches = past_research_cap.rank(self.past_research_entries, query)
                gathered = True
                if matches:
                    events: list[dict[str, t.Any]] = []
                    blocks: list[str] = []
                    for entry in matches:
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
                            blocks.append(
                                f"[{n}] {entry['title']} -- {entry['url']}\n"
                                "(past source, identity only -- re-read it with"
                                f" {PAGE_TOOL} before relying on its details.)"
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
                    feeds[wire_id - 1] = (
                        "from the user's PAST research (may be outdated --"
                        " live sources take precedence):\n\n" + "\n\n".join(blocks)
                    )
                    if events:
                        yield ("sources", {"items": events})
                else:
                    feeds[wire_id - 1] = "(no page in the user's past research matches -- continue with live search)"
                yield ("call", {"call": wire_id, "status": "ok", "n": len(matches)})
                continue
            if tool_name == user_memory_cap.USER_MEMORY_TOOL:
                feed, event = user_memory_cap.evaluate_call(call, self.user_memories)
                feeds[wire_id - 1] = feed
                if event:
                    # a save: the row event settles the timeline AND the
                    # late memory event persists the fact client-side
                    save_event = event
                    yield (
                        "call",
                        {"call": wire_id, "status": "ok", "action": "save", "label": save_event["content"]},
                    )
                    yield ("memory", save_event)
                else:
                    yield (
                        "call",
                        {
                            "call": wire_id,
                            "status": "ok",
                            "action": "search",
                            "label": str(self._raw_json(call).get("query") or ""),
                        },
                    )
                continue
            if tool_name == mcp.SEARCH_TOOL:
                # progressive disclosure: the discovery tool returns the
                # matched tools' full schemas (a text result like any other)
                gathered = True
                feeds[wire_id - 1] = mcp.search_mcp_tools(str(self._raw_json(call).get("query") or ""))
                yield ("call", {"call": wire_id, "status": "ok", "preview": ""})
                continue
            if tool_name.startswith("mcp_"):
                gathered = True
                feed = mcp.call_mcp_tool_sync(tool_name, self._raw_json(call))
                feeds[wire_id - 1] = feed
                # progressive disclosure: the row's preview is the head of
                # what came back (the full text rode the feed to the model)
                yield (
                    "call",
                    {"call": wire_id, "status": "ok", "name": tool_name, "preview": feed[:600]},
                )
                continue
            if str(call.get("name") or "") == PAGE_TOOL:
                feed, event, page_url = self._page_plan(call, wire_id)
                if feed:
                    feeds[wire_id - 1] = feed
                if event:
                    yield ("call", event)
                if page_url:
                    page_jobs.append((wire_id, page_url))
                    gathered = True
                    # the early active-mark: the subtask this url shape
                    # points at is being researched (the done-marking with
                    # the real title runs at settlement)
                    self.coverage.track(page_url, [page_url])
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
        # the pool is deliberately NOT in a with-block: when the consumer
        # disappears (client disconnect / stop) the generator closes right
        # here -- a with-exit would wait for the still-running work and
        # stall the shutdown
        total = len(search_jobs) + len(page_jobs)
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=min(max(1, total), MAX_PARALLEL))
        try:
            yield from self._dispatch(pool, rnd, search_jobs, page_jobs, feeds)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        # Jina's failure-becomes-information: an unproductive round tells
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
        # the model-facing budget note rides the round's tool results: the
        # next turn reads it with the results it describes (Vane injects
        # the iteration counter into the system prompt every turn -- this
        # is the cheap canonical-messages equivalent)
        if self.max_rounds and rnd == self.max_rounds - 1:
            self._append_note(
                feeds,
                "(budget note: ONE research round remains -- make it cover the most important remaining gaps.)",
            )
        elif self.feed_chars > _FEED_SOFT_LIMIT and not self.size_noted:
            self.size_noted = True
            self._append_note(
                feeds,
                "(note: the source context is getting large -- start converging:"
                " prefer answering from what you have over opening more pages.)",
            )
        yield (
            "tool_results",
            [(calls[idx], str(feed or "error: the call failed")) for idx, feed in enumerate(feeds)],
        )
        # the task card's current state: coverage ran at queue time
        # (active) and per-settlement in _finish (done + provenance) --
        # this re-emission syncs the card after the round's results
        yield ("tasks", {"items": [dict(t) for t in self.coverage.task_list]})

    def _search_plan(self, call: dict[str, t.Any], wire_id: int) -> tuple[str, dict[str, t.Any] | None, tuple | None]:
        """One ``web_search`` call's pre-pool plan: (feed, settle event,
        pool job) -- an empty query errors here, an exact repeat of an
        earlier round's query (site filters included) settles as a
        duplicate, a fresh query is queued; the dedup mark itself is taken
        at completion (a failed search stays retryable)."""
        query, category, time_range, include, exclude = parse_call(call)
        if not query:
            return "error: empty query", {"call": wire_id, "status": "error", "n": 0, "ms": 0}, None
        dedup_key = " ".join((query + " " + " ".join(f"site:{h}" for h in include + exclude)).lower().split())
        if dedup_key in self.reg.ran:
            return (
                "duplicate: this exact query already ran in an earlier"
                " round and its outcome is already in the conversation"
                " (possibly empty) -- do not repeat it; search a DIFFERENT"
                " facet or write the answer from the sources you have.",
                {"call": wire_id, "status": "duplicate", "n": 0, "ms": 0},
                None,
            )
        return "", None, (wire_id, query, category, time_range, include, exclude, dedup_key)

    def _page_plan(self, call: dict[str, t.Any], wire_id: int) -> tuple[str, dict[str, t.Any] | None, str | None]:
        """One ``web_reader`` call's pre-pool plan: (feed, settle event,
        url-to-read) -- errors and duplicates settle here, a fresh url is
        queued; the read's dedup mark is taken at completion (a failed
        read stays retryable)."""
        raw_url = parse_page_call(call)
        url = reader.normalize_url(raw_url)
        if not raw_url:
            return "error: empty url", {"call": wire_id, "status": "error", "url": "", "ms": 0}, None
        if url in self.reg.read_urls:
            return (
                "duplicate: this exact page was already opened in an"
                " earlier round and its content is already in the"
                " conversation -- do not re-read it.",
                {"call": wire_id, "status": "duplicate", "url": url, "ms": 0},
                None,
            )
        self.reg.note_read(url)
        return "", None, url

    @staticmethod
    def _raw_json(call: dict[str, t.Any]) -> dict[str, t.Any]:
        """The model's raw call arguments as a dict (the MCP bridge passes
        them to the server verbatim under the tool's own schema)."""
        try:
            value = json.loads(str(call.get("arguments") or "") or "{}")
        except ValueError:
            return {}
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _append_note(feeds: list[str | None], note: str) -> None:
        """Append a model-facing note to the LAST non-empty feed of the
        round -- one copy is enough (the model reads every tool result of
        the batch).  The rebind deliberately leaves the writer's ``feed``
        blocks untouched: notes steer the conversation, they are not
        source content."""
        for i in range(len(feeds) - 1, -1, -1):
            if feeds[i]:
                feeds[i] = f"{feeds[i]}\n\n{note}"
                return

    def _dispatch(  # pylint: disable=too-many-locals
        self,
        pool: concurrent.futures.ThreadPoolExecutor,
        rnd: int,
        search_jobs: list[tuple[int, str, str, str, list[str], list[str], str]],
        page_jobs: list[tuple[int, str]],
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        futures: dict[concurrent.futures.Future, tuple[str, int, tuple[t.Any, ...]]] = {}
        for wire_id, query, category, time_range, include, exclude, dedup_key in search_jobs:
            # the worker needs a request context of its own: SearchWithPlugins
            # stores the request proxy and search() copies the context again
            # for each of its engine threads (mirrors the webapp view thread)
            worker = flask.copy_current_request_context(self._search_one)
            futures[pool.submit(worker, query, category, time_range, include, exclude)] = (
                "search",
                wire_id,
                (query, category, dedup_key, time.monotonic()),
            )
        for wire_id, url in page_jobs:
            futures[pool.submit(self._read_one, url)] = ("page", wire_id, (url, time.monotonic()))
        pending = dict(futures)
        # no batch wall clock: every queued call gets to run and every
        # engine request / page read carries its own per-request timeout,
        # which is what bounds a batch -- the user's stop button is the
        # only control
        while pending:
            done, _not_done = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
            for fut in done:
                kind, wire_id, args = pending.pop(fut)
                if kind == "search":
                    query, category, dedup_key, started = args
                    yield from self._finish(rnd, wire_id, query, category, dedup_key, fut, started, feeds)
                else:
                    url, started = args
                    yield from self._finish_page(rnd, wire_id, url, fut, started, feeds)


def round_progress(state: Searches, stall_rounds: int) -> t.Callable[[int], str | None]:
    """The progress-based termination policy: called by the agent loop
    after each executed round.  A round is PRODUCTIVE when at least one
    fresh query returned results; ``stall_rounds`` consecutive
    unproductive rounds end the research (the returned message explains
    the staleness to the model).  Productive research is UNLIMITED; a
    round of pure bookkeeping (plan writes, memory saves) is neither
    progress nor stall."""

    def verdict(_round_no: int) -> str | None:
        if not state.round_gathered:
            return None
        if state.round_new_hits > 0:
            state.stalled_rounds = 0
            return None
        state.stalled_rounds += 1
        if state.stalled_rounds < stall_rounds:
            return None
        return STALL_NOTE

    return verdict
