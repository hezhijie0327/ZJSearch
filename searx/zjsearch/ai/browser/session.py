# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The interactive session: ONE page a tool drive can operate.

The ``web_browser`` tool's actions land here as synchronous bridges onto
the shared loop (the mcp/read pattern): a single session page inside the
persistent context, snapshot refs resolved via injected ``data-zjs-ref``
attributes, and raw input primitives for the Lightbox takeover
(viewport-space clicks/wheel/keys forwarded from the user's browser).
The session lock serializes discrete actions across the reader's worker
threads; ``wait_user`` polls WITHOUT holding it so the user's Lightbox
input interleaves between polls.

Ref lifecycle: navigation invalidates injected refs -- the spec tells
the model to re-snapshot after one.
"""

import asyncio
import base64
import concurrent.futures
import logging
import re
import threading
import typing as t

from searx.network.client import get_loop
from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.browser import gate
from searx.zjsearch.ai.browser.engine import _context

if t.TYPE_CHECKING:
    from playwright.async_api import Page

logger = logging.getLogger(__name__)

SNAPSHOT_MAX_ELEMENTS = 120
"""The outline's element budget -- the model's primary read must stay a
cheap one."""

_ACTION_TIMEOUT_MS = 15_000

_LOCK = threading.Lock()
_page: "Page | None" = None
_wait_done = threading.Event()
"""Set by the Lightbox's finish button: the pending wait_user window
returns at the next poll (<=2s) instead of running its full length."""

_SNAPSHOT_JS = """
() => {
  const sel = 'a[href], button, input, select, textarea, [onclick], '
    + '[role="button"], [role="link"], [role="textbox"], [role="checkbox"], '
    + '[role="combobox"], [role="radio"], [role="searchbox"], [role="tab"]';
  const out = [];
  window.__zjsRef = window.__zjsRef || 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const ref = 'e' + (++window.__zjsRef);
    el.setAttribute('data-zjs-ref', ref);
    const label = el.labels && el.labels[0] ? el.labels[0].textContent : '';
    const val = 'value' in el && el.value !== '' && el.value != null ? String(el.value).slice(0, 80) : '';
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder')
      || val || label || (el.textContent || '').trim().slice(0, 80)
      || el.getAttribute('title') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    out.push(ref + '\\t' + role + '\\t' + name);
    if (out.length >= %d) break;
  }
  return out.join('\\n');
}
""" % SNAPSHOT_MAX_ELEMENTS


class SessionError(Exception):
    """A session action failed -- the message travels to the model."""


def _brief(exc: BaseException) -> str:
    return " ".join(str(exc).split())[:200] or type(exc).__name__


def _run(coro: t.Any, timeout: float = 45.0) -> t.Any:
    future = asyncio.run_coroutine_threadsafe(coro, get_loop())
    try:
        return future.result(timeout=timeout)
    except concurrent.futures.TimeoutError as exc:
        future.cancel()
        raise SessionError("the browser session timed out") from exc
    except SessionError:
        raise
    except Exception as exc:  # pylint: disable=broad-except
        raise SessionError(f"browser session failed: {type(exc).__name__}: {_brief(exc)}") from exc


async def _ensure_page() -> "Page":
    global _page  # pylint: disable=global-statement
    if _page is not None and not _page.is_closed():
        return _page
    context = await _context()
    page = await context.new_page()
    await page.set_viewport_size({"width": 1280, "height": 800})
    # the session page renders FOR THE USER: its stylesheets/fonts/images
    # pass the gate (the reader's pages stay text-only)
    gate.visual_pages.add(id(page))
    _page = page
    return page


def finish_wait() -> None:
    """The Lightbox's finish signal: end the pending wait_user window at
    the next poll."""
    _wait_done.set()


def reset_wait() -> None:
    """Clear the finish signal (wait_user start)."""
    _wait_done.clear()


def wait_done() -> bool:
    return _wait_done.is_set()


def _resolve_selector(ref: str) -> str:
    ref = str(ref or "").strip()
    if not re.fullmatch(r"e\d+", ref):
        raise SessionError("a snapshot ref (e.g. e12) is required -- take a fresh snapshot")
    return f'[data-zjs-ref="{ref}"]'


def open_url(url: str) -> dict[str, str]:
    """Navigate the session page; returns ``{url, title, snapshot}`` -- the
    outline rides along so one call costs the model one round."""
    with _LOCK:

        async def run() -> dict[str, str]:
            page = await _ensure_page()
            try:
                await page.goto(url, wait_until="load", timeout=browser_config.goto_timeout_ms())
            except Exception as exc:  # pylint: disable=broad-except
                raise SessionError(f"could not open the page ({_brief(exc)})") from exc
            try:
                await page.wait_for_load_state("networkidle", timeout=3_500)
            except Exception:  # pylint: disable=broad-except
                pass
            await page.wait_for_timeout(browser_config.settle_ms())
            outline = await page.evaluate(_SNAPSHOT_JS)
            return {"url": str(page.url), "title": await page.title(), "snapshot": outline}

        return _run(run())


def snapshot() -> dict[str, str]:
    """A fresh ref outline of the CURRENT page."""
    with _LOCK:

        async def run() -> dict[str, str]:
            page = await _ensure_page()
            outline = await page.evaluate(_SNAPSHOT_JS)
            return {"url": str(page.url), "title": await page.title(), "snapshot": outline}

        return _run(run())


def click(ref: str) -> dict[str, str]:
    with _LOCK:

        async def run() -> dict[str, str]:
            page = await _ensure_page()
            await page.click(_resolve_selector(ref), timeout=_ACTION_TIMEOUT_MS)
            await page.wait_for_timeout(600)
            return {"url": str(page.url), "title": await page.title()}

        return _run(run())


def type_text(ref: str, text: str, submit: bool) -> dict[str, str]:
    with _LOCK:

        async def run() -> dict[str, str]:
            page = await _ensure_page()
            await page.fill(_resolve_selector(ref), str(text), timeout=_ACTION_TIMEOUT_MS)
            if submit:
                await page.keyboard.press("Enter")
            await page.wait_for_timeout(400)
            return {"url": str(page.url), "title": await page.title()}

        return _run(run())


def press_key(key: str) -> dict[str, str]:
    with _LOCK:

        async def run() -> dict[str, str]:
            page = await _ensure_page()
            await page.keyboard.press(str(key))
            await page.wait_for_timeout(300)
            return {"url": str(page.url), "title": await page.title()}

        return _run(run())


def scroll(direction: str) -> dict[str, str]:
    with _LOCK:

        async def run() -> dict[str, str]:
            page = await _ensure_page()
            await page.mouse.wheel(0, 600 if str(direction) == "down" else -600)
            await page.wait_for_timeout(400)
            return {"url": str(page.url), "title": await page.title()}

        return _run(run())


def screenshot_b64(quality: int = 70) -> dict[str, t.Any]:
    """A viewport screenshot as ``{img, w, h, url, title}`` -- the visual
    branch's payload (injected to the model) and the mirror frame shape."""
    with _LOCK:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page()
            raw = await page.screenshot(type="jpeg", quality=int(quality))
            vp = page.viewport_size or {"width": 1280, "height": 800}
            return {
                "img": base64.b64encode(raw).decode("ascii"),
                "w": int(vp["width"]),
                "h": int(vp["height"]),
                "url": str(page.url),
                "title": await page.title(),
            }

        return _run(run())


