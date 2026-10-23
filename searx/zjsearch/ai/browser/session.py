# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The interactive sessions: keyed pages a tool drive can operate.

The ``browse`` tool's actions land here as synchronous bridges onto
the shared loop (the mcp/read pattern): each session is ONE page inside
the persistent context, snapshot refs resolved via injected
``data-zjs-ref`` attributes, and raw input primitives for the Lightbox
takeover (viewport-space clicks/wheel/keys forwarded from the user's
browser).  Each session's lock serializes discrete actions across the
reader's worker threads; ``wait_user`` polls WITHOUT holding it so the
user's Lightbox input interleaves between polls.

Session identity (v2.1 R3B): ``lead`` is THE model-driven lane the
takeover serves (its wait_user blocks on the human); parallel SUBAGENTS
drive their own sessions under ``sub-*`` ids -- same persistent context
(one cookie store, one SSRF request gate), separate pages, closed when
their loop ends.  Every function takes the id first (default ``lead``:
the pre-R3B call shapes keep working).

Ref lifecycle: navigation invalidates injected refs -- the spec tells
the model to re-snapshot after one.
"""

from __future__ import annotations
import asyncio
import base64
import concurrent.futures
import logging
import re
import threading
import typing as t
from urllib.parse import urlsplit

from searx.network.client import get_loop
from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.browser import gate
from searx.zjsearch.ai.browser.engine import _context, drop_context, WINDOW

if t.TYPE_CHECKING:
    from playwright.async_api import Page

logger = logging.getLogger(__name__)

SNAPSHOT_MAX_ELEMENTS = 120
"""The outline's element budget -- the model's primary read must stay a
cheap one."""

SNAPSHOT_IMG_SLOTS = 20
"""The img ANNEX on top of the element budget: sizeable visible images
get refs AFTER the interactive pass (additive -- a link farm must not
crowd the aimed screenshot's targets out, and a page without them costs
nothing)."""

SNAPSHOT_CHILD_FRAME_CAP = (30, 40)
"""Per-child-frame outline budget (interactive, total): embedded widgets
-- captcha challenge frames, payment forms -- MUST get refs even when
the main frame ate the whole global budget (the 2captcha demos run
~200 link-farm anchors), so child frames scan with their OWN cap, max
three frames per snapshot."""

_ACTION_TIMEOUT_MS = 15_000

LEAD = "lead"
"""The lead researcher's session: THE takeover surface (its wait_user
windows block on the human; subagent sessions never wait)."""

_MAX_SESSIONS = 6
"""Live sessions per instance (lead + the delegation batch's worth): a
runaway delegation cannot open unbounded browser tabs."""


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
  for (const el of document.querySelectorAll('img')) {
    if (out.length >= %d) break;
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 15) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const ref = 'e' + (++window.__zjsRef);
    el.setAttribute('data-zjs-ref', ref);
    const file = (el.currentSrc || el.src || '').split(/[?#]/)[0].split('/').pop() || '';
    const name = (el.getAttribute('alt') || file).replace(/\\s+/g, ' ').trim().slice(0, 80);
    out.push(ref + '\\timg\\t' + name);
  }
  return out.join('\\n');
}
"""

_SNAPSHOT_JS_TEMPLATE = _SNAPSHOT_JS
"""The raw scan (two ``%d`` caps: interactive lines, total lines incl.
the img annex) -- formatted per frame, so child frames can scan under
their own budget."""

_SNAPSHOT_JS = _SNAPSHOT_JS_TEMPLATE % (
    SNAPSHOT_MAX_ELEMENTS,
    SNAPSHOT_MAX_ELEMENTS + SNAPSHOT_IMG_SLOTS,
)
"""The main frame's scan: the budgets every stored thread knows."""

_ANNOTATE_JS = """
() => {
  document.getElementById('__zjs_ann')?.remove();
  // THE FAMILY ANNOTATION PALETTE (DESIGN.md S3, the registered extension):
  // fixed light-variant values -- the layer paints into a JPEG (canvas
  // exemption class).  Green = goes somewhere, red = triggers, gold =
  // accepts input (the brand gradient's deep end -- the most-tagged type
  // wears the brand), gray = everything else.
  const COLORS = { A: '#15803d', BUTTON: '#dc2626', INPUT: '#e09f0a',
                   TEXTAREA: '#e09f0a', SELECT: '#6b675c' };
  const DARK = '#241d0e';
  const root = document.createElement('div');
  root.id = '__zjs_ann';
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  let n = 0;
  for (const el of document.querySelectorAll('[data-zjs-ref]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const color = COLORS[el.tagName] || '#6b675c';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;'
      + 'width:' + r.width + 'px;height:' + r.height + 'px;'
      + 'border:2px dashed ' + color + ';border-radius:2px;';
    const tag = document.createElement('div');
    tag.textContent = el.getAttribute('data-zjs-ref');
    const above = r.top > 18;
    tag.style.cssText = 'position:fixed;'
      + 'left:' + (r.left + r.width / 2) + 'px;top:' + (above ? r.top - 18 : r.top + 2) + 'px;'
      + 'transform:translateX(-50%);background:' + color + ';'
      + 'color:' + (color === '#e09f0a' ? DARK : '#fff') + ';'
      + 'font:bold 11px Menlo,Consolas,monospace;line-height:14px;'
      + 'padding:1px 4px;border-radius:3px;white-space:nowrap;'
      + 'text-shadow:0 1px 1px rgba(0,0,0,.15);';
    root.append(box, tag);
    n++;
  }
  if (n) document.documentElement.appendChild(root);
  return n;
}
"""
"""The MIRROR ANNOTATION pass (the browser-use visual): every scanned
element's dashed type-colored outline + its ref badge painted IN THE
PAGE, for ONE capture only -- the injected layer is removed right after
the bytes land, so the model's own screenshots and the next scan never
see it.  Reads the LIVE geometry at capture time (the scan-time boxes
would go stale across scrolls); fixed positioning is per-frame, so the
child frames annotate under their own coordinate space."""

_ANNOTATE_REMOVE_JS = "() => { document.getElementById('__zjs_ann')?.remove(); }"


class SessionError(Exception):
    """A session action failed -- the message travels to the model."""


class _Session:  # pylint: disable=too-few-public-methods
    """One keyed session: its page, its lock, its wait_user flag, the
    MODEL POINTER -- the viewport-space landing point of the last
    ref-targeted action (click / type), so the client can draw a cursor
    that shows where the model is working -- and the ref NAME DIRECTORY
    (the last snapshot's ref -> accessible-name map, the action mark's
    vocabulary: the mirror label names the element it touched, not the
    machine ref)."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.page: "Page | None" = None
        # the session's TAB SET (``pages[active] is page`` -- the active
        # one): the model can open/switch/close pages inside one session
        self.pages: list["Page"] = []
        self.active: int = 0
        self.wait_done = threading.Event()
        self.mark: dict[str, t.Any] | None = None
        self.names: dict[str, str] = {}


_SESSIONS: dict[str, _Session] = {}
_SESSIONS_LOCK = threading.Lock()


def get(session_id: str) -> _Session:
    """The keyed session, created on first touch (capped -- the cap's
    overflow answers the LEAD session, which is always admitted)."""
    sid = session_id or LEAD
    with _SESSIONS_LOCK:
        sess = _SESSIONS.get(sid)
        if sess is None:
            if len(_SESSIONS) >= _MAX_SESSIONS and sid != LEAD:
                raise SessionError(f"the session table is full (max {_MAX_SESSIONS})")
            sess = _Session()
            _SESSIONS[sid] = sess
        return sess


def close(session_id: str) -> None:
    """Close and forget one session (a finished subagent's tab)."""
    sid = session_id or LEAD
    with _SESSIONS_LOCK:
        sess = _SESSIONS.pop(sid, None)
    if sess is None:
        return
    with sess.lock:
        pages = list(sess.pages) + ([] if sess.page is None else [sess.page])
        seen: set[int] = set()
        pages = [pg for pg in pages if id(pg) not in seen and not seen.add(id(pg))]
        sess.page = None
        sess.pages = []
        sess.active = 0
        for page in pages:
            gate.visual_pages.pop(id(page), None)
        sess.wait_done.set()

        async def run() -> None:
            for page in pages:
                if not page.is_closed():
                    await page.close()

        _run(run())


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


async def _ensure_page(sess: _Session) -> "Page":
    if sess.page is not None and not sess.page.is_closed():
        return sess.page
    # the active page died (crash / closed tab): a surviving tab takes
    # over before a new page is minted -- the tab set outlives one page
    sess.pages = [pg for pg in sess.pages if not pg.is_closed()]
    if sess.pages:
        sess.active = 0
        sess.page = sess.pages[0]
        return sess.page
    context = await _context()
    page = await context.new_page()
    await page.set_viewport_size({"width": WINDOW[0], "height": WINDOW[1]})
    # the session page renders FOR THE USER: its stylesheets/fonts/images
    # pass the gate (the reader's pages stay text-only) -- strong refs
    # keyed by id(), the stale entry dropped on replace
    if sess.page is not None:
        gate.visual_pages.pop(id(sess.page), None)
    gate.visual_pages[id(page)] = page
    sess.page = page
    sess.pages = [page]
    sess.active = 0
    return page


def finish_wait(session_id: str = LEAD) -> None:
    """The Lightbox's finish signal: end the pending wait_user window at
    the next poll."""
    get(session_id).wait_done.set()


def reset_wait(session_id: str = LEAD) -> None:
    """Clear the finish signal (wait_user start)."""
    get(session_id).wait_done.clear()


def wait_done(session_id: str = LEAD) -> bool:
    return get(session_id).wait_done.is_set()


def _resolve_selector(ref: str) -> tuple[str, int]:
    """The attribute selector + frame index for one snapshot ref: plain
    ``e12`` addresses the main frame, ``f1e5`` addresses frame 1 (the
    outline prefixes child-frame refs with their frame index -- the DOM
    attribute inside the frame stays the bare ``e5``)."""
    m = re.fullmatch(r"(?:f(\d+))?(e\d+)", str(ref or "").strip())
    if not m:
        raise SessionError("a snapshot ref (e.g. e12 or f1e5) is required -- take a fresh snapshot")
    return f'[data-zjs-ref="{m.group(2)}"]', int(m.group(1) or 0)


def open_url(session_id: str, url: str) -> dict[str, str]:
    """Navigate the session page; returns ``{url, title, snapshot}`` -- the
    outline rides along so one call costs the model one round."""
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, str]:
            page = await _ensure_page(sess)
            try:
                await page.goto(url, wait_until="load", timeout=browser_config.goto_timeout_ms())
            except Exception as exc:  # pylint: disable=broad-except
                raise SessionError(f"could not open the page ({_brief(exc)})") from exc
            try:
                await page.wait_for_load_state("networkidle", timeout=3_500)
            except Exception:  # pylint: disable=broad-except
                pass
            await page.wait_for_timeout(browser_config.settle_ms())
            outline = await _snapshot_page(sess, page)
            return {"url": str(page.url), "title": await page.title(), "snapshot": outline}

        return _run(run())


def snapshot(session_id: str = LEAD) -> dict[str, str]:
    """A fresh ref outline of the CURRENT page."""
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, str]:
            page = await _ensure_page(sess)
            outline = await _snapshot_page(sess, page)
            return {"url": str(page.url), "title": await page.title(), "snapshot": outline}

        return _run(run())


