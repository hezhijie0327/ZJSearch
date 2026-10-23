# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``browse`` action dispatch: JSON arguments in, model-facing
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
    tabs: t.Sequence[dict[str, t.Any]] | None = None


def _obs(state: dict[str, str]) -> str:
    return f"now: {state.get('title') or '(untitled)'} ({state.get('url')})"


def _outline_lines(snapshot: str) -> int:
    return sum(1 for line in str(snapshot or "").splitlines() if line.strip())


def _page(state: dict[str, t.Any]) -> dict[str, str]:
    return {"url": str(state.get("url") or ""), "title": str(state.get("title") or "")}


def _navigated_tail(snapshot: str) -> str:
    return "\n\n-- the action navigated: every old ref is dead, the fresh" f" outline is below --\n\n{snapshot}"


def _download_lines(session_id: str) -> str:
    """The session's download tail, spoken into the feed -- SAVINGS name
    the read-back lane, REJECTIONS are loud (the viewer must see the
    browser refused a file, not silently dropped it): the security gate
    only ever saves what the converter can read."""
    entries = session.drain_downloads(session_id)
    if not entries:
        return ""
    lines = []
    for entry in entries:
        name = str(entry.get("name") or "download")
        state = str(entry.get("state") or "")
        if state == "saved":
            kb = max(1, round(int(entry.get("bytes") or 0) / 1024))
            lines.append(f'downloaded {name} ({kb} KB) -- read it with read and download="{name}"')
        elif state == "rejected":
            lines.append(f"REJECTED download {name}: {entry.get('reason')}")
        else:
            lines.append(f"download failed: {name} ({entry.get('reason')})")
    return "\n".join(lines) + "\n"


def _outline_result(feed: str, state: dict[str, t.Any], session_id: str) -> ActionResult:
    """An outline-bearing action (open / snapshot): the outline is both
    the model's feed and the settlement's ``snapshot``/``elements``."""
    frame = session.frame(session_id)
    return ActionResult(
        feed=feed + _download_lines(session_id),
        frames=[{**frame, "agent": session_id}],
        page=_page(state),
        snapshot=str(state["snapshot"]),
        elements=_outline_lines(state["snapshot"]),
    )