def frame() -> dict[str, t.Any]:
    """The mirror frame: the same capture at mirror quality."""
    return screenshot_b64(quality=55)


def extract(max_chars: int | None) -> dict[str, str]:
    """The CURRENT page condensed to reading material (title + markdown)
    -- the reader's extraction pipeline over the live DOM."""
    # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.tools.web_reader.extract import (
        PageReadError,
        extract_page,
    )

    with _LOCK:

        async def run() -> dict[str, str]:
            page = await _ensure_page()
            return {"url": str(page.url), "title": await page.title(), "html": await page.content()}

        page_state = _run(run())
    try:
        title, text = extract_page(page_state["html"], page_state["url"], max_chars)
    except PageReadError as exc:
        raise SessionError(str(exc)) from exc
    return {"url": page_state["url"], "title": title, "text": text}


def close_page() -> None:
    """Close the session page -- the persistent context (and its cookies)
    stays; the next action opens a fresh page."""
    global _page  # pylint: disable=global-statement
    with _LOCK:
        page = _page
        _page = None
        gate.visual_pages.discard(id(page))
        _wait_done.set()

        async def run() -> None:
            if page is not None and not page.is_closed():
                await page.close()

        _run(run())


def session_input(
    # pylint: disable=invalid-name
    kind: str,
    x: int = 0,
    y: int = 0,
    delta_y: int = 0,
    text: str = "",
    key: str = "",
) -> None:
    """The Lightbox takeover's forwarded input, in viewport space."""
    with _LOCK:

        async def run() -> None:
            page = await _ensure_page()
            if kind == "click":
                await page.mouse.click(int(x), int(y))
            elif kind == "wheel":
                await page.mouse.wheel(0, int(delta_y))
            elif kind == "type":
                await page.keyboard.type(str(text))
            elif kind == "key":
                await page.keyboard.press(str(key))
            else:
                raise SessionError(f"unknown input kind: {kind!r}")

        _run(run())