async def _post_action_state(sess: "_Session", page: "Page", before_url: str, settle_wait_ms: int) -> dict[str, t.Any]:
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
        out["snapshot"] = await _snapshot_page(sess, page)
    return out


async def _settle_page(page: "Page") -> None:
    """The open_url settle treatment for a navigated page: best-effort
    network idle, then the configured hydration wait."""
    try:
        await page.wait_for_load_state("networkidle", timeout=3_500)
    except Exception:  # pylint: disable=broad-except
        pass
    await page.wait_for_timeout(browser_config.settle_ms())


async def _resolve_holder(page: "Page", ref: str) -> tuple["Page | object", str]:
    """The click/fill/locator holder (the Page itself, or the child Frame
    an ``fN``-prefixed ref lives in) + the attribute selector, verified
    present: a ref that died to a re-render or a frame that went away
    fails HERE with the recovery recipe instead of burning the action
    timeout on a locator wait."""
    sel, frame_idx = _resolve_selector(ref)
    holder: "Page | object" = page
    if frame_idx:
        # frames[] is tree-ordered -- the SAME order the snapshot scan
        # enumerates, and the outline's fN is ONE-BASED over the child
        # list (f1 = the first child frame), so the index maps -1
        frames = _live_frames(page)
        if frame_idx > len(frames):
            raise SessionError(
                f"frame f{frame_idx} is gone (the page re-rendered under you)"
                " -- take a fresh snapshot and address the element by its new ref"
            )
        holder = frames[frame_idx - 1]
    if not await holder.locator(sel).count():
        raise SessionError(
            f"ref {ref} is no longer on the page (it re-rendered under you)"
            " -- take a fresh snapshot and address the element by its new ref"
        )
    return holder, sel


