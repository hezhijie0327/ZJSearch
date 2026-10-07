# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``web_browser`` action dispatch: JSON arguments in, model-facing
feed text out -- plus the side channels the executor interleaves into
the wire: the mirror frames (the rail's live card), the settlement's
page state / outline / screenshot (the timeline row's rendered result)
and the screenshot's image injection (the model sees it next turn)."""

import time
import typing as t
from urllib.parse import urlsplit

from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.browser import session
from searx.zjsearch.ai.browser.session import SessionError

_WAIT_POLL_S = 2.0
"""The wait_user frame cadence -- frames ARE the heartbeats that keep
the stream alive through the human's operation window."""


class ActionResult(t.NamedTuple):
    """One non-wait action's outcome: the model's feed text, the mirror
    frames to stream, the screenshot's data URL (screenshot only -- the
    caller injects it as the next turn's image), the page the action
    left the session on, and the fresh outline when the action produced
    one (open / snapshot / a click-through navigation)."""

    feed: str
    frames: t.Sequence[dict[str, t.Any]] = ()
    image: str | None = None
    page: dict[str, str] | None = None
    snapshot: str | None = None
    elements: int = 0


def _obs(state: dict[str, str]) -> str:
    return f"now: {state.get('title') or '(untitled)'} ({state.get('url')})"


def _outline_lines(snapshot: str) -> int:
    return sum(1 for line in str(snapshot or "").splitlines() if line.strip())


def _page(state: dict[str, t.Any]) -> dict[str, str]:
    return {"url": str(state.get("url") or ""), "title": str(state.get("title") or "")}


def _navigated_tail(snapshot: str) -> str:
    return "\n\n-- the action navigated: every old ref is dead, the fresh" f" outline is below --\n\n{snapshot}"


def _outline_result(feed: str, state: dict[str, t.Any]) -> ActionResult:
    """An outline-bearing action (open / snapshot): the outline is both
    the model's feed and the settlement's ``snapshot``/``elements``."""
    frame = session.frame()
    return ActionResult(
        feed=feed,
        frames=[frame],
        page=_page(state),
        snapshot=str(state["snapshot"]),
        elements=_outline_lines(state["snapshot"]),
    )


def _state_result(verb: str, state: dict[str, t.Any]) -> ActionResult:
    """A ref-driving action's result (click / type / press): the state
    line, and -- when the action NAVIGATED -- the fresh outline rides
    along (refs die on navigation; the automatic re-snapshot saves the
    model one round).  Refs never die to a plain re-render, so no
    outline means the model's refs still stand."""
    feed = f"{verb} {_obs(state)}"
    snapshot = state.get("snapshot")
    if snapshot:
        feed += _navigated_tail(str(snapshot))
    return ActionResult(
        feed=feed,
        frames=[session.frame()],
        page=_page(state),
        snapshot=str(snapshot) if snapshot else None,
        elements=_outline_lines(str(snapshot)) if snapshot else 0,
    )


def _guard_open_url(url: str) -> str:
    """The session's open lane runs the SAME public-url gate the reader
    does: the request-level gate (``context.route``) never sees the
    navigation target itself -- a ``file://`` goto bypasses it entirely.
    Untrusted model input, rendered inside this host's browser."""
    # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.core.guard import public_url_rejection

    candidate = str(url or "").strip()
    # the SCHEME check runs first: file://localhost/... would otherwise
    # ride the allow_hosts exemption past the public-url gate, and the
    # request-level gate never sees a file navigation at all
    if not candidate.lower().startswith(("http://", "https://")):
        raise SessionError("blocked: open public http(s) pages only")
    host = (urlsplit(candidate).hostname or "").lower().rstrip(".")
    if host not in browser_config.allow_hosts():
        reason = public_url_rejection(candidate)
        if reason is not None:
            raise SessionError(f"blocked: {reason} -- open public http(s) pages only")
    return candidate


def _act_open(args: dict[str, t.Any]) -> ActionResult:
    url = _guard_open_url(str(args.get("url") or ""))
    state = session.open_url(url)
    return _outline_result(f"opened {state['url']} -- {state['title']}\n\n{state['snapshot']}", state)


def _act_snapshot(_args: dict[str, t.Any]) -> ActionResult:
    state = session.snapshot()
    return _outline_result(f"{state['url']} -- {state['title']}\n\n{state['snapshot']}", state)


def _act_click(args: dict[str, t.Any]) -> ActionResult:
    return _state_result("clicked.", session.click(str(args.get("ref") or "")))


def _act_type(args: dict[str, t.Any]) -> ActionResult:
    state = session.type_text(str(args.get("ref") or ""), str(args.get("text") or ""), args.get("submit") is True)
    return _state_result("typed.", state)


def _act_press(args: dict[str, t.Any]) -> ActionResult:
    return _state_result(f"pressed {args.get('key')}.", session.press_key(str(args.get("key") or "")))


def _act_scroll(args: dict[str, t.Any]) -> ActionResult:
    state = session.scroll(str(args.get("direction") or "down"))
    return ActionResult(
        feed=f"scrolled {args.get('direction')}. {_obs(state)}", frames=[session.frame()], page=_page(state)
    )


def _act_search(args: dict[str, t.Any]) -> ActionResult:
    engine = str(args.get("engine") or "bing")
    query = str(args.get("query") or "").strip()
    if not query:
        raise SessionError("search needs a query")
    state = session.search_results(engine, query)
    frame = session.frame()
    page = _page(state)
    rows = [line.split("\t", 2) for line in state["results"].splitlines() if line.strip()]
    if not rows:
        return ActionResult(
            feed=(
                f'no results parsed from {engine} for "{query}" -- the SERP looks different'
                " than expected; take a snapshot to read the page's elements manually"
            ),
            frames=[frame],
            page=page,
        )
    lines = [f'searched {engine} for "{query}" -- {len(rows)} live results']
    lines.append("(a real-browser SERP; follow up with web_reader or open on the promising urls)")
    for pos, row in enumerate(rows, 1):
        title = row[0]
        href = row[1] if len(row) > 1 else ""
        snippet = row[2] if len(row) > 2 else ""
        lines.append(f"{pos}. {title} -- {href}")
        if snippet:
            lines.append(f"   {snippet}")
    return ActionResult(feed="\n".join(lines), frames=[frame], page=page)


def _act_screenshot(_args: dict[str, t.Any]) -> ActionResult:
    shot = session.screenshot_b64(quality=75)
    return ActionResult(
        feed="",
        frames=[{"img": shot["img"], "w": shot["w"], "h": shot["h"], "url": shot["url"], "title": shot["title"]}],
        image=f"data:image/jpeg;base64,{shot['img']}",
        page={"url": str(shot["url"]), "title": str(shot["title"])},
    )


def _act_read(_args: dict[str, t.Any]) -> ActionResult:
    # the reader's cap is the shared extraction budget (lazy import: the
    # reader package pulls the render engine)
    # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.tools.web_reader.reader import max_chars as reader_max_chars

    state = session.extract(reader_max_chars())
    return ActionResult(
        feed=f"{state['title']}\n\n{state['text']}",
        frames=[session.frame()],
        page=_page(state),
    )


def _act_close(_args: dict[str, t.Any]) -> ActionResult:
    session.close_page()
    return ActionResult(feed="the browser session is closed", frames=[])


_ACTORS = {
    "open": _act_open,
    "snapshot": _act_snapshot,
    "click": _act_click,
    "type": _act_type,
    "press": _act_press,
    "scroll": _act_scroll,
    "search": _act_search,
    "screenshot": _act_screenshot,
    "read": _act_read,
    "close": _act_close,
}


def run_action(args: dict[str, t.Any]) -> ActionResult:
    """One non-blocking action.  ``screenshot`` returns its jpeg as the
    ``image`` data URL instead of a feed (the caller injects it as the
    next turn's image and answers with the standard attachment line);
    every other action answers with feed text.  EVERY action captures a
    mirror frame after it settles -- the rail's card stays live through
    the whole model-driven stretch, and the frame doubles as the
    timeline row's visual (volatile, never persisted)."""
    actor = _ACTORS.get(str(args.get("action") or ""))
    if actor is None:
        return ActionResult(feed=f"error: unknown action {args.get('action')!r}")
    try:
        return actor(args)
    except SessionError as exc:
        return ActionResult(feed=f"error: {exc}")


def final_frame() -> dict[str, t.Any] | None:
    """One last mirror frame after the human's window: the page as the
    model is about to read it -- and the frame WITHOUT ``wait_left``
    tells the client the window is over (the sticky prompt retires)."""
    try:
        return session.frame()
    except SessionError:
        return None


def wait_user_frames(seconds: int) -> t.Iterator[dict[str, t.Any]]:
    """The human's operation window, one mirror frame per poll -- the
    frames double as the stream's heartbeats (a blocking wait must keep
    the wire fed or the transport guard kills the run).  Three
    consecutive frame failures end the window early: a dead engine must
    not leave the wire silent for the whole window with a frozen mirror
    -- the post-window snapshot surfaces the failure to the model."""
    session.reset_wait()
    deadline = time.monotonic() + max(10, min(int(seconds), 600))
    failures = 0
    while True:
        remaining = int(deadline - time.monotonic())
        if remaining <= 0:
            return
        if session.wait_done():
            return
        try:
            frame = session.frame()
            failures = 0
        except SessionError:
            failures += 1
            if failures >= 3:
                return
            time.sleep(_WAIT_POLL_S)
            continue
        frame["wait_left"] = remaining
        yield frame
        time.sleep(_WAIT_POLL_S)


def wait_user_snapshot(max_chars: int | None) -> dict[str, t.Any]:
    """The feed after the human's window: where the page stands now -- the
    fresh outline AND the page's readable text (the model judges from
    CONTENT whether the goal is met, not from element names alone).  The
    page state rides beside the feed: the executor numbers the post-login
    page as a citable source and the client archives the text."""
    state = session.snapshot()
    header = (
        "the user's operation window ended -- decide from the page below"
        f" whether the goal is met or another window is needed.\n\n{state['url']}"
        f" -- {state['title']}\n\n{state['snapshot']}"
    )
    try:
        page = session.extract(max_chars)
        body = f"\n\n--- the page's readable text ---\n\n{page['text']}"
        return {
            "feed": header + body,
            "url": page["url"],
            "title": page["title"],
            "text": page["text"],
        }
    except SessionError:
        return {"feed": header, "url": str(state["url"]), "title": str(state["title"]), "text": ""}
