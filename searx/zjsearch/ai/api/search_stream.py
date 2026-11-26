# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

"""The search route's streaming settlement machinery: the NDJSON writer
(``Ndjson``), the settle-tail replay gate (``SettleTail``), the clarify
gate's event drain and the hosted-run response -- everything the
``/zjsearch/ask/search`` view delegates to after it has assembled the
payload.  The view itself stays in search_route.py."""

import json
import logging
import time
import typing as t

import flask

from searx.zjsearch.ai.core.ndjson import UpstreamDead as _UpstreamDead
from searx.zjsearch.ai.agent import wire
from searx.zjsearch.ai.api import http
from searx.zjsearch.ai.llm import decision
from searx.zjsearch.ai.runs import host as run_host
from searx.zjsearch.ai.runs.search.gates import generate_title, related_questions
from searx.zjsearch.ai.tools.memory import extract_insights


_CONTENT_EVENTS = (
    "open",
    "think",
    "say",
    "answer",
    "calls",
    "call",
    "close",
    "plan",
    "findings",
    "sources",
    "ask",
    "gallery",
    "outline",
    "artifact",
    "section",
)
"""The wire events that prove the upstream is alive: a ``settle`` before
any of these is the 502 path (the stream died before its first token)."""

logger = logging.getLogger(__name__)


def respond(stream: "Ndjson") -> flask.Response:
    """Prime the stream (proving the upstream alive) and answer: a dead
    upstream gets the plain-text 502 with its truncated reason."""
    try:
        stream.prime()
    except _UpstreamDead as dead:
        return http.upstream_error_response("error", str(dead))
    return http.streaming_response(iter(stream), "application/x-ndjson")


def clarify_events(gate: dict[str, t.Any]) -> t.Iterator[dict[str, t.Any]]:
    """The clarify-gate run: the ask event then the settle -- a run that
    settles as ``awaiting`` (the user's answers travel on the next
    request).  The SAME wire event set as every other run."""
    yield {"e": "ask", **gate}
    yield wire.settle("awaiting", halt="awaiting the user's direction")


class SettleTail:
    """The settle's usage merge (the gates/rerank/decision buckets plus
    the judgments) and the LATE post-settle work (the related fallback
    completion and the memory extraction, both suppressed on an
    ``awaiting`` run).  One definition, two consumers: the request-thread
    ``Ndjson`` (the short clarify / no-research streams) and the run
    host's DRIVER thread (research runs -- the merge must happen at the
    settle's GENERATION point there, because the executor's usage dicts
    are only final once the loop is done, and a detached client must not
    cost the late work)."""

    def __init__(  # pylint: disable=too-many-arguments
        self,
        cfg: dict[str, t.Any],
        question: str,
        lang: str,
        account: t.Any = None,
        judgments: list[dict[str, t.Any]] | None = None,
        known_memories_fn: t.Callable[[], list[tuple[str | None, str, str]]] | None = None,
        outline_title: str | None = None,
        clarifications: str = "",
    ):
        self.cfg = cfg
        self.question = question
        # the report's own title (the writer-side outline editor's) -- the
        # title pass's candidate when no fence title rode the answer
        self.outline_title = outline_title or None
        self.lang = lang
        # the run's model-spend ledger (a LIVE object -- the settle reads
        # its buckets after the run's searches have mutated them); the
        # gates' spend rides INSIDE it (jsongate records at its choke
        # point), so gates_sum is gone with the list it summed
        self.account = account
        # the judgment ledger (the executor's structured verdicts) -- the
        # settle carries it verbatim so the knowledge base's run meta is
        # the one explainable record of every decision
        self.judgments = judgments if judgments is not None else []
        # the memory extraction's comparison set (id+content pairs -- the
        # ids let a supersession name its target row), resolved LAZILY
        # (the run's own saves land while the loop streams)
        self.known_memories_fn = known_memories_fn
        # the confirmed direction (the clarify answers): the extractor's
        # second input -- the user's preferences surface THERE, never in
        # the report
        self.clarifications = clarifications

    def merged_settle(self, event: dict[str, t.Any]) -> dict[str, t.Any]:
        """The settle with the model-spend buckets folded into its usage:
        ``usage.gates = {input, output, calls}`` (the small LLM
        completions) plus one ``{calls, tokens}`` bucket per non-LLM
        model class from the run's ledger -- GENERIC over the account's
        kinds, so a new model class reaches the wire by recording, with
        zero branches here.  The buckets force the fold too: a transport
        that reports no usage (or a writer that died) must not silently
        drop the cascade's or the judgments' spend."""
        usage = event.get("usage")
        buckets = self.account.buckets() if self.account is not None else {}
        if isinstance(usage, dict) or buckets:
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
            for kind, spend in buckets.items():
                usage[kind] = dict(spend)  # the bucket VERBATIM -- each model class's own shape
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
        if candidate and decision.available():
            try:
                out = decision.evaluate(
                    {"question": self.question[:500], "title": candidate},
                    {
                        "good_title": {
                            "type": "noul",
                            "instructions": "Is this a good THREAD TITLE: a short, specific noun phrase naming the research subject (in the question's language; not a generic label like 'report' or 'research', not a question, no quotes or trailing punctuation)?",
                        }
                    },
                    timeout=5.0,
                    account=self.account,
                )
                answers = out.get("answers") if isinstance(out, dict) else None
                verdict = answers.get("good_title") if isinstance(answers, dict) else None
                if isinstance(verdict, dict) and float(verdict.get("noul") or 0.0) >= 0.6:
                    return candidate
            except Exception as exc:  # pylint: disable=broad-except
                logger.debug("zjsearch_ask_search: title gate skipped: %r", exc)
        elif candidate:
            # the decision model is off: an existing writer/outline title
            # stands (no gate, no spend)
            return candidate
        try:
            return generate_title(
                self.cfg,
                self.question,
                answer,
                self.lang,
                self.outline_title,
                account=self.account,
            )
        except Exception as exc:  # pylint: disable=broad-except
            logger.debug("zjsearch_ask_search: title generation failed: %r", exc)
            return None

    def late_events(  # pylint: disable=too-many-branches
        self,
        answer: str,
        awaiting: bool,
        related_seen: bool,
        fence_title: str | None = None,
    ) -> t.Iterator[dict[str, t.Any]]:
        """The LATE events after the settle: the TITLE pass (decision-gate
        the writer's own fence title; regenerate only when it fails), the
        related fallback and the memory extraction (related/memory
        suppressed on an awaiting run), then the trailing usage event
        with the absolute gates sum."""
        if not awaiting:
            # THE RUN'S TABS GO HOME: the research settled (done / error)
            # -- every strip tab closes (memory recovery; the cookie
            # store and the read texts survive).  An AWAITING run keeps
            # its tabs (the wait_user mirror is the human's surface).
            try:
                # pylint: disable=import-outside-toplevel
                from searx.zjsearch.ai.browser import session as browser_session

                browser_session.close_tabs()
            except Exception:  # pylint: disable=broad-exception-caught
                pass
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
                found = related_questions(self.cfg, self.question, answer, self.lang, account=self.account)
            except Exception as exc:  # pylint: disable=broad-except
                logger.warning("zjsearch_ask_search: related fallback failed: %r", exc)
                found = []
            if found:
                yield {"e": "related", "items": found}
        try:
            known_rows = self.known_memories_fn() if self.known_memories_fn else []
            events, tags = extract_insights(
                self.cfg,
                self.question,
                answer,
                known=[content for _rid, content, _kind in known_rows],
                known_ids=[rid for rid, _content, _kind in known_rows],
                clarifications=self.clarifications,
                open_gaps=[(rid, content) for rid, content, kind in known_rows if kind == "gap" and rid],
                account=self.account,
            )
            # the v2 memory events (op + kind/id/content/state) fly as-is:
            # the client's fold executes each op against its store
            for event in events:
                yield {"e": "memory", **event}
            if tags:
                # the tag graph's semantic layer: the client parks these on
                # the run, its settle writes them into the projections
                yield {"e": "tags", "items": tags}
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_ask_search: memory extraction failed: %r", exc)
        # the trailing completions' spend is already in the ledger (the
        # gates bucket -- jsongate records at its ONE choke point); the
        # late usage event re-publishes the absolute totals (idempotent --
        # the client sets it), so the WHOLE flow stays accounted
        gates = self.account.spend("gates") if self.account is not None else {}
        if gates.get("calls"):
            yield {"e": "usage", "gates": gates}