def _live_frames(page: "Page") -> list[t.Any]:
    """The page's REAL child frames in tree order (the main frame and
    about:blank / data: placeholders skipped) -- the snapshot scan and
    the ref resolver must agree on the indexing."""
    return [
        f
        for f in page.frames
        if f is not page.main_frame and not f.url.startswith(("about:blank", "data:"))
    ]


_SNAP_FRAME_HEADER = "\n-- frame f{} {} --\n"


_NAME_LINE_RE = re.compile(r"^((?:f\d+)?e\d+)\t[^\t]*\t(.*)$")


def _index_names(outline: str) -> dict[str, str]:
    """The snapshot outline's ref -> accessible-name directory -- the
    action mark's vocabulary (the mirror label names the element it
    touched, not the machine ref).  Rebuilt WHOLESALE
    per scan: refs die to re-renders, the model's next action addresses
    the current outline, and an unbounded dict must not outlive them."""
    out: dict[str, str] = {}
    for line in outline.splitlines():
        match = _NAME_LINE_RE.match(line)
        if match:
            out[match.group(1)] = match.group(2)
    return out


async def _snapshot_page(sess: "_Session", page: "Page") -> str:
    """The multi-frame outline: the MAIN frame first (its refs stay the
    un-prefixed ``e12`` every stored thread speaks), then each real child
    frame re-scanned with its refs prefixed ``f1e5`` under a one-line
    header.  Child frames scan with their OWN cap
    (:data:`SNAPSHOT_CHILD_FRAME_CAP`) -- an element-dense main page must
    not starve the embedded widget the aimed interaction needs.  The
    scan also refreshes the session's ref-name directory."""
    outlines: list[str] = [await page.evaluate(_SNAPSHOT_JS)]
    frames = _live_frames(page)
    child_lines = 0
    for idx, frame in enumerate(frames[:3], start=1):
        try:
            sub = await frame.evaluate(
                _SNAPSHOT_JS_TEMPLATE % SNAPSHOT_CHILD_FRAME_CAP
            )
        except Exception:  # pylint: disable=broad-exception-caught
            continue  # a frame that forbids evaluation (crashed, detached) reads as absent
        if not sub:
            continue
        host = urlsplit(frame.url).hostname or frame.url[:40]
        prefixed = "\n".join(
            f"f{idx}{line}" if line and not line.startswith("--") else line for line in sub.splitlines()
        )
        outlines.append(_SNAP_FRAME_HEADER.format(idx, host) + prefixed)
        child_lines += len(sub.splitlines())
        if child_lines >= SNAPSHOT_CHILD_FRAME_CAP[1] * 2:
            break
    outline = "\n".join(outlines)
    sess.names = _index_names(outline)
    return outline


