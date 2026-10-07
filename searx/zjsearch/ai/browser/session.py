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
from urllib.parse import quote_plus

from searx.network.client import get_loop
from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.browser import gate
from searx.zjsearch.ai.browser.engine import _context, drop_context

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


_SEARCH_ENGINES = {
    "bing": "https://www.bing.com/search?q={q}",
    "baidu": "https://www.baidu.com/s?wd={q}",
    "google": "https://www.google.com/search?q={q}",
    "duckduckgo": "https://duckduckgo.com/?q={q}",
}
"""The session's live-SERP engines: real browser searches carry the
anti-detect fingerprint (camoufox) instead of searx's engine clients --
the fallback when the normal engines are bot-walled or captcha'd."""

_SEARCH_MAX_RESULTS = 10

_SEARCH_SCRAPE_JS = """
(engine) => {
  const conf = {
    bing: { row: '#b_results > li.b_algo', title: 'h2 a', snippet: '.b_caption p, p' },
    baidu: { row: '#content_left .result, #content_left .c-container', title: 'h3 a',
             snippet: '.c-abstract, .c-span-last, [class*="content"]' },
    google: { row: '#search div.g, #rso div.g', title: 'a h3', snippet: '.VwiC3b, div[data-snf]' },
    duckduckgo: { row: '#links article, article[data-testid="result"]', title: 'h2 a',
                  snippet: '[data-result="snippet"], div span' },
  }[engine];
  if (!conf) return '';
  const out = [];
  for (const row of document.querySelectorAll(conf.row)) {
    const a = row.querySelector(conf.title);
    if (!a || !a.href) continue;
    const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim();
    const text = clean(row.querySelector(conf.snippet)?.textContent).slice(0, 220);
    out.push(clean(a.textContent).slice(0, 120) + '\\t' + a.href + '\\t' + text);
    if (out.length >= %d) break;
  }
  return out.join('\\n');
}
""" % _SEARCH_MAX_RESULTS


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
        msg = str(exc).lower()
        # playwright's crash/closed vocabulary only -- a plain dead
        # upstream ("net::ERR_CONNECTION_CLOSED") must NOT drop the warm
        # context and cost a relaunch
        if "has been closed" in msg or ("closed" in msg and ("browser" in msg or "context" in msg or "target" in msg)):
            # the browser died mid-run: drop the poisoned context so the
            # next action relaunches (the engine's read path heals the
            # same way) -- without this every later action fails forever
            drop_context()
        raise SessionError(f"browser session failed: {type(exc).__name__}: {_brief(exc)}") from exc


async def _ensure_page() -> "Page":
    global _page  # pylint: disable=global-statement
    if _page is not None and not _page.is_closed():
        return _page
    context = await _context()
    page = await context.new_page()
    await page.set_viewport_size({"width": 1280, "height": 800})
    # the session page renders FOR THE USER: its stylesheets/fonts/images
    # pass the gate (the reader's pages stay text-only) -- strong refs
    # keyed by id(), the stale entry dropped on replace
    if _page is not None:
        gate.visual_pages.pop(id(_page), None)
    gate.visual_pages[id(page)] = page
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


async def _post_action_state(page: "Page", before_url: str, settle_wait_ms: int) -> dict[str, t.Any]:
    """The state after one mutating action: url + title, PLUS a fresh
    outline when the action navigated (navigation invalidates every
    injected ref -- riding the new outline with the action's result is
    one model round saved, the re-snapshot doctrine made automatic)."""
    try:
        await page.wait_for_load_state("load", timeout=5_000)
    except Exception:  # pylint: disable=broad-except
        pass
    await page.wait_for_timeout(settle_wait_ms)
    out: dict[str, t.Any] = {"url": str(page.url), "title": await page.title()}
    if out["url"] != before_url:
        await _settle_page(page)
        out["snapshot"] = await page.evaluate(_SNAPSHOT_JS)
    return out


