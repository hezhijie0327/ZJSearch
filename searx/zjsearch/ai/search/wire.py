# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the wire adapter -- agent/executor events to NDJSON lines.

:func:`generate` maps the run's event stream onto the wire protocol
(the package docstring carries the full event table).  The writer's
delta stream runs through a :class:`_FenceSplitter`: the ``related``
and ``zjs-images`` fences are intercepted server-side -- the questions
fly as a pre-``end`` related event, a validated image group as a
gallery event plus a placeholder delta -- so no raw fence text ever
reaches the client's answer.
"""

import json
import logging
import re
import typing as t

from searx.zjsearch.ai import llm
from searx.zjsearch.ai.search.gates import related_questions, sanitize_questions
from searx.zjsearch.ai.search.tools import display_item

if t.TYPE_CHECKING:
    from searx.zjsearch.ai.search.executor import Searches

logger = logging.getLogger(__name__)


def _parse_fence_json(text: str) -> t.Any:
    """The outermost JSON value in a fence body (the models keep the fence
    exact per prompt, but a stray prose line or fence must not kill the
    parse).  The delimiter is whichever bracket comes FIRST: an object
    containing arrays must parse as the object, not as its inner array."""
    start_obj = text.find("{")
    start_arr = text.find("[")
    if start_obj == -1 and start_arr == -1:
        return None
    if start_arr == -1 or (start_obj != -1 and start_obj < start_arr):
        start, closer = start_obj, "}"
    else:
        start, closer = start_arr, "]"
    end = text.rfind(closer)
    if end <= start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except ValueError:
        return None


def _parse_related_questions(text: str) -> list[str]:
    """The ```related fence body -> up to three clean question strings."""
    value = _parse_fence_json(text)
    items = value.get("questions") if isinstance(value, dict) else None
    if not isinstance(items, list):
        return []
    out: list[str] = []
    for item in items:
        question = str(item or "").strip()
        if question and question not in out:
            out.append(question[:200])
        if len(out) >= 3:
            break
    return out


class _FenceSplitter:
    """Splits the WRITER's delta stream: prose deltas pass through (with a
    small holdback so a fence opener split across two deltas cannot flash
    on screen), while the ``related`` and ``zjs-images`` fences are
    intercepted -- held back from the client's answer text entirely and
    handed to the caller when they close.  The writer's fence is therefore
    invisible to the renderer by construction; nothing depends on the
    client recognizing raw fence text."""

    HOLD = 20
    _OPENERS = ("zjs-images", "related")

    def __init__(self) -> None:
        self.tail = ""
        self.fence_kind: str | None = None
        self.fence_body = ""

    def feed(self, delta: str) -> tuple[str, list[tuple[str, str]]]:
        """Consume one delta -> (prose to emit, fences closed by it)."""
        closed: list[tuple[str, str]] = []
        out = ""
        text = self.tail + delta
        self.tail = ""
        while text:
            if self.fence_kind is not None:
                end = text.find("```")
                if end == -1:
                    # hold the last 2 chars: a closer SPLIT across deltas
                    # ("``" + "`") must re-assemble in the next feed, or
                    # the body swallows prose up to the NEXT fence's opener
                    if len(text) > 2:
                        self.fence_body += text[:-2]
                        self.tail = text[-2:]
                    else:
                        self.tail = text
                    break
                self.fence_body += text[:end]
                closed.append((self.fence_kind, self.fence_body))
                self.fence_kind = None
                self.fence_body = ""
                text = text[end + 3 :]
                continue
            match = None
            for opener in self._OPENERS:
                found = re.search(r"```\s*" + opener + r"\b", text)
                if found and (match is None or found.start() < match.start()):
                    match = found
            if match is None:
                # no opener in sight: emit everything except a holdback
                # that could still be the prefix of one
                if len(text) > self.HOLD:
                    out += text[: -self.HOLD]
                    self.tail = text[-self.HOLD :]
                else:
                    self.tail = text
                break
            line_end = text.find("\n", match.end())
            if line_end == -1:
                # the opener line is still streaming: re-hold ALL of it
                self.tail = text
                break
            out += text[: match.start()]
            self.fence_kind = "zjs-images" if "zjs-images" in match.group(0) else "related"
            text = text[line_end + 1 :]
        return out, closed

    def finish(self) -> tuple[str, list[tuple[str, str]]]:
        """Stream end: flush the holdback; an UNCLOSED fence still parses
        (a model that forgets the closing fence must not lose its
        suggestions)."""
        tail, self.tail = self.tail, ""
        closed: list[tuple[str, str]] = []
        if self.fence_kind is not None:
            # a held-back partial closer belongs to the body, not the prose
            closed.append((self.fence_kind, self.fence_body + tail))
            self.fence_kind = None
            self.fence_body = ""
            return "", closed
        return tail, closed