async def _mark_ref_action(
    sess: "_Session", holder: "Page | object", sel: str, kind: str, ref: str, name: str | None = None
) -> None:
    """Best-effort ACTION MARK of one ref-targeted action: the element's
    bounding box + landing point ride the next mirror frame, and the
    takeover viewer sees WHICH element the action touched -- labeled by
    the element's OWN name from the snapshot directory (the machine ref
    only when the directory does not know it; an explicit ``name`` --
    the typed text, the chosen options -- outranks the lookup).  An unresolvable
    box (detached mid-race, zero-size) degrades to the point-only mark;
    the mark is a visibility aid, never action-critical.  The VERB is
    the client's (``pk`` + the i18n'd action key) -- the server ships
    the vocabulary, never the sentence."""
    try:
        loc = holder.locator(sel).first
        await loc.scroll_into_view_if_needed(timeout=1_500)
        box = await loc.bounding_box(timeout=1_500)
    except Exception:  # pylint: disable=broad-exception-caught
        box = None
    mark: dict[str, t.Any] = {"pk": kind, "name": name if name is not None else sess.names.get(ref) or ref}
    if box:
        mark.update(
            {
                "px": int(box["x"] + box["width"] / 2),
                "py": int(box["y"] + box["height"] / 2),
                "box": [int(box["x"]), int(box["y"]), int(box["width"]), int(box["height"])],
            }
        )
    sess.mark = mark


def click(session_id: str, ref: str) -> dict[str, t.Any]:
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page(sess)
            before = str(page.url)
            holder, sel = await _resolve_holder(page, ref)
            await _mark_ref_action(sess, holder, sel, "click", ref)
            await holder.click(sel, timeout=_ACTION_TIMEOUT_MS)
            return await _post_action_state(sess, page, before, 600)

        return _run(run())


def type_text(session_id: str, ref: str, text: str, submit: bool) -> dict[str, t.Any]:
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page(sess)
            before = str(page.url)
            holder, sel = await _resolve_holder(page, ref)
            await _mark_ref_action(sess, holder, sel, "type", ref, name=str(text)[:60])
            await holder.fill(sel, str(text), timeout=_ACTION_TIMEOUT_MS)
            if submit:
                await page.keyboard.press("Enter")
            return await _post_action_state(sess, page, before, 400)

        return _run(run())


def press_key(session_id: str, key: str) -> dict[str, t.Any]:
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page(sess)
            before = str(page.url)
            await page.keyboard.press(str(key))
            return await _post_action_state(sess, page, before, 300)

        return _run(run())