async def _settle_page(page: "Page") -> None:
    """The open_url settle treatment for a navigated page: best-effort
    network idle, then the configured hydration wait."""
    try:
        await page.wait_for_load_state("networkidle", timeout=3_500)
    except Exception:  # pylint: disable=broad-except
        pass
    await page.wait_for_timeout(browser_config.settle_ms())


async def _resolve_live(page: "Page", ref: str) -> str:
    """The selector for a snapshot ref, verified present: a ref that died
    to a re-render (no navigation -- refs only die to navigation) fails
    HERE with the recovery recipe instead of burning the action timeout
    on a locator wait."""
    sel = _resolve_selector(ref)
    if not await page.locator(sel).count():
        raise SessionError(
            f"ref {ref} is no longer on the page (it re-rendered under you)"
            " -- take a fresh snapshot and address the element by its new ref"
        )
    return sel


def click(ref: str) -> dict[str, t.Any]:
    with _LOCK:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page()
            before = str(page.url)
            sel = await _resolve_live(page, ref)
            await page.click(sel, timeout=_ACTION_TIMEOUT_MS)
            return await _post_action_state(page, before, 600)

        return _run(run())


def type_text(ref: str, text: str, submit: bool) -> dict[str, t.Any]:
    with _LOCK:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page()
            before = str(page.url)
            sel = await _resolve_live(page, ref)
            await page.fill(sel, str(text), timeout=_ACTION_TIMEOUT_MS)
            if submit:
                await page.keyboard.press("Enter")
            return await _post_action_state(page, before, 400)

        return _run(run())


def press_key(key: str) -> dict[str, t.Any]:
    with _LOCK:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page()
            before = str(page.url)
            await page.keyboard.press(str(key))
            return await _post_action_state(page, before, 300)

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


def _serp_relevant(raw: str, query: str) -> bool:
    """Cheap sanity check on a scraped SERP: at least one query token
    must appear in the rows -- the engines occasionally serve a degraded
    first frame (trending filler to a fresh fingerprint), and feeding
    that to the model as "results" is worse than an honest retry."""
    tokens = [t for t in re.split(r"[\s\-+,.;:]+", str(query or "").lower()) if len(t) > 2]
    if not tokens:
        return True
    hay = raw.lower()
    return any(token in hay for token in tokens)


def search_results(engine: str, query: str) -> dict[str, str]:
    """One LIVE search-engine query on the session page: navigate the
    engine's SERP and scrape the organic hits (title/url/snippet).  The
    compact result block is the payload -- a SERP needs no refs, so no
    outline rides along."""
    template = _SEARCH_ENGINES.get(str(engine or "").strip().lower())
    if template is None:
        raise SessionError(f"unknown engine {engine!r} -- bing / baidu / google / duckduckgo")
    url = template.format(q=quote_plus(str(query or "")[:400]))
    with _LOCK:

        async def run() -> dict[str, str]:
            page = await _ensure_page()
            try:
                await page.goto(url, wait_until="load", timeout=browser_config.goto_timeout_ms())
            except Exception as exc:  # pylint: disable=broad-except
                raise SessionError(f"the search page could not open ({_brief(exc)})") from exc
            await _settle_page(page)
            raw = str(await page.evaluate(_SEARCH_SCRAPE_JS, str(engine).strip().lower()) or "")
            if raw and not _serp_relevant(raw, query):
                # degraded first frame: one settle-and-rescrape before
                # giving up (the relevance guard, not heuristics about
                # content -- a genuinely odd SERP still passes through)
                await page.wait_for_timeout(2_000)
                raw = str(await page.evaluate(_SEARCH_SCRAPE_JS, str(engine).strip().lower()) or "")
            return {"url": str(page.url), "title": await page.title(), "results": raw}

        return _run(run())


def close_page() -> None:
    """Close the session page -- the persistent context (and its cookies)
    stays; the next action opens a fresh page."""
    global _page  # pylint: disable=global-statement
    with _LOCK:
        page = _page
        _page = None
        if page is not None:
            gate.visual_pages.pop(id(page), None)
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
