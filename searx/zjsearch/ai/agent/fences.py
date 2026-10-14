# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The stream fence splitter: ```related and ```zjs-images fences are
intercepted server-side, so no raw fence text ever reaches the client's
answer.  The ``related`` fence carries the run's follow-up questions (a
pre-settle related event), each ``zjs-images`` fence a validated inline
image group (a gallery event plus its ``{{zjs-gallery:i}}`` placeholder
delta at the fence's position in the answer).
"""

import json
import re
import typing as t


def parse_fence_json(text: str) -> t.Any:
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


def parse_related_title(text: str) -> str | None:
    """The ```related fence body's ``title`` field -- the WRITER's own
    thread title (the settle's decision gate judges it; a bad or missing
    one falls to the generation pass)."""
    value = parse_fence_json(text)
    if not isinstance(value, dict):
        return None
    title = str(value.get("title") or "").strip().strip("\"\u201c\u201d'")
    return title[:60] or None


def parse_related_questions(text: str) -> list[str]:
    """The ```related fence body -> up to three clean question strings."""
    value = parse_fence_json(text)
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


class FenceSplitter:
    """The answer stream's fence interceptor: prose passes through, fence
    bodies are held back and closed whole.  The opener search holds 20
    chars, the in-fence state holds 2 -- a closer split across deltas
    (`` `` `` + `` ` ``) must re-assemble or the body swallows prose up to
    the NEXT fence's opener."""

    _OPENERS = ("zjs-images", "related")
    _OPENER_RES = tuple(re.compile(r"```\s*" + opener + r"\b") for opener in _OPENERS)
    """Precompiled opener matchers -- ``feed`` runs for EVERY writer
    delta of every run; the per-delta pattern rebuild once lived in the
    hottest loop of the stack."""
    HOLD = 20

    def __init__(self) -> None:
        self.tail = ""
        self.fence_kind: str | None = None
        self.fence_body = ""

    def feed(self, delta: str) -> tuple[str, list[tuple[str, str]]]:
        """Consume one delta -> ``(prose, closed fences)``.  ``prose`` is
        answer text (emit it); each closed fence is ``(kind, body)``."""
        text = self.tail + delta
        self.tail = ""
        out = ""
        closed: list[tuple[str, str]] = []
        while text:
            if self.fence_kind is not None:
                end = text.find("```")
                if end == -1:
                    # the closer may itself be split across deltas: hold the
                    # tail back while in-fence
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
            for pattern in self._OPENER_RES:
                found = pattern.search(text)
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