def scroll(session_id: str, direction: str) -> dict[str, str]:
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, str]:
            page = await _ensure_page(sess)
            await page.mouse.wheel(0, 600 if str(direction) == "down" else -600)
            await page.wait_for_timeout(400)
            return {"url": str(page.url), "title": await page.title()}

        return _run(run())


def _clamp_xy(x: t.Any, y: t.Any) -> tuple[int, int]:
    try:
        cx, cy = int(x), int(y)
    except (TypeError, ValueError):
        raise SessionError("viewport coordinates x/y must be integers") from None
    return max(0, cx), max(0, cy)


def click_xy(session_id: str, x: t.Any, y: t.Any) -> dict[str, t.Any]:
    """A viewport-coordinate click -- the primitive for widget interiors
    a ref cannot name (challenge tiles inside an iframe the snapshot
    reffed as one box, canvas hit-regions).  The mouse lands where the
    model aimed; humanize carries the trajectory."""
    cx, cy = _clamp_xy(x, y)
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page(sess)
            before = str(page.url)
            sess.mark = {"px": cx, "py": cy, "pk": "click"}
            await page.mouse.click(cx, cy, timeout=_ACTION_TIMEOUT_MS)
            return await _post_action_state(sess, page, before, 600)

        return _run(run())


def hover(session_id: str, ref: str) -> dict[str, t.Any]:
    """Hover one ref-targeted element -- hover-opened menus and tooltips
    are real UI the snapshot cannot see until the pointer rests there."""
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page(sess)
            before = str(page.url)
            holder, sel = await _resolve_holder(page, ref)
            await _mark_ref_action(sess, holder, sel, "hover", ref)
            await holder.locator(sel).first.hover(timeout=_ACTION_TIMEOUT_MS)
            return await _post_action_state(sess, page, before, 400)

        return _run(run())


def select_options(session_id: str, ref: str, values: list[str]) -> dict[str, t.Any]:
    """Select options on a native ``<select>`` (synthetic clicks never
    open the native picker): ``values`` are option value/label strings."""
    clean = [str(v or "").strip()[:200] for v in (values or [])][:6]
    clean = [v for v in clean if v]
    if not clean:
        raise SessionError("select needs at least one option value or label")
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page(sess)
            before = str(page.url)
            holder, sel = await _resolve_holder(page, ref)
            chosen = await holder.locator(sel).first.select_option(clean, timeout=_ACTION_TIMEOUT_MS)
            await _mark_ref_action(
                sess, holder, sel, "select", ref, name=", ".join(str(c) for c in chosen)[:80]
            )
            return {**(await _post_action_state(sess, page, before, 300)), "chosen": [str(c) for c in chosen]}

        return _run(run())


def drag(session_id: str, x1: t.Any, y1: t.Any, x2: t.Any, y2: t.Any, steps: int = 15) -> dict[str, t.Any]:
    """A mouse drag between two viewport points (down → interpolated
    moves → up): the slider-captcha primitive.  ``mouse.move``'s own
    interpolation plus the engine's humanized trajectories carry the
    human shape; the pointer tracks the landing point on the mirror."""
    ax, ay = _clamp_xy(x1, y1)
    bx, by = _clamp_xy(x2, y2)
    n = max(5, min(int(steps) if steps else 15, 40))
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page(sess)
            before = str(page.url)
            sess.mark = {"px": ax, "py": ay, "x2": bx, "y2": by, "pk": "drag"}
            await page.mouse.move(ax, ay)
            await page.mouse.down()
            await page.mouse.move(bx, by, steps=n)
            await page.wait_for_timeout(120)
            await page.mouse.up()
            return await _post_action_state(sess, page, before, 600)

        return _run(run())


def screenshot_b64(session_id: str, quality: int = 70) -> dict[str, t.Any]:
    """A viewport screenshot as ``{img, w, h, url, title}`` -- the visual
    branch's payload (injected to the model) and the mirror frame shape."""
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page(sess)
            raw = await page.screenshot(type="jpeg", quality=int(quality))
            vp = page.viewport_size or {"width": WINDOW[0], "height": WINDOW[1]}
            return {
                "img": base64.b64encode(raw).decode("ascii"),
                "w": int(vp["width"]),
                "h": int(vp["height"]),
                "url": str(page.url),
                "title": await page.title(),
            }

        return _run(run())


