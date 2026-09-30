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
from html import escape
from urllib.parse import urlsplit

import flask

from searx.extended_types import sxng_request
from searx.search import SearchWithPlugins
from searx.webadapter import get_search_query_from_webapp
from searx.webutils import highlight_content
from searx.zjsearch.ai.capabilities import reader
from searx.zjsearch.ai.feature.search.prompts import STALL_NOTE
from searx.zjsearch.ai.feature.search.tools import PAGE_TOOL, parse_call, parse_page_call

logger = logging.getLogger(__name__)

MAX_PARALLEL = 3
"""Worker threads per parallel batch -- uncapped per-round call counts
(the model's call) queue behind these few slots so a chatty round cannot
stampede the instance.  Every queued search gets to run; each engine
request carries its own per-request timeout, which is what bounds a
batch -- no artificial wall clock."""

RESULTS_CAP = 30
"""Results per search sent to the client (the model only sees the feed)."""

FEED_DEEP = 5
FEED_SHALLOW = 5
FEED_SNIPPET_CHARS = 300
"""The model's compacted view of one search: 5 deep (title + snippet
head) + 5 shallow (title only), numbered with the global [n] registry."""

_FEED_SOFT_LIMIT = 24_000
"""Accumulated feed size at which the executor tells the model to start
converging -- the context-pressure signal reaches the MODEL (with the
round's tool results) instead of only shaping the writer's input."""

_GALLERY_POOL_MAX = 40
"""Image URLs the writer may embed (the validated whitelist of the
``zjs-images`` fence): image-bearing results enter the pool as they are
fed, first come first kept."""

_RESULT_TEMPLATE = (
    '{%- from "zjsearch/data/macros.html" import result_data with context -%}'
    # the separator is a block-if ON PURPOSE: inline-if string literals come
    # out autoescaped ("&#34;, &#34;") and break the JSON (the repo gotcha)
    '[{%- for result in results %}{% if not loop.first %},{% endif %}{{ result_data(result) }}{%- endfor %}]'
)


def _serialize(raw_results: list[t.Any], query: str) -> list[dict[str, t.Any]]:
    """Ordered results as page-data-shaped dicts -- highlighted like the
    search view does, serialized through the very ``_result_data`` macro
    the page payload uses (runs in the request thread).  The FEED builder
    consumes them; the client's sources grid rides the ``sources`` event,
    never this serialized payload."""
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