def _state_result(verb: str, state: dict[str, t.Any], session_id: str) -> ActionResult:
    """A ref-driving action's result (click / type / press): the state
    line, and -- when the action NAVIGATED -- the fresh outline rides
    along (refs die on navigation; the automatic re-snapshot saves the
    model one round).  Refs never die to a plain re-render, so no
    outline means the model's refs still stand."""
    feed = f"{verb} {_obs(state)}"
    snapshot = state.get("snapshot")
    if snapshot:
        feed += _navigated_tail(str(snapshot))
    feed += _download_lines(session_id)
    return ActionResult(
        feed=feed,
        frames=[{**session.frame(session_id), "agent": session_id}],
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


def _act_open(args: dict[str, t.Any], session_id: str) -> ActionResult:
    url = _guard_open_url(str(args.get("url") or ""))
    state = session.open_url(session_id, url)
    return _outline_result(
        f"opened {state['url']} -- {state['title']}\n\n{state['snapshot']}", state, session_id
    )


def _act_snapshot(_args: dict[str, t.Any], session_id: str) -> ActionResult:
    state = session.snapshot(session_id)
    return _outline_result(f"{state['url']} -- {state['title']}\n\n{state['snapshot']}", state, session_id)


def _act_click(args: dict[str, t.Any], session_id: str) -> ActionResult:
    if args.get("x") is not None or args.get("y") is not None:
        # the aimed click: viewport coordinates for widget interiors a ref
        # cannot name (challenge tiles inside an iframe the snapshot reffed
        # as one box, canvas hit-regions)
        state = session.click_xy(session_id, args.get("x"), args.get("y"))
        return _state_result(f"clicked at {args.get('x')},{args.get('y')}.", state, session_id)
    state = session.click(session_id, str(args.get("ref") or ""))
    if state.get("popup"):
        # the click spawned a page (target=_blank): it is IN the tab set
        # and active now, its own outline riding below
        return _outline_result(
            f"the click opened a NEW TAB -- it is active now: {state['url']} -- {state['title']}\n\n{state['snapshot']}",
            state,
            session_id,
        )
    return _state_result("clicked.", state, session_id)


def _act_hover(args: dict[str, t.Any], session_id: str) -> ActionResult:
    return _state_result("hovered.", session.hover(session_id, str(args.get("ref") or "")), session_id)


def _act_select(args: dict[str, t.Any], session_id: str) -> ActionResult:
    state = session.select_options(session_id, str(args.get("ref") or ""), list(args.get("values") or []))
    chosen = ", ".join(str(c) for c in state.get("chosen") or [])
    return _state_result(f"selected: {chosen}.", state, session_id)


def _act_drag(args: dict[str, t.Any], session_id: str) -> ActionResult:
    state = session.drag(
        session_id,
        args.get("x1"),
        args.get("y1"),
        args.get("x2"),
        args.get("y2"),
        args.get("steps") or 15,
    )
    return _state_result(
        f"dragged {args.get('x1')},{args.get('y1')} -> {args.get('x2')},{args.get('y2')}.",
        state,
        session_id,
    )


def _act_type(args: dict[str, t.Any], session_id: str) -> ActionResult:
    state = session.type_text(
        session_id, str(args.get("ref") or ""), str(args.get("text") or ""), args.get("submit") is True
    )
    return _state_result("typed.", state, session_id)


def _act_press(args: dict[str, t.Any], session_id: str) -> ActionResult:
    return _state_result(
        f"pressed {args.get('key')}.", session.press_key(session_id, str(args.get("key") or "")), session_id
    )


def _act_scroll(args: dict[str, t.Any], session_id: str) -> ActionResult:
    text = str(args.get("text") or "").strip()
    if text:
        # the TARGETED scroll: bring the first page region matching the
        # text into view (the element's box rides the action mark)
        state = session.scroll_to_text(session_id, text)
        return _state_result(f"scrolled to {text[:60]!r}.", state, session_id)
    state = session.scroll(session_id, str(args.get("direction") or "down"))
    return ActionResult(
        feed=f"scrolled {args.get('direction')}. {_obs(state)}\n{_download_lines(session_id)}",
        frames=[{**session.frame(session_id), "agent": session_id}],
        page=_page(state),
    )


def _act_screenshot(args: dict[str, t.Any], session_id: str) -> ActionResult:
    ref = str(args.get("ref") or "")
    region = [args.get(k) for k in ("x", "y", "w", "h")]
    if ref and any(v is not None for v in region):
        raise SessionError("screenshot takes a ref (element close-up) OR a region (x y w h), not both")
    if any(v is not None for v in region) and not all(v is not None for v in region):
        raise SessionError("the screenshot region needs x, y, w and h together (viewport coordinates)")
    if ref:
        # the aimed shot: ONE element close-up instead of the viewport
        # (the crop is what the model sees next turn)
        shot = session.inspect_b64(session_id, ref, quality=75)
        box = shot.get("box")
        if box:
            session.set_mark(
                session_id,
                {
                    "px": int(box[0] + box[2] / 2),
                    "py": int(box[1] + box[3] / 2),
                    "pk": "shot",
                    "name": session.ref_name(session_id, ref),
                    "box": box,
                },
            )
        else:
            session.set_mark(session_id, {"pk": "shot", "name": session.ref_name(session_id, ref)})
    elif all(v is not None for v in region):
        # the region crop: a viewport rectangle by coordinates (the same
        # viewport space the coordinate clicks aim in)
        try:
            x, y, w, h = (max(0, int(v)) for v in region)
        except (TypeError, ValueError) as exc:
            raise SessionError(f"the screenshot region needs integer x y w h: {exc}") from exc
        shot = session.region_b64(session_id, x, y, w, h, quality=75)
        box = shot["box"]
        session.set_mark(
            session_id,
            {
                "px": int(box[0] + box[2] / 2),
                "py": int(box[1] + box[3] / 2),
                "pk": "shot",
                "box": box,
            },
        )
    else:
        shot = session.screenshot_b64(session_id, quality=75)
        session.set_mark(
            session_id,
            {
                "px": int(shot["w"] / 2),
                "py": int(shot["h"] / 2),
                "pk": "shot",
            },
        )
    return ActionResult(
        feed="",
        frames=[
            {
                "img": shot["img"],
                "w": shot["w"],
                "h": shot["h"],
                "url": shot["url"],
                "title": shot["title"],
                "agent": session_id,
            }
        ],
        image=f"data:image/jpeg;base64,{shot['img']}",
        page={"url": str(shot["url"]), "title": str(shot["title"])},
    )


def _act_history(args: dict[str, t.Any], session_id: str) -> ActionResult:
    op = str(args.get("op") or "")
    state = session.history(session_id, op)
    return _state_result(f"{op}.", state, session_id)


def _act_read(args: dict[str, t.Any], session_id: str) -> ActionResult:
    name = str(args.get("download") or "").strip()
    if name:
        # a CAPTURED download instead of the live page (pdf / office /
        # text -- the security gate only ever saved readable kinds)
        doc = session.read_download(session_id, name)
        return ActionResult(
            feed=f"{name}\n\n{doc['text']}",
            frames=[{**session.frame(session_id), "agent": session_id}],
        )
    # the read lane's cap is the shared extraction budget (lazy import:
    # the read module pulls the render engine)
    # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.tools.browse.read import max_chars as reader_max_chars

    state = session.extract(session_id, reader_max_chars())
    return ActionResult(
        feed=f"{state['title']}\n\n{state['text']}",
        frames=[{**session.frame(session_id), "agent": session_id}],
        page=_page(state),
    )


def _act_close(_args: dict[str, t.Any], session_id: str) -> ActionResult:
    session.close_page(session_id)
    return ActionResult(feed="the browser session is closed", frames=[])


def _tab_line(tabs: list[dict[str, t.Any]]) -> str:
    return "\n".join(
        f"  [{tab['index']}]{'' if tab.get('active') else ''} {tab['title'] or '(untitled)'} ({tab['url']})"
        for tab in tabs
    )


def _act_tab(args: dict[str, t.Any], session_id: str) -> ActionResult:
    """The session's tab strip: new (open+activate, the outline rides) /
    switch (activate, the page's own outline rides -- refs are per-page) /
    close (a closed active activates its neighbour) / list."""
    op = str(args.get("op") or "list")
    if op == "new":
        url = _guard_open_url(str(args.get("url") or ""))
        state = session.tab_new(session_id, url)
        result = _outline_result(
            f"new tab opened and active: {state['url']} -- {state['title']}\n\n{state['snapshot']}",
            state,
            session_id,
        )
        return result._replace(tabs=state.get("tabs"))
    if op == "switch":
        state = session.tab_switch(session_id, args.get("index"))
        result = _outline_result(
            f"switched to tab [{state['index']}]: {state['url']} -- {state['title']}"
            " (refs are per-page -- this page's outline follows)\n\n"
            f"{state['snapshot']}",
            state,
            session_id,
        )
        return result._replace(tabs=state.get("tabs"))
    if op == "close":
        state = session.tab_close(session_id, args.get("index"))
        remaining = state.get("tabs") or []
        feed = f"closed tab [{state.get('closed')}]."
        if remaining:
            feed += f" the strip now:\n{_tab_line(remaining)}"
        else:
            feed += " no tabs remain -- the next action opens a fresh page."
        return ActionResult(
            feed=feed,
            frames=[{**session.frame(session_id), "agent": session_id}],
            page=None,
            tabs=state.get("tabs"),
        )
    state = session.tab_list(session_id)
    tabs = state.get("tabs") or []
    feed = "tabs:" if tabs else "no open tabs -- open one with tab op=new."
    if tabs:
        feed += f"\n{_tab_line(tabs)}"
    return ActionResult(
        feed=feed,
        frames=[{**session.frame(session_id), "agent": session_id}],
        tabs=tabs,
    )


_MAX_MULTI_STEPS = 5
"""One batch's step budget -- a multi is a latency tool (skip model
rounds between mechanical steps), not a whole-flow script."""


def _act_multi(args: dict[str, t.Any], session_id: str) -> ActionResult:
    """BATCHED actions in ONE call (browser-use's multi_act): each step
    is a full action object, executed in order; the first failure stops
    the batch (its error rides the feed).  Each step contributes its
    FIRST feed line; the LAST successful step's visual result (frames /
    page / snapshot / image) is the batch's -- an intermediate
    navigation's outline is superseded by the final state, and a step
    after a navigation fails fast with the re-snapshot recipe (the
    batch's own stop)."""
    raw = args.get("steps")
    if not isinstance(raw, list) or not raw:
        return ActionResult(feed="error: multi needs steps -- a non-empty list of action objects")
    steps = raw[:_MAX_MULTI_STEPS]
    feeds: list[str] = []
    last: ActionResult | None = None
    for i, step in enumerate(steps, 1):
        if not isinstance(step, dict):
            feeds.append(f"{i}. error: a step must be an action object")
            break
        result = _dispatch(step, session_id)
        first = str(result.feed).split("\n", 1)[0]
        feeds.append(f"{i}. {step.get('action')}: {first}")
        if first.startswith("error:"):
            break
        last = result
    if len(raw) > _MAX_MULTI_STEPS:
        feeds.append(f"(the batch was cut at {_MAX_MULTI_STEPS} steps)")
    feed = "\n".join(feeds)
    if last is None:
        return ActionResult(feed=feed)
    return ActionResult(
        feed=feed,
        frames=last.frames,
        image=last.image,
        page=last.page,
        snapshot=last.snapshot,
        elements=last.elements,
    )


_ACTORS = {
    "open": _act_open,
    "snapshot": _act_snapshot,
    "click": _act_click,
    "type": _act_type,
    "press": _act_press,
    "scroll": _act_scroll,
    "screenshot": _act_screenshot,
    "hover": _act_hover,
    "select": _act_select,
    "drag": _act_drag,
    "read": _act_read,
    "history": _act_history,
    "tab": _act_tab,
    "multi": _act_multi,
    "close": _act_close,
}


def run_action(args: dict[str, t.Any], session_id: str = session.LEAD) -> ActionResult:
    """One non-blocking action on the SESSION (``lead`` by default; a
    subagent passes its own id).  ``screenshot`` returns its jpeg as the
    ``image`` data URL instead of a feed (the caller injects it as the
    next turn's image and answers with the standard attachment line);
    every other action answers with feed text.  EVERY action captures a
    mirror frame after it settles -- the rail's card stays live through
    the whole model-driven stretch, and the frame doubles as the
    timeline row's visual (volatile, never persisted).  The frames carry
    the ``agent`` tag (the client's tab strip keys on it)."""
    return _dispatch(args, session_id)


def _dispatch(args: dict[str, t.Any], session_id: str) -> ActionResult:
    """One action object -> one ActionResult (the batch's step engine is
    the same dispatch): unknown actions and SessionErrors degrade to
    feed text -- an action never raises into the executor."""
    actor = _ACTORS.get(str(args.get("action") or ""))
    if actor is None:
        return ActionResult(feed=f"error: unknown action {args.get('action')!r}")
    try:
        return actor(args, session_id)
    except SessionError as exc:
        return ActionResult(feed=f"error: {exc}")


def final_frame(session_id: str = session.LEAD) -> dict[str, t.Any] | None:
    """One last mirror frame after the human's window: the page as the
    model is about to read it -- and the frame WITHOUT ``wait_left``
    tells the client the window is over (the sticky prompt retires)."""
    try:
        return session.frame(session_id)
    except SessionError:
        return None


def wait_user_frames(seconds: int, session_id: str = session.LEAD) -> t.Iterator[dict[str, t.Any]]:
    """The human's operation window, one mirror frame per poll -- the
    frames double as the stream's heartbeats (a blocking wait must keep
    the wire fed or the transport guard kills the run).  LEAD-ONLY: a
    subagent session never blocks on the user (its frames carry the
    agent tag; the takeover is the lead's surface).  Three consecutive
    frame failures end the window early: a dead engine must not leave
    the wire silent for the whole window with a frozen mirror -- the
    post-window snapshot surfaces the failure to the model."""
    if session_id != session.LEAD:
        raise SessionError("wait_user is the lead session's window -- subagents decide alone")
    session.reset_wait(session_id)
    deadline = time.monotonic() + max(10, min(int(seconds), 600))
    failures = 0
    while True:
        remaining = int(deadline - time.monotonic())
        if remaining <= 0:
            return
        if session.wait_done(session_id):
            return
        try:
            frame = session.frame(session_id)
            failures = 0
        except SessionError:
            failures += 1
            if failures >= 3:
                return
            time.sleep(_WAIT_POLL_S)
            continue
        frame["wait_left"] = remaining
        frame["agent"] = session_id
        yield frame
        time.sleep(_WAIT_POLL_S)


def wait_user_snapshot(max_chars: int | None, session_id: str = session.LEAD) -> dict[str, t.Any]:
    """The feed after the human's window: where the page stands now -- the
    fresh outline AND the page's readable text (the model judges from
    CONTENT whether the goal is met, not from element names alone).  The
    page state rides beside the feed: the executor numbers the post-login
    page as a citable source and the client archives the text."""
    state = session.snapshot(session_id)
    header = (
        "the user's operation window ended -- decide from the page below"
        f" whether the goal is met or another window is needed.\n\n{state['url']}"
        f" -- {state['title']}\n\n{state['snapshot']}"
    )
    try:
        page = session.extract(session_id, max_chars)
        body = f"\n\n--- the page's readable text ---\n\n{page['text']}"
        return {
            "feed": header + body,
            "url": page["url"],
            "title": page["title"],
            "text": page["text"],
        }
    except SessionError:
        return {"feed": header, "url": str(state["url"]), "title": str(state["title"]), "text": ""}