def inspect_b64(session_id: str, ref: str, quality: int = 75) -> dict[str, t.Any]:
    """ONE element as a close-up ``{img, w, h, url, title}`` -- the ref
    scoped screenshot the model aims at a widget a viewport shot only
    smears (captcha image, canvas, chart, an iframe's challenge grid).
    ``locator.screenshot`` scrolls the element into view itself; a stale
    ref fails fast through ``_resolve_holder`` with the re-snapshot
    recipe.  Read-only: no navigation check, no re-snapshot."""
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page(sess)
            holder, sel = await _resolve_holder(page, ref)
            raw = await holder.locator(sel).first.screenshot(
                type="jpeg", quality=int(quality), timeout=_ACTION_TIMEOUT_MS
            )
            box = await holder.locator(sel).first.bounding_box(timeout=1_500)
            return {
                "img": base64.b64encode(raw).decode("ascii"),
                "w": int(box["width"]) if box else 0,
                "h": int(box["height"]) if box else 0,
                "box": [int(box["x"]), int(box["y"]), int(box["width"]), int(box["height"])] if box else None,
                "url": str(page.url),
                "title": await page.title(),
            }

        return _run(run())


def region_b64(
    session_id: str, x: int, y: int, w: int, h: int, quality: int = 75
) -> dict[str, t.Any]:
    """A viewport RECTANGLE as a close-up ``{img, w, h, box, url, title}``
    -- the region crop the model aims by coordinates (the same viewport
    space its clicks use), for a page area no element wraps: a corner, a
    caption strip, a spread of widgets shot as one.  The region is
    intersected with the current viewport (the model aims on the viewport
    image it was shown); a region that collapses below 16px either way is
    a mis-aim and fails fast with the scroll recipe.  Read-only."""
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page(sess)
            vp = page.viewport_size or {"width": WINDOW[0], "height": WINDOW[1]}
            vx = max(0, min(int(x), int(vp["width"]) - 1))
            vy = max(0, min(int(y), int(vp["height"]) - 1))
            vw = max(0, min(int(w), int(vp["width"]) - vx))
            vh = max(0, min(int(h), int(vp["height"]) - vy))
            if vw < 16 or vh < 16:
                raise SessionError(
                    f"the region ({x},{y} {w}x{h}) is outside the viewport"
                    f" ({vp['width']}x{vp['height']}) -- scroll first, then"
                    " re-aim at the visible area"
                )
            off = await page.evaluate("() => [window.scrollX, window.scrollY]")
            raw = await page.screenshot(
                type="jpeg",
                quality=int(quality),
                clip={"x": vx + float(off[0]), "y": vy + float(off[1]), "width": vw, "height": vh},
                timeout=_ACTION_TIMEOUT_MS,
            )
            return {
                "img": base64.b64encode(raw).decode("ascii"),
                "w": vw,
                "h": vh,
                "box": [vx, vy, vw, vh],
                "url": str(page.url),
                "title": await page.title(),
            }

        return _run(run())


def set_mark(session_id: str, mark: dict[str, t.Any]) -> None:
    """The ACTION layer's mark (the capture primitives stay pure -- they
    serve mirror frames too, and a frame capture must never overwrite the
    action's mark)."""
    get(session_id).mark = mark


def frame(session_id: str = LEAD) -> dict[str, t.Any]:
    """The mirror frame: the viewport capture at mirror quality wearing
    the ref annotation overlay (browser-use's visual -- every scanned
    element's dashed outline + ref badge, injected for THIS capture and
    removed after: the model's own screenshots stay clean and the page
    is untouched between frames), PLUS the action mark when one has been
    tracked -- px/py viewport space, pk the action kind, name the
    touched element's own name (the client draws the cursor, its click
    ripple and the i18n'd intent label)."""
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page(sess)
            frames: list[t.Any] = []
            try:
                marked = int(await page.evaluate(_ANNOTATE_JS))
                for frame in _live_frames(page)[:3]:
                    try:
                        if await frame.evaluate(_ANNOTATE_JS):
                            frames.append(frame)
                    except Exception:  # pylint: disable=broad-exception-caught
                        continue  # a frame that forbids evaluation reads as bare
                if marked:
                    # one paint cycle: the overlay's fixed-position divs
                    # must reach the compositor before the bytes land
                    await page.wait_for_timeout(60)
                raw = await page.screenshot(type="jpeg", quality=55)
            finally:
                try:
                    await page.evaluate(_ANNOTATE_REMOVE_JS)
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
                for frame in frames:
                    try:
                        await frame.evaluate(_ANNOTATE_REMOVE_JS)
                    except Exception:  # pylint: disable=broad-exception-caught
                        pass
            vp = page.viewport_size or {"width": WINDOW[0], "height": WINDOW[1]}
            return {
                "img": base64.b64encode(raw).decode("ascii"),
                "w": int(vp["width"]),
                "h": int(vp["height"]),
                "url": str(page.url),
                "title": await page.title(),
            }

        out = _run(run())
    mark = sess.mark
    if mark:
        out.update(mark)
    return out


