# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``web_browser`` action dispatch: JSON arguments in, model-facing
feed text out, with the mirror frames and the screenshot payload as
side channels the executor generator interleaves into the wire."""

import time
import typing as t

from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.browser import session
from searx.zjsearch.ai.browser.session import SessionError

_WAIT_POLL_S = 2.0
"""The wait_user frame cadence -- frames ARE the heartbeats that keep
the stream alive through the human's operation window."""


def _obs(state: dict[str, str]) -> str:
    return f"now: {state.get('title') or '(untitled)'} ({state.get('url')})"


def run_action(  # pylint: disable=too-many-return-statements
    args: dict[str, t.Any],
) -> tuple[str, list[dict[str, t.Any]], str | None]:
    """One non-blocking action: ``(feed, mirror_frames, screenshot_data_url)``.

    ``screenshot`` returns its jpeg as a data URL instead of a feed (the
    caller injects it as the next turn's image and answers with the
    standard attachment line)."""
    action = str(args.get("action") or "")
    frames: list[dict[str, t.Any]] = []
    try:
        if action == "open":
            state = session.open_url(str(args.get("url") or ""))
            frames.append(session.frame())
            return f"opened {state['url']} -- {state['title']}\n\n{state['snapshot']}", frames, None
        if action == "snapshot":
            state = session.snapshot()
            return f"{state['url']} -- {state['title']}\n\n{state['snapshot']}", frames, None
        if action == "click":
            return f"clicked. {_obs(session.click(str(args.get('ref') or '')))}", frames, None
        if action == "type":
            state = session.type_text(
                str(args.get("ref") or ""), str(args.get("text") or ""), args.get("submit") is True
            )
            return f"typed. {_obs(state)}", frames, None
        if action == "press":
            return f"pressed {args.get('key')}. {_obs(session.press_key(str(args.get('key') or '')))}", frames, None
        if action == "scroll":
            return (
                f"scrolled {args.get('direction')}. {_obs(session.scroll(str(args.get('direction') or 'down')))}",
                frames,
                None,
            )
        if action == "screenshot":
            shot = session.screenshot_b64(quality=75)
            return "", frames, f"data:image/jpeg;base64,{shot['img']}"
        if action == "read":
            state = session.extract(browser_config.max_chars())
            return f"{state['title']}\n\n{state['text']}", frames, None
        if action == "close":
            session.close_page()
            return "the browser session is closed", frames, None
    except SessionError as exc:
        return f"error: {exc}", frames, None
    return f"error: unknown action {action!r}", frames, None


def wait_user_frames(seconds: int) -> t.Iterator[dict[str, t.Any]]:
    """The human's operation window, one mirror frame per poll -- the
    frames double as the stream's heartbeats (a blocking wait must keep
    the wire fed or the transport guard kills the run)."""
    session.reset_wait()
    deadline = time.monotonic() + max(10, min(int(seconds), 600))
    while True:
        remaining = int(deadline - time.monotonic())
        if remaining <= 0:
            return
        if session.wait_done():
            return
        try:
            frame = session.frame()
            frame["wait_left"] = remaining
            yield frame
        except SessionError:
            pass
        time.sleep(_WAIT_POLL_S)


def wait_user_snapshot(max_chars: int | None) -> str:
    """The feed after the human's window: where the page stands now -- the
    fresh outline AND the page's readable text (the model judges from
    CONTENT whether the goal is met, not from element names alone)."""
    state = session.snapshot()
    header = (
        "the user's operation window ended -- decide from the page below"
        f" whether the goal is met or another window is needed.\n\n{state['url']}"
        f" -- {state['title']}\n\n{state['snapshot']}"
    )
    try:
        page = session.extract(max_chars)
        body = f"\n\n--- the page's readable text ---\n\n{page['text']}"
    except SessionError:
        body = ""
    return header + body