class Ndjson:  # pylint: disable=too-few-public-methods
    """The loop's timeline ops as NDJSON lines, with the LATE work after
    the settle -- the request-thread shape for the SHORT streams (the
    clarify gate, the no-research single write).  Research runs go
    through the run host's driver instead (see :py:func:`drive`)."""

    def __init__(  # pylint: disable=too-many-arguments
        self,
        events: t.Iterator[dict[str, t.Any]],
        cfg: dict[str, t.Any],
        question: str,
        lang: str,
        account: t.Any = None,
        judgments: list[dict[str, t.Any]] | None = None,
        preamble: list[dict[str, t.Any]] | None = None,
        known_memories_fn: t.Callable[[], list[tuple[str | None, str, str]]] | None = None,
        clarifications: str = "",
    ):
        self.events = events
        self.tail = SettleTail(
            cfg,
            question,
            lang,
            account=account,
            judgments=judgments,
            known_memories_fn=known_memories_fn,
            clarifications=clarifications,
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
            elif kind == "section" and not event.get("think"):
                # a think-marked section delta is the writer's reasoning,
                # never body text -- the post-settle related/memory
                # extraction must not digest it
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
            if kind == "section" and not event.get("think"):
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


def drive(  # pylint: disable=too-many-branches
    handle: run_host.RunHandle,
    events: t.Iterator[dict[str, t.Any]],
    tail: SettleTail,
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
            if kind == "answer" or (kind == "section" and not event.get("think")):
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
        logger.warning(
            "zjsearch_ask_search: the run driver failed: %s: %s",
            type(exc).__name__,
            str(exc)[:300],
        )
        logger.warning("zjsearch_ask_search: driver traceback", exc_info=True)
        logger.warning("zjsearch_ask_search: last event repr: %s", repr(locals().get("event"))[:400])
        try:
            handle.publish(wire.settle("error", halt=f"the run driver failed: {exc}"))
        except Exception:  # pylint: disable=broad-except
            pass
    finally:
        handle.finish()


def hosted_response(handle: run_host.RunHandle) -> flask.Response:
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
            # the batch tail the content check stopped in front of: pulled
            # out of the subscription already, so the loop below can never
            # re-receive it -- dropping it here lost every event published
            # back-to-back with the trigger line (the plan snapshot rode
            # the same 0.5s batch as the open)
            yield from pending
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