def extract(session_id: str, max_chars: int | None) -> dict[str, str]:
    """The CURRENT page condensed to reading material (title + markdown)
    -- the reader's extraction pipeline over the live DOM."""
    # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.browser.extract import (  # pylint: disable=import-outside-toplevel
        PageReadError,
        extract_page,
    )

    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, str]:
            page = await _ensure_page(sess)
            return {"url": str(page.url), "title": await page.title(), "html": await page.content()}

        page_state = _run(run())
    try:
        title, text = extract_page(page_state["html"], page_state["url"], max_chars)
    except PageReadError as exc:
        raise SessionError(str(exc)) from exc
    return {"url": page_state["url"], "title": title, "text": text}


def _tab_view(pages: "list[Page]", active: int) -> list[dict[str, t.Any]]:
    """The tab strip's wire shape: index + url + title + the active mark
    (closed pages skipped -- a crashed tab reads as absent)."""
    out = []
    for idx, page in enumerate(pages):
        if page.is_closed():
            continue
        out.append(
            {
                "index": idx,
                "url": str(page.url),
                "title": "",
                "active": idx == active,
            }
        )
    return out


async def _tab_titles(pages: "list[Page]", views: list[dict[str, t.Any]]) -> None:
    """Fill the views' titles best-effort (a page's title() is ASYNC and
    can throw on a torn-down document; the url line stands alone)."""
    for view in views:
        try:
            view["title"] = (await pages[view["index"]].title())[:120]
        except Exception:  # pylint: disable=broad-exception-caught
            pass


def _register_tab(sess: _Session, page: "Page") -> None:
    """One new page joins the tab set and takes the active slot (the
    gate's visual-page registry rides along, the replaced page's entry
    dropped)."""
    if sess.page is not None:
        gate.visual_pages.pop(id(sess.page), None)
    gate.visual_pages[id(page)] = page
    sess.pages = [pg for pg in sess.pages if not pg.is_closed()]
    sess.pages.append(page)
    sess.active = len(sess.pages) - 1
    sess.page = page


def tab_new(session_id: str, url: str) -> dict[str, t.Any]:
    """Open one NEW tab and make it active (the URL is the service's
    gate- checked public http(s) one): goto, settle, fresh outline --
    the model lands reading the new page, the old tab sleeps beside it."""
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            context = await _context()
            page = await context.new_page()
            await page.set_viewport_size({"width": WINDOW[0], "height": WINDOW[1]})
            try:
                await page.goto(url, wait_until="load", timeout=browser_config.goto_timeout_ms())
            except Exception as exc:  # pylint: disable=broad-except
                await page.close()
                raise SessionError(f"could not open the page ({_brief(exc)})") from exc
            await _settle_page(page)
            _register_tab(sess, page)
            outline = await _snapshot_page(sess, page)
            return {"url": str(page.url), "title": await page.title(), "snapshot": outline}

        return _run(run())


def tab_switch(session_id: str, index: t.Any) -> dict[str, t.Any]:
    """Activate one existing tab: the page's own outline rides back (refs
    are PER-PAGE -- the model must re-read the vocabulary before it
    acts), the previous tab sleeps untouched."""
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            try:
                idx = int(index)
            except (TypeError, ValueError):
                raise SessionError("tab switch needs an integer index (see tab list)") from None
            sess.pages = [pg for pg in sess.pages if not pg.is_closed()]
            if idx < 0 or idx >= len(sess.pages):
                raise SessionError(f"tab {idx} does not exist -- call tab with op=list for the strip")
            if sess.page is not None:
                gate.visual_pages.pop(id(sess.page), None)
            sess.active = idx
            sess.page = sess.pages[idx]
            gate.visual_pages[id(sess.page)] = sess.page
            outline = await _snapshot_page(sess, sess.page)
            return {"index": idx, "url": str(sess.page.url), "title": await sess.page.title(), "snapshot": outline}

        return _run(run())


