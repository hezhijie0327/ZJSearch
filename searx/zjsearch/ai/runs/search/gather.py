# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search executor: the WORKER POOL -- real instance searches and
page reads.

:class:`GatherMixin` runs one round's network jobs on a small thread
pool: ``web_search`` as the REAL ``SearchWithPlugins`` webapp path
(plugins, preferences and the site operators included) and
``web_reader`` through the built-in browser; each settlement compiles
the compact ``[n]`` feed block and yields the feature events for the
wire protocol."""

import concurrent.futures
import logging
import time
import typing as t
from urllib.parse import urlsplit

import flask


from searx.extended_types import sxng_request
from searx.search import SearchWithPlugins
from searx.webadapter import get_search_query_from_webapp
from searx.zjsearch.ai.tools import web_reader as reader
from searx.zjsearch.ai.runs.search.feed import FEED_DEEP, RESULTS_CAP, build_search_feed, serialize_results
from searx.zjsearch.ai.llm.decision import features as decision_features
from searx.zjsearch.ai.runs.search.rank import (
    RERANK_HEAD,
    bm25_order,
    diverse_order,
    rerank_doc,
    rerank_order,
)

logger = logging.getLogger(__name__)


MAX_PARALLEL = 6
"""Worker threads per parallel batch -- uncapped per-round call counts
(the model's call) queue behind these slots so a chatty round cannot
stampede the instance.  Every queued search gets to run; each engine
request carries its own per-request timeout, which is what bounds a
batch -- no artificial wall clock."""


class GatherMixin:  # pylint: disable=no-member
    """The pool, the search/page settlements and the ranking cascade
    (the composed Searches state's members are inherent to the mixin
    pattern)."""

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

    def _known_dupes(self, items: list[t.Any], entries: list[dict[str, t.Any]]) -> list[int]:
        """A RE-search whose hits are all already-numbered produces no new
        entries -- the row would promise (12) with nothing to show and no
        way to expand.  The KNOWN [n]s of this search's already-seen hits
        ride the settle as ``dupes``: the client resolves them against the
        run's registry and the row still expands to the result cards (the
        same pages, their existing numbers)."""
        new_urls = {str(entry.get("url") or "") for entry in entries}
        dupes: list[int] = []
        for item in items:
            url = str(item.get("url") or "")
            if not url or url in new_urls:
                continue
            known_n = self.reg.known(reader.normalize_url(url))
            if known_n and known_n not in dupes:
                dupes.append(known_n)
            if len(dupes) >= 12:
                break
        return dupes

    def _ranked(self, query: str, raw: list[t.Any]) -> list[t.Any]:
        """One search's results through the THREE-stage cascade: engine
        order -> BM25 text relevance -> the rerank model re-scoring the
        head -> embedding diversity pruning the near-duplicate
        syndications.  Every stage fails open into the previous order
        (rank.py); the rerank model's token usage joins the run's account
        (the settle carries it as ``usage.rerank``).  (The per-candidate
        decision gate that once ordered by answer evidence was removed
        with the sources_gate feature -- ranking is mechanical; the
        decision model's judgments live where the model invokes them.)"""
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
            # ── the funnel's last stage: embedding diversity ──
            ranked_head = order[:RERANK_HEAD]
            kept = diverse_order(
                [rerank_doc(raw[i]) for i in ranked_head],
                float(decision_features("diversity").get("cosine", 0.92)),
            )
            if kept is not None:
                order = [ranked_head[i] for i in kept] + order[RERANK_HEAD:]
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
            feed_text = "error: the search failed"
            feeds[idx - 1] = feed_text
            yield ("call", {"call": idx, "status": "error", "n": 0, "ms": ms, "feed": feed_text[:800]})
            return
        # the dedup mark lands on COMPLETION, never at plan time: a query
        # whose engines errored stays retryable (an executed query -- empty
        # or not -- is honestly remembered; its outcome is in the feed)
        self.reg.note_query(dedup_key, query)
        try:
            raw = self._ranked(query, raw)
            items = serialize_results(raw, query)
            feed_block, entries = build_search_feed(self.reg, query, category, items)
        except Exception as exc:  # pylint: disable=broad-except
            # one malformed result must never unwind _dispatch's settlement
            # loop -- THIS call degrades to an error row, the round's
            # remaining calls still settle (the loop's own catch is the
            # last resort, and it kills the whole batch)
            logger.warning("zjsearch_ai_search: search %d/%d settlement failed: %r", rnd, idx, exc)
            feed_text = "error: the search failed"
            feeds[idx - 1] = feed_text
            yield ("call", {"call": idx, "status": "error", "n": 0, "ms": ms, "feed": feed_text[:800]})
            return
        if items:
            self.round_new_hits += 1
        for entry in entries:
            entry["round"] = rnd
            entry["id"] = idx
            self.round_new_titles.append(str(entry.get("title") or ""))
            n = int(entry.get("n") or 0)
            if int(entry.get("idx") or 99) < FEED_DEEP and n:
                self.head_sources[n] = {
                    "title": str(entry.get("title") or "")[:200],
                    "snippet": str(entry.get("content") or "")[:400],
                }
        feeds[idx - 1] = feed_block
        self.feed.append(feeds[idx - 1])
        self.feed_chars += len(feeds[idx - 1])
        for entry in entries:
            self.corpus.add(
                f"{entry.get('title', '')}\n{entry.get('content', '')}",
                ref_n=int(entry.get("n") or 0),
                title=str(entry.get("title") or "")[:160],
                url=str(entry.get("url") or ""),
                kind="result",
            )
        # the task card's coverage tracking with the REAL titles: the
        # matched subtask goes active/done and the fresh [n] numbers ride
        # it as provenance (the card's per-subtask source count)
        if self.coverage.task_list:
            titles = [str(entry.get("title") or "") for entry in entries]
            self.coverage.track(query, titles, [int(entry["n"]) for entry in entries])
        for entry in entries:
            n = int(entry.get("n") or 0)
            if n:
                self.entries[n] = {
                    "title": str(entry.get("title") or ""),
                    "snippet": str(entry.get("content") or "")[:500],
                }
        dupes = self._known_dupes(items, entries)
        yield (
            "call",
            {
                "call": idx,
                "status": "ok",
                "n": len(items),
                "ms": ms,
                "feed": feed_block[:800],
                **({"dupes": dupes} if dupes else {}),
            },
        )
        if entries:
            yield ("sources", {"items": entries})

    def _read_one(self, url: str) -> tuple[str, str]:
        """One ``web_reader`` read -- built-in-browser render + extraction;
        needs no request context."""
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
            feed_text = f"error: {str(exc)[:300] or type(exc).__name__}"
            feeds[idx - 1] = feed_text
            yield ("call", {"call": idx, "status": "error", "url": url, "ms": ms, "feed": feed_text[:800]})
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
        feed_text = f'Opened {url} (title: "{title}"; {cite}):\n\n{text}'
        feeds[idx - 1] = feed_text
        self.feed.append(feeds[idx - 1])
        self.feed_chars += len(feeds[idx - 1])
        self.corpus.add(text, ref_n=n, title=title[:160], url=url, kind="page")
        self.round_new_hits += 1
        # the read's subtask coverage with the REAL title: the matched
        # subtask goes done and the opened page's [n] rides its provenance
        if self.coverage.task_list:
            try:
                self.coverage.track(url, [title], [n])
            except Exception as exc:  # pylint: disable=broad-except
                # coverage bookkeeping must never kill the settlement (the
                # card falls back to queue-time state, the read itself is
                # already recorded)
                logger.warning("zjsearch_ai_search: page %d/%d coverage tracking failed: %r", rnd, idx, exc)
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
                "feed": feed_text[:800],
            },
        )

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
            # the call's wall clock starts AT SUBMIT (queue wait included):
            # the settlement's ``ms`` is the wire's debug timing
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