class Searches:  # pylint: disable=too-few-public-methods
    """The ``web_search`` executor: real instance searches in a worker
    pool.  Yields the feature events for the wire protocol and ends with
    the agent framework's ``("tool_results", ...)`` alignment."""

    def __init__(
        self,
        prefs: t.Any,
        user_plugins: list[str],
        sources_base: int = 0,
        search_language: str = "",
        max_rounds: int = 0,
    ):
        self.prefs = prefs
        self.user_plugins = user_plugins
        self.search_language = search_language
        self.max_rounds = max_rounds
        self.round_no = 0
        # follow-up runs continue the global [n] numbering after the base
        self.next_n = sources_base + 1
        # every query this run already executed, normalized -> [query, n
        # results] -- the executor-side dedup (a repeated query settles as
        # ``duplicate`` without hitting the engines)
        self.ran: dict[str, list] = {}
        # every page this run already opened (normalized) -- a re-read
        # settles as ``duplicate`` without rendering again
        self.read_urls: set[str] = set()
        # every source url of this run -> its global [n]: a re-read or a
        # repeat of a known url reuses the number instead of minting a
        # duplicate source (the FEED dedup rides the same registry)
        self.url_n: dict[str, int] = {}
        # image urls fed to the model (img=... lines) -> their global [n]:
        # the validated whitelist of the writer's ``zjs-images`` fence
        self.gallery_pool: dict[str, int] = {}
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

    def _finish(  # pylint: disable=too-many-locals, too-many-branches
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
        if items:
            self.round_new_hits += 1
        entries: list[dict[str, t.Any]] = []
        feed_lines = [f'Search "{query}" (category: {category}) returned {len(items)} results:']
        for pos, item in enumerate(items[: FEED_DEEP + FEED_SHALLOW]):
            url = str(item.get("url") or "")
            norm = reader.normalize_url(url) if url else ""
            known_n = self.url_n.get(norm) if norm else None
            title = str(item.get("title_text") or "")
            netloc = str(item.get("netloc") or "")
            img = str(item.get("img_src") or item.get("thumbnail") or item.get("thumbnail_src") or "")
            if known_n is not None:
                # cross-search dedup: this url already holds a global [n]
                # from an earlier search -- point at it instead of minting
                # a duplicate source (the numbering stays contiguous and
                # the sources grid shows the page once).  The image still
                # joins the gallery pool under its KNOWN number, and an
                # img-bearing UPGRADE entry reaches the client: a parallel
                # page read can number a url before this search does (its
                # entry carries no thumbnail), and without the re-emission
                # the card would never grow one.
                if pos < FEED_DEEP:
                    head = str(item.get("content_text") or "")[:FEED_SNIPPET_CHARS]
                    if img and len(self.gallery_pool) < _GALLERY_POOL_MAX:
                        self.gallery_pool.setdefault(img, known_n)
                    feed_lines.append(f"[{known_n}] {netloc}: {title} - {head} (same source as an earlier result)")
                else:
                    feed_lines.append(f"[{known_n}] {netloc}: {title} (same source as an earlier result)")
                if img:
                    entries.append(
                        {
                            "n": known_n,
                            "round": rnd,
                            "id": idx,
                            "idx": pos,
                            "title": title[:200],
                            "url": url,
                            "netloc": netloc,
                            "favicon": str(item.get("favicon") or ""),
                            "img": img,
                            "pretty_url": str(item.get("pretty_url") or ""),
                            "published_date": str(item.get("published_date") or ""),
                        }
                    )
                continue
            n = self.next_n
            self.next_n += 1
            if norm:
                self.url_n[norm] = n
            if img and len(self.gallery_pool) < _GALLERY_POOL_MAX:
                self.gallery_pool[img] = n
            entries.append(
                {
                    "n": n,
                    "round": rnd,
                    "id": idx,
                    "idx": pos,
                    "title": title[:200],
                    "url": url,
                    "netloc": netloc,
                    "favicon": str(item.get("favicon") or ""),
                    "img": img,
                    "category": str(item.get("category") or ""),
                    "pretty_url": str(item.get("pretty_url") or ""),
                    "published_date": str(item.get("published_date") or ""),
                }
            )
            if pos < FEED_DEEP:
                head = str(item.get("content_text") or "")[:FEED_SNIPPET_CHARS]
                img_part = f" img={img}" if img else ""
                feed_lines.append(f"[{n}] {netloc}: {title} - {head}{img_part}")
            else:
                feed_lines.append(f"[{n}] {netloc}: {title}")
        feeds[idx - 1] = "\n".join(feed_lines)
        self.feed.append(feeds[idx - 1])
        self.feed_chars += len(feeds[idx - 1])
        yield ("search", {"round": rnd, "id": idx, "status": "ok", "n": len(items), "ms": ms})
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
            yield ("page", {"round": rnd, "id": idx, "status": "error", "url": url, "ms": ms})
            return
        norm = reader.normalize_url(url)
        known_n = self.url_n.get(norm)
        if known_n is not None:
            n = known_n
            cite = f"source [{n}] (already among your sources -- cite it as [{n}])"
        else:
            n = self.next_n
            self.next_n += 1
            self.url_n[norm] = n
            cite = f"NEW source [{n}] -- cite it as [{n}]"
        netloc = urlsplit(url).netloc
        feeds[idx - 1] = f'Opened {url} (title: "{title}"; {cite}):\n\n{text}'
        self.feed.append(feeds[idx - 1])
        self.feed_chars += len(feeds[idx - 1])
        self.round_new_hits += 1
        yield (
            "page",
            {
                "round": rnd,
                "id": idx,
                "status": "ok",
                "url": url,
                "title": title,
                "chars": len(text),
                "ms": ms,
                # the extracted readable content rides to the client: the
                # timeline row expands into a READING PANE (what did the
                # model actually see?) -- capped like the feed copy
                "text": text,
            },
        )
        # the read page always rides a sources event: a NEW url registers its
        # card, an already-numbered one re-emits its [n] with ``crawled``
        # set -- the client upgrades the existing card in place (the
        # read-in-full badge marks what the model verified first-hand)
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

    def execute(self, calls: list[dict[str, t.Any]]) -> t.Iterator[tuple[str, t.Any]]:
        """Run one round of calls in parallel -- ``web_search`` and
        ``web_reader`` calls share the worker pool; feature events flow to
        the client while they complete.  Wire ids are the 1-based position
        of the call within this round.  Exact-duplicate queries and
        already-read pages settle instantly as ``duplicate`` -- they never
        hit the engines or the browser again; their feed tells the model
        to move on.  The round's tool results also carry the budget /
        context-pressure notes: that is how the MODEL learns it is nearing
        the ceiling (the static system prompt only states it once)."""
        self.round_no += 1
        rnd = self.round_no
        self.round_new_hits = 0
        feeds: list[str | None] = [None] * len(calls)
        search_jobs: list[tuple[int, str, str, str, list[str], list[str]]] = []
        page_jobs: list[tuple[int, str]] = []
        for wire_id, call in enumerate(calls, 1):
            if str(call.get("name") or "") == PAGE_TOOL:
                raw_url = parse_page_call(call)
                url = reader.normalize_url(raw_url)
                if not raw_url:
                    feeds[wire_id - 1] = "error: empty url"
                    yield ("page", {"round": rnd, "id": wire_id, "status": "error", "url": "", "ms": 0})
                elif url in self.read_urls:
                    feeds[wire_id - 1] = (
                        "duplicate: this exact page was already opened in an"
                        " earlier round and its content is already in the"
                        " conversation -- do not re-read it."
                    )
                    yield ("page", {"round": rnd, "id": wire_id, "status": "duplicate", "url": url, "ms": 0})
                else:
                    self.read_urls.add(url)
                    page_jobs.append((wire_id, url))
                continue
            query, category, time_range, include, exclude = parse_call(call)
            if not query:
                feeds[wire_id - 1] = "error: empty query"
                yield ("search", {"round": rnd, "id": wire_id, "status": "error", "n": 0, "ms": 0})
            else:
                dedup_key = " ".join((query + " " + " ".join(f"site:{h}" for h in include + exclude)).lower().split())
                if dedup_key in self.ran:
                    feeds[wire_id - 1] = (
                        "duplicate: this exact query already ran in an earlier"
                        " round and its results are already in the conversation"
                        " -- do not repeat it; search a DIFFERENT facet or write"
                        " the answer from the sources you have."
                    )
                    yield ("search", {"round": rnd, "id": wire_id, "status": "duplicate", "n": 0, "ms": 0})
                else:
                    self.ran[dedup_key] = [query, 0]
                    search_jobs.append((wire_id, query, category, time_range, include, exclude))
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
        search_jobs: list[tuple[int, str, str, str, list[str], list[str]]],
        page_jobs: list[tuple[int, str]],
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        futures: dict[concurrent.futures.Future, tuple[str, int, tuple[t.Any, ...]]] = {}
        for wire_id, query, category, time_range, include, exclude in search_jobs:
            # the worker needs a request context of its own: SearchWithPlugins
            # stores the request proxy and search() copies the context again
            # for each of its engine threads (mirrors the webapp view thread)
            worker = flask.copy_current_request_context(self._search_one)
            futures[pool.submit(worker, query, category, time_range, include, exclude)] = (
                "search",
                wire_id,
                (query, category, time.monotonic()),
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
                    query, category, started = args
                    yield from self._finish(rnd, wire_id, query, category, fut, started, feeds)
                else:
                    url, started = args
                    yield from self._finish_page(rnd, wire_id, url, fut, started, feeds)


def round_progress(state: Searches, stall_rounds: int) -> t.Callable[[int], str | None]:
    """The progress-based termination policy: called by the agent loop
    after each executed round.  A round is PRODUCTIVE when at least one
    fresh query returned results; ``stall_rounds`` consecutive
    unproductive rounds end the research (the returned message explains
    the staleness to the model).  Productive research is UNLIMITED."""

    def verdict(_round_no: int) -> str | None:
        if state.round_new_hits > 0:
            state.stalled_rounds = 0
            return None
        state.stalled_rounds += 1
        if state.stalled_rounds < stall_rounds:
            return None
        return STALL_NOTE

    return verdict
