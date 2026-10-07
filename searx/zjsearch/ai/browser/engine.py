# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The built-in render engine: ONE Camoufox (anti-detect Firefox) in a
PERSISTENT context, shared by every read.

Camoufox is the engine choice, not a styling preference: its patches
live at the C++ level (coherent fingerprint generation, no CDP at all
-- Firefox speaks Juggler), which is the strongest open position
against the bot walls the reader is FOR (the JS-heavy, login-walled
pages a plain HTTP fetch cannot see).  Launch is lazy (the first read
pays it, the process keeps the browser warm) and the context is
persistent (``config.profile_dir``) because the cookie store is the
point: the login stages will persist sessions across runs exactly like
the user's own browser does.  uBlock Origin rides along as a default
addon (``config.adblock``) -- ads never load, so their DOM noise never
reaches the extraction -- and WebRTC is blocked at launch, closing the
one leak no request gate could see.

Concurrency model: the reader's callers run on worker threads while
the browser lives on searx's shared network loop -- every step
dispatches through ``run_coroutine_threadsafe`` (the mcp tool's bridge
pattern) and the browser-side state is touched from loop tasks only.
A semaphore caps concurrent pages (``config.max_pages``); each read
opens, settles and closes its own page.  The engine renders and
extracts, nothing more: what the page MEANS (a sign-in wall, a captcha
greeting the reader) is the model's judgment on the returned content --
the reader has no opinions about content quality.
"""

import asyncio
import atexit
import concurrent.futures
import logging
import os
import subprocess
import time
import typing as t

from searx.network.client import get_loop
from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.browser import gate

if t.TYPE_CHECKING:
    from playwright.async_api import BrowserContext

logger = logging.getLogger(__name__)

READ_TIMEOUT = 90.0
"""One read's whole wall clock on the sync bridge -- goto budget plus
network-quiet wait plus settle plus the ``page.content()`` serialization
of a large DOM."""

WINDOW = (1280, 800)
"""The fixed desktop-shaped window, spoofed Camoufox-side (its ``window``
option -- NOT a playwright ``viewport``, which deadlocks Juggler when
the window is spoofed to a different size).  The reader extracts DOM
text, but a realistic geometry keeps responsive layouts on their
desktop branch (and the observe stage will mirror exactly this frame)."""

_NETWORK_IDLE_MS = 3_500
"""The network-quiet wait AFTER ``load`` -- late XHR hydration gets its
moment; chatty pages (analytics, sockets) never go idle and hit this
budget instead, which is what it is for."""

_CODE_OWNED_KEYS = frozenset(
    {
        "persistent_context",
        "user_data_dir",
        "headless",
        "os",
        "block_webrtc",
        "humanize",
        "proxy",
        "geoip",
        "exclude_addons",
    }
)
"""The launch keys ``zjsearch.browser.params`` may NOT override: the
identity pins, the keys with their own semantic config knob (``proxy``/
``geoip`` -- the paired network block; ``exclude_addons`` -- the adblock
switch; ``headless`` -- the mode tiers), and the engine's runtime
shape.  A params key for one warns once and is dropped."""

_PARAMS_OVERRIDE_WARNED = False

_state: dict[str, t.Any] = {}
"""Loop-side engine state: ``{"context": BrowserContext}`` after a
successful launch.  Every access happens inside a task on the shared
loop -- there is nothing for the worker threads to lock."""


def _merge_params(launch_kwargs: dict[str, t.Any]) -> None:
    """``zjsearch.browser.params`` merged LAST over the code-built launch
    fields (the openai-transport ``params`` pattern): the deployment's
    own camoufox ``launch_options`` kwargs -- ``locale``, ``addons``,
    ``webgl_config``, ``firefox_user_prefs``, ``screen``, ... -- win over
    everything except the code-owned identity/security keys."""
    global _PARAMS_OVERRIDE_WARNED  # pylint: disable=global-statement
    params = browser_config.params()
    dropped = sorted(_CODE_OWNED_KEYS & params.keys())
    if dropped and not _PARAMS_OVERRIDE_WARNED:
        _PARAMS_OVERRIDE_WARNED = True
        logger.warning(
            "zjsearch.browser.params tries to override code-owned launch"
            " key(s) %s -- dropped (these pins keep the claimed identity"
            " coherent); reconcile the settings block",
            dropped,
        )
    launch_kwargs.update({k: v for k, v in params.items() if k not in _CODE_OWNED_KEYS})


def _kill_stale_holders(profile: str) -> None:
    """One launch-failure self-heal: a previous instance's browser may
    still live and hold the persistent profile's lock (a hard worker
    exit skips the atexit close -- granian's workers do).  Kill the
    camoufox processes whose command line carries THIS profile path --
    scoped to the exact directory, nothing else -- and give the OS a
    moment.  Best effort on every platform (no pkill = the error hint
    stands).  Runs OFF the shared loop (the caller awaits it in a
    thread): the pkill + settle would otherwise freeze every other
    network caller for ~2s."""
    try:
        subprocess.run(["pkill", "-f", f"camoufox.*{profile}"], check=False, timeout=5)  # noqa: S603, S607
        time.sleep(1.0)
    except Exception:  # pylint: disable=broad-except
        pass


async def _kill_stale_holders_async(profile: str) -> None:
    await asyncio.to_thread(_kill_stale_holders, profile)


async def _launch() -> "BrowserContext":
    from camoufox.addons import DefaultAddons  # pylint: disable=import-outside-toplevel
    from camoufox.async_api import AsyncNewBrowser  # pylint: disable=import-outside-toplevel
    from playwright.async_api import async_playwright  # pylint: disable=import-outside-toplevel

    pw = await async_playwright().start()
    profile = browser_config.profile_dir()
    try:
        os.makedirs(profile, exist_ok=True)
    except OSError as exc:
        raise browser_config.RenderError(
            f"the built-in browser's profile directory is unusable: {profile} ({exc})"
        ) from exc
    launch_kwargs: dict[str, t.Any] = {
        "persistent_context": True,
        "user_data_dir": profile,
        "headless": {"headed": False, "virtual": "virtual"}.get(browser_config.mode(), True),
        "window": WINDOW,
        "block_webrtc": True,
        # humanized cursor trajectories for every playwright click/scroll --
        # inert for the reader's pure reads, load-bearing the moment the
        # login stage starts touching pages
        "humanize": True,
    }
    if browser_config.proxy() is not None:
        launch_kwargs["proxy"] = browser_config.proxy()
        if browser_config.geoip():
            # the fingerprint must agree with the proxy exit's locale,
            # timezone and geolocation -- camoufox warns about exactly
            # this leak when a proxy rides without geoip
            launch_kwargs["geoip"] = True
    if not browser_config.adblock():
        launch_kwargs["exclude_addons"] = [DefaultAddons.UBO]
    _merge_params(launch_kwargs)
    try:
        context = await AsyncNewBrowser(pw, **launch_kwargs)
    except Exception as exc:  # pylint: disable=broad-except
        retried = False
        if "failed to launch" in str(exc).lower():
            # the classic cause after an unclean restart: the previous
            # instance's browser process still lives and holds the
            # persistent profile's lock -- clean it and retry ONCE
            await _kill_stale_holders_async(profile)
            try:
                context = await AsyncNewBrowser(pw, **launch_kwargs)
                retried = True
                logger.warning(
                    "zjsearch browser: a stale process held the profile lock and was"
                    " killed -- the launch retry succeeded (profile %s)",
                    profile,
                )
            except Exception as exc2:  # pylint: disable=broad-except
                exc = exc2
        if not retried:
            raise browser_config.RenderError(
                f"the built-in browser could not launch ({_brief(exc)}) --"
                " install it with `python -m searx.zjsearch.ai.browser.install`;"
                " a previous instance's browser process may also still hold the"
                " profile lock -- stop it (pkill -f Camoufox) or point"
                " zjsearch.browser.profile elsewhere"
            ) from exc
    await context.route("**/*", gate.gate)
    _register_shutdown()
    logger.info(
        "zjsearch browser: launched (camoufox, %s, adblock %s, profile %s)",
        browser_config.mode(),
        browser_config.adblock(),
        profile,
    )
    return context


_SHUTDOWN_REGISTERED = False


def _register_shutdown() -> None:
    """The atexit hook (registered once, at the first successful launch):
    close the persistent context so the camoufox process never outlives
    the server -- an orphaned browser locks the profile and every later
    launch fails until someone kills it by hand."""
    global _SHUTDOWN_REGISTERED  # pylint: disable=global-statement
    if _SHUTDOWN_REGISTERED:
        return
    _SHUTDOWN_REGISTERED = True

    def _shutdown() -> None:
        context = _state.get("context")
        if context is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(context.close(), get_loop()).result(timeout=5)
            logger.info("zjsearch browser: closed at shutdown")
        except Exception:  # pylint: disable=broad-except
            logger.warning("zjsearch browser: the shutdown close failed -- the process may linger")

    atexit.register(_shutdown)


async def _context() -> "BrowserContext":
    context = _state.get("context")
    if context is None:
        context = await _launch()
        _state["context"] = context
    return context


def drop_context() -> None:
    """Forget the cached context (the browser died mid-run): the next
    read or session action relaunches instead of failing forever with
    the same "closed" error.  Safe from any thread (dict pop)."""
    _state.pop("context", None)


def _brief(exc: BaseException) -> str:
    return " ".join(str(exc).split())[:200] or type(exc).__name__


async def _read_on(context: "BrowserContext", url: str) -> str:
    semaphore = _state.get("pages")
    if semaphore is None:
        semaphore = asyncio.Semaphore(browser_config.max_pages())
        _state["pages"] = semaphore
    async with semaphore:
        page = await context.new_page()
        try:
            try:
                await page.goto(url, wait_until="load", timeout=browser_config.goto_timeout_ms())
            except Exception as exc:  # pylint: disable=broad-except
                raise browser_config.RenderError(
                    f"the built-in browser could not open this page ({_brief(exc)})"
                ) from exc
            try:
                await page.wait_for_load_state("networkidle", timeout=_NETWORK_IDLE_MS)
            except Exception:  # pylint: disable=broad-except
                pass  # chatty pages never go quiet -- the fixed settle still applies
            await page.wait_for_timeout(browser_config.settle_ms())
            html = await page.content()
        finally:
            await page.close()
    if not html.strip():
        raise browser_config.RenderError("the built-in browser rendered an empty page")
    return html


async def _read(url: str) -> str:
    try:
        return await _read_on(await _context(), url)
    except browser_config.RenderError:
        raise
    except Exception as exc:  # pylint: disable=broad-except
        if "closed" in str(exc).lower():
            # the browser died mid-run (crash, OOM kill): a poisoned
            # context would fail every later read with the same cryptic
            # line -- drop it so the next read relaunches
            _state.pop("context", None)
        raise browser_config.RenderError(f"the built-in browser failed: {type(exc).__name__}: {_brief(exc)}") from exc


def read_html(url: str) -> str:
    """The rendered HTML of one public URL through the built-in browser
    -- the exact seam the reader extracts from (``web_reader``).  The
    caller runs on a worker thread."""
    future = asyncio.run_coroutine_threadsafe(_read(url), get_loop())
    try:
        return future.result(timeout=READ_TIMEOUT)
    except concurrent.futures.TimeoutError as exc:
        # the wall clock died waiting: cancel the coroutine so a hung
        # page cannot leak on the shared loop
        future.cancel()
        raise browser_config.RenderError("the built-in browser timed out reading this page") from exc
    except browser_config.RenderError:
        raise
    except Exception as exc:  # pylint: disable=broad-except
        raise browser_config.RenderError(f"the built-in browser failed: {type(exc).__name__}: {_brief(exc)}") from exc