def clarify_stream(gate: dict[str, t.Any]) -> t.Iterator[str]:
    """The clarify-gate response: the ask event then the closing end -- a
    run that settles as ``awaiting`` (the user's answers travel on the
    next request as ``clarifications``)."""
    yield json.dumps({"e": "ask", "intro": gate["intro"], "questions": gate["questions"]}, ensure_ascii=False) + "\n"
    yield json.dumps({"e": "end"}, ensure_ascii=False) + "\n"


def generate(  # pylint: disable=too-many-branches, too-many-statements, too-many-locals
    first: tuple[str, t.Any],
    events: t.Iterator[tuple[str, t.Any]],
    cfg: dict[str, t.Any],
    question: str,
    lang: str,
    plans: list[str],
    state: "Searches",
) -> t.Iterator[str]:
    """Map agent/executor events to the NDJSON wire protocol.  The WRITER's
    stream runs through a :class:`_FenceSplitter`: the ``related`` fence
    becomes a pre-``end`` related event (Morphic's in-stream follow-ups --
    no extra completion), each ``zjs-images`` fence becomes a validated
    gallery event plus a placeholder delta at its position; neither fence
    ever reaches the client's answer text.  When the writer skips the
    fence, the post-``end`` small completion still suggests follow-ups."""

    def emit(kind: str, payload: t.Any) -> str:  # pylint: disable=too-many-return-statements
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
                        "items": [display_item(idx, call) for idx, call in enumerate(payload["calls"], 1)],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
        if kind == "wrapup":
            # payload-less state marker: the client flips its run state
            # (the wrap-up hint) on it
            return json.dumps({"e": kind}, ensure_ascii=False) + "\n"
        if kind == "direct":
            # the pre-flight gate skipped research: the writer answers
            # without one (the client hides the research box for the run)
            return json.dumps({"e": "direct"}, ensure_ascii=False) + "\n"
        if kind == "gallery":
            return json.dumps({"e": "gallery", "items": payload}, ensure_ascii=False) + "\n"
        if kind == "ask_user":
            # the mid-research escape hatch: the model stopped to ask for
            # direction -- shape its tool arguments into the same ask event
            # the clarify gate emits (the run ends; the client settles it
            # as awaiting)
            value = llm.json_object_of(str(payload or "{}")) or {}
            questions = sanitize_questions(value.get("questions"))
            if not questions:
                # unusable questions would strand the run in awaiting with
                # an empty card -- degrade to researching on
                return (
                    json.dumps({"e": "error", "reason": "the model asked an unusable question"}, ensure_ascii=False)
                    + "\n"
                )
            return (
                json.dumps(
                    {
                        "e": "ask",
                        "intro": str(value.get("intro") or "").strip()[:200],
                        "questions": questions,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
        if kind == "error":
            return json.dumps({"e": "error", "reason": llm.reason_of(payload)}, ensure_ascii=False) + "\n"
        return json.dumps({"e": kind, **payload}, ensure_ascii=False) + "\n"

    def gallery_items(body: str) -> list[dict[str, t.Any]]:
        """The zjs-images fence body -> validated gallery items: every URL
        must be verbatim from the run's image registry (the writer's
        prompt says never invent one; this is the enforcement)."""
        value = _parse_fence_json(body)
        urls = value if isinstance(value, list) else []
        items: list[dict[str, t.Any]] = []
        for url in urls[:4]:
            n = state.gallery_pool.get(str(url or ""))
            if n is not None:
                items.append({"u": str(url), "n": n})
        return items

    # reasoning-channel guard: some models (LM Studio + qwen3.6) route the
    # whole answer into the think stream and leave the content channel empty
    # -- promote the final turn's reasoning so the user always gets a
    # readable answer
    think_parts: list[str] = []
    answer_parts: list[str] = []

    last_kind = first[0]
    saw_ask = False
    splitter = _FenceSplitter()
    fence_related: list[str] = []

    def drain(pieces: list[tuple[str, str]]) -> t.Iterator[str]:
        """Handle closed fences: related queues the questions, each
        zjs-images emits its gallery event plus the placeholder delta the
        renderer expands (neither fence ever touches the answer text)."""
        nonlocal fence_related
        for kind, body in pieces:
            if kind == "related":
                fence_related = _parse_related_questions(body)
            else:
                items = gallery_items(body)
                if items:
                    mark = f"\n{{{{zjs-gallery:{len(state.galleries)}}}}}\n"
                    state.galleries.append(items)
                    answer_parts.append(mark.strip())
                    # the placeholder RIDES the answer text: the client's
                    # renderer expands `{{zjs-gallery:i}}` positions against
                    # the galleries array -- a gallery event alone would
                    # leave the group stored but never rendered
                    yield emit("delta", mark.strip())
                    yield emit("gallery", items)

    def through(delta: str) -> t.Iterator[str]:
        prose, closed = splitter.feed(delta)
        if prose:
            answer_parts.append(prose)
            yield emit("delta", prose)
        yield from drain(closed)

    if first[0] == "delta":
        yield from through(str(first[1] or ""))
    else:
        yield emit(*first)
    for event in events:
        kind, payload = event
        last_kind = kind
        if kind == "think":
            # BOTH consumers matter: the client renders the reasoning
            # timeline (a round's think deltas must ALL reach it), and the
            # promotion guard below needs the accumulated text -- relay the
            # event AND keep the local copy
            think_parts.append(str(payload or ""))
            yield emit(*event)
        elif kind == "delta":
            yield from through(str(payload or ""))
        elif kind == "calls":
            # flush the holdback FIRST: the splitter keeps up to HOLD chars
            # in reserve, and a tail emitted after the calls line would land
            # in the client's answer slice instead of the round's intent --
            # the narration must be complete before the client freezes it
            prose, closed = splitter.finish()
            if prose:
                answer_parts.append(prose)
                yield emit("delta", prose)
            yield from drain(closed)
            # a new turn begins: its answer is judged on its own
            think_parts.clear()
            answer_parts.clear()
            yield emit(*event)
        elif kind == "plan":
            # the plan turn's prose is answer-shape deliberation, not
            # answer material -- never promote it on a late stream error;
            # it travels to the writer as guidance instead
            plans.append(str((payload or {}).get("t") or ""))
            think_parts.clear()
            answer_parts.clear()
        elif kind == "ask_user":
            # the run ends awaiting the user's direction: the streamed
            # intent prose is not an answer -- related questions on it
            # would be noise
            saw_ask = True
        elif kind == "wrapup":
            # the writer's stream follows: a fresh splitter AND a clean
            # slate -- the researcher's streamed narration and reasoning
            # must neither leak into the answer, nor defeat the reasoning-
            # promotion guard below (a think-only writer must promote), nor
            # pollute the related-questions fallback with non-answer text
            splitter = _FenceSplitter()
            think_parts.clear()
            answer_parts.clear()
            yield emit(*event)
        else:
            yield emit(*event)
    prose, closed = splitter.finish()
    if prose:
        answer_parts.append(prose)
        yield emit("delta", prose)
    yield from drain(closed)
    answer_text = "".join(answer_parts).strip()
    if last_kind != "error" and not answer_text and think_parts:
        # the model routed the whole answer into the reasoning channel:
        # promote it so the user always gets a readable answer
        promoted = "".join(think_parts).strip()
        yield emit("delta", promoted)
        answer_parts.append(promoted)
        answer_text = promoted
    # the writer's in-stream related fence wins: emit BEFORE end so the
    # follow-up box opens already holding its suggestions (the small
    # completion behind the fallback cannot match that -- it can think
    # for the better part of a minute on reasoning models)
    emitted_related = False
    if fence_related:
        yield emit("related", {"items": fence_related})
        emitted_related = True
    # `end` settles the run FIRST so the client's follow-up box opens
    # immediately; the fallback related questions trail as a post-end
    # event (the client accepts `related` after phase=done by design)
    yield json.dumps({"e": "end"}, ensure_ascii=False) + "\n"
    if answer_text and not saw_ask and not emitted_related:
        try:
            related = related_questions(cfg, question, answer_text, lang)
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_ai_search: related questions failed: %r", exc)
            related = []
    else:
        related = []
    if related:
        yield emit("related", {"items": related})