def tab_close(session_id: str, index: t.Any) -> dict[str, t.Any]:
    """Close one tab: a closed ACTIVE tab activates its neighbour (the
    last one closes the session's pages entirely -- the next action
    opens fresh).  Closing a background tab leaves the active page
    alone."""
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            try:
                idx = int(index)
            except (TypeError, ValueError):
                raise SessionError("tab close needs an integer index (see tab list)") from None
            sess.pages = [pg for pg in sess.pages if not pg.is_closed()]
            if idx < 0 or idx >= len(sess.pages):
                raise SessionError(f"tab {idx} does not exist -- call tab with op=list for the strip")
            dying = sess.pages.pop(idx)
            gate.visual_pages.pop(id(dying), None)
            if not dying.is_closed():
                await dying.close()
            if sess.page is dying or not sess.pages:
                sess.page = sess.pages[min(idx, len(sess.pages) - 1)] if sess.pages else None
                sess.active = min(idx, len(sess.pages) - 1) if sess.pages else 0
            views = _tab_view(sess.pages, sess.active)
            await _tab_titles(sess.pages, views)
            return {"closed": idx, "tabs": views}

        return _run(run())


def tab_list(session_id: str) -> dict[str, t.Any]:
    """The tab strip: index / url / title / active mark per live tab."""
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            sess.pages = [pg for pg in sess.pages if not pg.is_closed()]
            if sess.page is not None and sess.page not in sess.pages:
                sess.pages.append(sess.page)
            views = _tab_view(sess.pages, sess.active)
            await _tab_titles(sess.pages, views)
            return {"tabs": views}

        return _run(run())


def scroll_to_text(session_id: str, text: str) -> dict[str, t.Any]:
    """Scroll the FIRST page region matching ``text`` into view -- the
    targeted alternative to the blind wheel (a section heading, a form
    legend, a result far down).  The element's box rides the action mark
    (the mirror shows WHAT was scrolled to), the outline is untouched
    (refs survive a scroll)."""
    clean = str(text or "").strip()[:200]
    if not clean:
        raise SessionError("scroll needs text to scroll to")
    sess = get(session_id)
    with sess.lock:

        async def run() -> dict[str, t.Any]:
            page = await _ensure_page(sess)
            loc = page.get_by_text(clean, exact=False).first
            try:
                await loc.scroll_into_view_if_needed(timeout=_ACTION_TIMEOUT_MS)
                box = await loc.bounding_box(timeout=1_500)
            except Exception as exc:  # pylint: disable=broad-exception-caught
                raise SessionError(
                    f"no visible text matching {clean[:60]!r} on this page ({_brief(exc)}) --"
                    " scroll blind or snapshot first"
                ) from exc
            if box:
                sess.mark = {
                    "px": int(box["x"] + box["width"] / 2),
                    "py": int(box["y"] + box["height"] / 2),
                    "pk": "scroll",
                    "name": clean[:60],
                    "box": [int(box["x"]), int(box["y"]), int(box["width"]), int(box["height"])],
                }
            await page.wait_for_timeout(300)
            return {"url": str(page.url), "title": await page.title()}

        return _run(run())


def close_page(session_id: str = LEAD) -> None:
    """Close the session page and FORGET the session (the persistent
    context and its cookies stay; a new action on the same id opens a
    fresh page).  The lead's lane persists across runs by usage; sub
    sessions call this when their loop ends."""
    close(session_id)


def session_input(
    # pylint: disable=invalid-name
    session_id: str,
    kind: str,
    x: int = 0,
    y: int = 0,
    delta_y: int = 0,
    text: str = "",
    key: str = "",
    x2: int = 0,
    y2: int = 0,
) -> None:
    """The Lightbox takeover's forwarded input, in viewport space."""
    sess = get(session_id)
    with sess.lock:

        async def run() -> None:
            page = await _ensure_page(sess)
            if kind == "click":
                await page.mouse.click(int(x), int(y))
            elif kind == "drag":
                # the human's slide: down at (x,y), interpolated moves to
                # (x2,y2), up -- the same primitive the model's drag rides
                await page.mouse.move(int(x), int(y))
                await page.mouse.down()
                await page.mouse.move(int(x2), int(y2), steps=15)
                await page.wait_for_timeout(120)
                await page.mouse.up()
            elif kind == "wheel":
                await page.mouse.wheel(0, int(delta_y))
            elif kind == "type":
                await page.keyboard.type(str(text))
            elif kind == "key":
                await page.keyboard.press(str(key))
            elif kind in ("back", "forward", "reload"):
                # the takeover's chrome actions: the user navigates the
                # shared page -- the SSRF gate already guards anything the
                # fresh page loads, same as the model's own navigations
                if kind == "back":
                    await page.go_back(timeout=_ACTION_TIMEOUT_MS)
                elif kind == "forward":
                    await page.go_forward(timeout=_ACTION_TIMEOUT_MS)
                else:
                    await page.reload(timeout=_ACTION_TIMEOUT_MS)
                # a wholesale page change: the settle treatment so the
                # frame the input route returns shows the SETTLED page
                await _settle_page(page)
            else:
                raise SessionError(f"unknown input kind: {kind!r}")

        _run(run())
