# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search executor: the WORKER POOL -- real instance searches.

:class:`GatherMixin` runs one round's ``search_web`` jobs on a small
thread pool -- the REAL ``SearchWithPlugins`` webapp path (plugins,
preferences and the site operators included); each settlement compiles
the compact ``[n]`` feed block and yields the feature events for the
wire protocol.  The browse tool is the serialized session lane
(open -> read) -- it never rides this pool."""

import concurrent.futures
import logging
import time
import typing as t

from searx.extended_types import sxng_request
from searx.search import SearchWithPlugins
from searx.webadapter import get_search_query_from_webapp
from searx.zjsearch.ai.tools.browse import read as reader
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


_ANSWER_FEED_MAX = 3
"""Plugin instant answers per search carried into the feed."""

_ANSWER_FEED_CHARS = 600
"""One plugin answer's feed cap (the stock card's text form fits)."""


class GatherMixin:  # pylint: disable=no-member, too-few-public-methods
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
        return search_obj.search()

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

    def _ranked(self, query: str, raw: list[t.Any]) -> tuple[list[t.Any], dict[int, list[float]]]:
        """One search's results through the THREE-stage cascade: engine
        order -> BM25 text relevance -> the rerank model re-scoring the
        head -> embedding diversity pruning the near-duplicate
        syndications.  Every stage fails open into the previous order
        (rank.py); the rerank model's token usage joins the run's account
        (the settle carries it as ``usage.rerank``).  RETURNS
        ``(ranked_results, head_vectors, quality)``: the diversity stage's
        embeds keyed by RETURNED-list position (the cross-search dup
        gate's material at zero extra cost) and the query-quality signals
        (``no_signal`` / ``dup_ratio`` -- the rewrite-advice note's
        inputs, "failure becomes information" at the query layer).  (The per-candidate
        decision gate that once ordered by answer evidence was removed
        with the sources_gate feature -- ranking is mechanical; the
        decision model's judgments live where the model invokes them.)"""
        try:
            order = bm25_order(query, raw)
            if order is None:
                return raw, {}, {"no_signal": True, "dup_ratio": None}
            head = order[:RERANK_HEAD]
            if len(head) >= 2:
                sub_order, _tokens = rerank_order(query, [rerank_doc(raw[i]) for i in head], account=self.account)
                if sub_order is not None:
                    order = [head[i] for i in sub_order] + order[RERANK_HEAD:]
            # ── the funnel's last stage: embedding diversity ──
            ranked_head = order[:RERANK_HEAD]
            kept, vectors = diverse_order(
                [rerank_doc(raw[i]) for i in ranked_head],
                float(decision_features("diversity").get("cosine", 0.92)),
                account=self.account,
            )
            head_vectors: dict[int, list[float]] = {}
            dup_ratio = None
            if kept is not None:
                dup_ratio = 1.0 - (len(kept) / len(ranked_head)) if ranked_head else None
                order = [ranked_head[i] for i in kept] + order[RERANK_HEAD:]
                for pos, index in enumerate(kept):
                    head_vectors[pos] = vectors[index]
            return [raw[i] for i in order], head_vectors, {"no_signal": False, "dup_ratio": dup_ratio}
        except Exception:  # pylint: disable=broad-except
            # one odd result shape must never take the round's remaining
            # settlements down with it -- the engine order stands
            logger.exception("zjsearch_ask_search: ranking cascade failed -- keeping the engine order")
            return raw, {}, {"no_signal": False, "dup_ratio": None}

    def _finish(  # pylint: disable=too-many-locals, too-many-branches, too-many-statements
        self,
        rnd: int,
        idx: int,
        query: str,
        category: str,
        dedup_key: str,
        fut: "concurrent.futures.Future[t.Any]",
        started: float,
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        ms = int((time.monotonic() - started) * 1000)
        try:
            container = fut.result()
            raw = container.get_ordered_results()[:RESULTS_CAP]
            plugin_answers = [
                " ".join(str(answer.answer or "").split())
                for answer in container.answers
                if str(getattr(answer, "answer", "") or "").strip()
            ]
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_ask_search: search %d/%d failed: %r", rnd, idx, exc)
            feed_text = "error: the search failed"
            feeds[idx - 1] = feed_text
            yield ("call", {"call": idx, "status": "error", "n": 0, "ms": ms, "feed": feed_text[:800]})
            return
        # the dedup mark lands on COMPLETION, never at plan time: a query
        # whose engines errored stays retryable (an executed query -- empty
        # or not -- is honestly remembered; its outcome is in the feed)
        self.reg.note_query(dedup_key, query)
        try:
            raw, head_vectors, quality = self._ranked(query, raw)
            # the cross-search semantic dup gate reuses the diversity
            # stage's embeds: a candidate whose vector clears the threshold
            # against an already-fed source never mints a [n]
            dup_gate: dict[str, t.Any] | None = None
            if head_vectors:
                dup_gate = {
                    "vectors": head_vectors,
                    "threshold": float(decision_features("diversity").get("cosine", 0.92)),
                    "dropped": [],
                }
            items = serialize_results(raw, query)
            feed_block, entries = build_search_feed(self.reg, query, category, items, dup_gate=dup_gate)
            # the SOURCE NOTES lane: the host-bound facts (source
            # credibility / usage judgments) for the hosts this search
            # actually touched -- once per run per note, the conversation
            # keeps them from here
            notes_line = self._source_notes_feed(items)
            if notes_line:
                feed_block = notes_line + "\n" + feed_block
            # the query-quality feedback loop ("failure becomes information"
            # at the query layer): a no-signal or duplicate-dominated search
            # tells the model to REPHRASE instead of repeating the angle --
            # the cascade's own statistics are the referee's evidence here
            if not items and not plugin_answers:
                # the explicit ZERO verdict, distinct from the no-signal
                # note below (which also fires for results without textual
                # signal): the model must know the engine found NOTHING so
                # it rewrites the query instead of re-reading an empty page
                feed_block += """\

(search result: this query returned ZERO results -- rewrite it:
different keywords, another language, another category, or drop a
filter; never repeat it verbatim -- the duplicate guard will refuse)"""
            elif quality.get("no_signal"):
                feed_block += """\

(search quality: this query matched nothing textually -- rephrase it:
different keywords, another language, or a site: operator; repeating it
verbatim wastes a round)"""
            elif (dup_ratio := quality.get("dup_ratio")) is not None and dup_ratio > 0.6:
                feed_block += f"""\

(search quality: {int(round(dup_ratio * 100))}% of this query's head
results were near-duplicate syndications of pages already in hand --
approach from another angle or change language)"""
            # the PLUGINS' instant answers ride the same feed block: the
            # stock/calculate/time answerers' output is exactly the kind
            # of direct fact the researcher should quote -- without this
            # the plugins' work was computed and silently dropped
            # (a `$AAPL` search answered 0 results and the model starved)
            if plugin_answers:
                answer_lines = ["Direct answers (from this instance's plugins -- authoritative, cite the query):"]
                answer_lines += [f"- {text[:_ANSWER_FEED_CHARS]}" for text in plugin_answers[:_ANSWER_FEED_MAX]]
                block = feed_block.split("\n")
                feed_block = "\n".join(block[:1] + answer_lines + block[1:])
        except Exception as exc:  # pylint: disable=broad-except
            # one malformed result must never unwind _dispatch's settlement
            # loop -- THIS call degrades to an error row, the round's
            # remaining calls still settle (the loop's own catch is the
            # last resort, and it kills the whole batch)
            logger.warning("zjsearch_ask_search: search %d/%d settlement failed: %r", rnd, idx, exc)
            feed_text = "error: the search failed"
            feeds[idx - 1] = feed_text
            yield ("call", {"call": idx, "status": "error", "n": 0, "ms": ms, "feed": feed_text[:800]})
            return
        if items or plugin_answers:
            # an answer-only search ($AAPL) IS productive: without this the
            # stall detector would punish exactly the plugin-blessed queries
            self.round_new_hits += 1
        for entry in entries:
            entry["round"] = rnd
            entry["id"] = idx
            # the minting agent's key: the client's result-strip join keys
            # on (agent, round, call id) -- the pairs collide across the
            # lead and the subagents sharing this registry
            entry["agent"] = getattr(self, "agent_key", "lead")
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
        if dup_gate and dup_gate["dropped"]:
            # the semantic dup gate's matched [n]s join the exact-url ones:
            # the row expands to where the duplicated stories already live
            dupes = list(dict.fromkeys(list(dupes) + dup_gate["dropped"]))[:12]
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

    def _run_in_ctx(self, query: str, category: str, time_range: str, include: list[str], exclude: list[str]):
        """One search inside a CLONED request context (a fresh
        RequestContext per job -- see ``state._search_ctx`` for why the
        shared context cannot be pushed concurrently)."""
        if self._search_ctx is None:
            return self._search_one(query, category, time_range, include, exclude)
        # pylint: disable=import-outside-toplevel
        from flask.ctx import RequestContext

        app, environ, request_obj = self._search_ctx
        with RequestContext(app, environ, request=request_obj):
            return self._search_one(query, category, time_range, include, exclude)

    def _run_browse_job(self, call: dict[str, t.Any], wire_id: int, feeds: list[str | None]):
        """One browse action consumed to its events on a pool worker --
        the session lock serializes the actions among themselves while
        the round's searches run beside them.  The settlements touch the
        flask request/app context (favicons, pretty urls), so the worker
        rides its OWN cloned request context (the search job's pattern).
        Returns ``(events, gathered)`` -- the generator's StopIteration
        value carries the gathered flag."""
        gen = self._browser_call(call, wire_id, feeds)
        events: list[tuple[str, t.Any]] = []
        while True:
            try:
                events.append(next(gen))
            except StopIteration as stop:
                return events, (stop.value or False)

    def _finish_browse(
        self,
        rnd: int,
        wire_id: int,
        fut: "concurrent.futures.Future[t.Any]",
        started: float,
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        """Re-yield one pooled browse job's stored events in order, then
        fold its gathered flag into the round (the stall detector counts
        it like an inline settlement)."""
        ms = int((time.monotonic() - started) * 1000)
        try:
            events, gathered = fut.result()
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_ask_search: browse %d/%d failed: %r", rnd, wire_id, exc)
            feed_text = f"error: {str(exc)[:300] or type(exc).__name__}"
            feeds[wire_id - 1] = feed_text
            yield ("call", {"call": wire_id, "status": "error", "ms": ms, "feed": feed_text[:800]})
            return False
        for event in events:
            yield event
        return bool(gathered)

    def _dispatch(  # pylint: disable=too-many-locals
        self,
        pool: concurrent.futures.ThreadPoolExecutor,
        rnd: int,
        search_jobs: list[tuple[int, str, str, str, list[str], list[str], str]],
        browse_jobs: list[tuple[int, dict[str, t.Any]]],
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        # the settlements' serialization touches the flask request/app
        # context (favicons, pretty urls, proxified images) -- the driver
        # thread has neither.  ONE cloned RequestContext held for the
        # whole drain: the drain is single-threaded (no token-stack
        # interleaving), the per-job worker clones are separate objects
        # (safe), and the held request context also carries the app
        # context its push installs.
        if self._search_ctx is not None:
            # pylint: disable=import-outside-toplevel
            from flask.ctx import RequestContext

            app, environ, request_obj = self._search_ctx
            with RequestContext(app, environ, request=request_obj):
                yield from self._dispatch_ctx(pool, rnd, search_jobs, browse_jobs, feeds)
            return
        yield from self._dispatch_ctx(pool, rnd, search_jobs, browse_jobs, feeds)

    def _dispatch_ctx(  # pylint: disable=too-many-locals
        self,
        pool: concurrent.futures.ThreadPoolExecutor,
        rnd: int,
        search_jobs: list[tuple[int, str, str, str, list[str], list[str], str]],
        browse_jobs: list[tuple[int, dict[str, t.Any]]],
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        futures: dict[concurrent.futures.Future, tuple[str, int, tuple[t.Any, ...]]] = {}
        for wire_id, query, category, time_range, include, exclude, dedup_key in search_jobs:
            # each job CLONES a fresh flask RequestContext from the
            # template (same request/environ, PRIVATE token stack): the
            # search path needs a request context per worker, and pushing
            # the SHARED context from concurrent pool workers interleaves
            # its token stack (every other search died with "token was
            # created in a different Context").
            futures[pool.submit(self._run_in_ctx, query, category, time_range, include, exclude)] = (
                "search",
                wire_id,
                (query, category, dedup_key, time.monotonic()),
            )
        for wire_id, call in browse_jobs:
            # the session's own lock serializes browse actions among
            # themselves -- beside them, this round's searches run free
            futures[pool.submit(self._run_browse_job, call, wire_id, feeds)] = (
                "browse",
                wire_id,
                (call, time.monotonic()),
            )
        pending = dict(futures)
        # no batch wall clock: every queued call gets to run and every
        # engine request carries its own per-request timeout, which is
        # what bounds a batch -- the user's stop button is the only control
        while pending:
            done, _not_done = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
            for fut in done:
                kind, wire_id, args = pending.pop(fut)
                if kind == "browse":
                    call, started = args
                    gathered = yield from self._finish_browse(rnd, wire_id, fut, started, feeds)
                    if gathered:
                        self.round_gathered = True
                    continue
                query, category, dedup_key, started = args
                yield from self._finish(rnd, wire_id, query, category, dedup_key, fut, started, feeds)
