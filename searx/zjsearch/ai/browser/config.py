# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Built-in browser configuration: the ``zjsearch.browser`` settings
block, the availability gate and the shared error type.

The block is OPT-IN (``enabled: true``): the engine is a heavyweight
facility -- a Camoufox (anti-detect Firefox) process, a persistent
profile directory holding the cookie store -- and a deployment must
choose it deliberately.  Off means the page reader has no render
backend and the ``web_reader`` tool never registers.  Like every
zjsearch block, settings live in the deployment's own file; the
code-side fallbacks below are the whole default.
"""

import logging
import os
import typing as t

from searx.zjsearch.ai.core import config as core_config

logger = logging.getLogger(__name__)


class RenderError(Exception):
    """A page could not be rendered -- the message travels to the model
    (``tools.web_reader`` wraps it into its ``PageReadError``; the
    wording is written for the model either way)."""


def cfg() -> dict[str, t.Any]:
    """The ``zjsearch.browser`` settings block (absent unless the
    deployment defines it) -- the built-in engine, a sibling of
    ``zjsearch.reader``."""
    return core_config.zj_block("browser")


def enabled() -> bool:
    """``zjsearch.browser.enabled`` -- True only when explicitly turned
    on; there is no code-side default-on."""
    return cfg().get("enabled") is True


def mode() -> str:
    """``zjsearch.browser.mode`` -- the three display tiers, strongest
    anti-detection first where each is available:

    - ``headed``: a REAL window on the host's display -- the strongest
      tier (real compositor, GPU, focus semantics) and, on a desktop
      deployment, the surface the user can watch and reach into (the
      login stage's interaction carrier).  Needs a display session.
    - ``virtual``: camoufox's Xvfb mode for display-less LINUX servers
      (``headless="virtual"``) -- full fingerprint spoofing with a
      virtual framebuffer; needs the SYSTEM Xvfb binary on PATH
      (Debian: ``apt-get install xvfb``), nothing pip-side.
    - ``headless`` (default): plain headless, works everywhere; the
      reader's pure-read stage is fully served by it."""
    value = str(cfg().get("mode") or "headless").strip().lower()
    return value if value in ("headless", "headed", "virtual") else "headless"


def profile_dir() -> str:
    """The persistent profile directory (``zjsearch.browser.profile``) --
    the cookie store the login stages will depend on.  Default
    ``~/.cache/zjsearch-browser``: writable on every platform, never
    inside the repository; a Docker deployment points this into its data
    volume so logins survive container recreation."""
    value = str(cfg().get("profile") or "").strip()
    if value:
        return os.path.abspath(os.path.expanduser(value))
    return os.path.join(os.path.expanduser("~"), ".cache", "zjsearch-browser")


def proxy() -> dict[str, t.Any] | None:
    """``zjsearch.browser.proxy`` -- the browser's own proxy, passed
    through to Camoufox in the standard ``{server, bypass, username,
    password}`` shape.  Firefox does NOT
    inherit the shell's proxy environment, so a deployment that reaches
    the web only through a proxy must name it here (the engine fetches
    pages with the browser, not with searx's network client)."""
    raw = cfg().get("proxy")
    return raw if isinstance(raw, dict) and raw else None


def adblock() -> bool:
    """``zjsearch.browser.adblock`` -- default ON: Camoufox ships uBlock
    Origin as a default addon and this keeps it attached (network +
    cosmetic filtering -- ads never load, so their DOM noise never
    reaches the extraction).  ``false`` excludes the addon entirely: the
    offline audit sets this, whose first launch would otherwise try an
    addons.mozilla.org download.  The download itself fails open -- a
    failed fetch only logs, and the next online launch retries."""
    return cfg().get("adblock") is not False


def geoip() -> bool:
    """``zjsearch.browser.geoip`` -- align the fingerprint's locale,
    timezone and geolocation with the proxy EXIT's real location
    (camoufox itself warns loudly that a proxied browser without geoip
    leaks the mismatch).  Default OFF: the alignment costs one IP
    lookup per launch and needs the ``camoufox[geoip]`` extra; any
    deployment that sets ``proxy`` should set this too."""
    return cfg().get("geoip") is True


def params() -> dict[str, t.Any]:
    """``zjsearch.browser.params`` -- pass-through 1:1 into the camoufox
    launch (its own ``launch_options`` kwargs: ``locale``, ``addons``,
    ``webgl_config``, ``firefox_user_prefs``, ``screen``, ``enable_cache``,
    ...), merged over the code-built fields LAST like the openai-transport
    ``params`` pattern.  The identity/security keys are CODE-OWNED and a
    params key for one warns once and is dropped (``os``/``block_webrtc``/
    ``humanize`` -- the coherent-identity pins; ``persistent_context``/
    ``user_data_dir``/``headless`` -- the engine's runtime shape;
    ``proxy``/``geoip``/``args``/``exclude_addons`` -- each has its own
    config key already)."""
    raw = cfg().get("params")
    return raw if isinstance(raw, dict) else {}


def max_pages() -> int:
    """Concurrent page cap (``zjsearch.browser.max_pages``, 1-4): reads
    run on the reader's worker pool, the browser serializes them through
    this semaphore so a six-call round cannot open six tabs."""
    value = cfg().get("max_pages")
    if value is None:
        return 2
    try:
        return max(1, min(int(value), 4))
    except (TypeError, ValueError):
        return 2


def goto_timeout_ms() -> int:
    """``zjsearch.browser.goto_timeout_ms`` -- one navigation's budget,
    clamped to sane bounds."""
    value = cfg().get("goto_timeout_ms")
    if value is None:
        return 30_000
    try:
        return max(5_000, min(int(value), 60_000))
    except (TypeError, ValueError):
        return 30_000


def settle_ms() -> int:
    """``zjsearch.browser.settle_ms`` -- the fixed post-load wait for
    late hydration."""
    value = cfg().get("settle_ms")
    if value is None:
        return 1_200
    try:
        return max(0, min(int(value), 5_000))
    except (TypeError, ValueError):
        return 1_200


def allow_hosts() -> frozenset[str]:
    """``zjsearch.browser.allow_hosts`` -- hosts the gates let through
    DESPITE failing the public-address checks: the deployment's intranet
    targets, the audit's loopback fixtures.  Entries are hostnames or
    literal IPs, matched exactly (lowercased, trailing dot stripped;
    ports never appear).  BOTH gates honor the list -- the reader's
    string-level ``guard_url`` AND the request gate inside the browser --
    so an allowed host is reachable end to end or not at all."""
    raw = cfg().get("allow_hosts")
    if not isinstance(raw, (list, tuple)):
        return frozenset()
    return frozenset(str(item).strip().lower().rstrip(".") for item in raw if str(item).strip())


def engine_missing() -> str | None:
    """The missing-package name for the install gate (the mcp tool's
    ``sdk_missing`` pattern), or ``None`` when ``camoufox`` imports."""
    try:
        import camoufox.async_api  # noqa: F401  pylint: disable=unused-import,import-outside-toplevel

        return None
    except ImportError:
        return "camoufox"


_FALLBACK_WARNED = False
"""One-time flag: the engine is enabled but its package is missing --
the reader would simply never register and the misconfiguration would
never surface."""


def ready() -> bool:
    """True when reads may take the built-in engine: enabled AND the
    ``camoufox`` package imports.  Enabled-but-missing warns once and
    answers False -- the ``web_reader`` tool never registers (an absent
    engine disables the reader, it does not error every read)."""
    global _FALLBACK_WARNED  # pylint: disable=global-statement
    if not enabled():
        return False
    if engine_missing() is None:
        return True
    if not _FALLBACK_WARNED:
        _FALLBACK_WARNED = True
        logger.warning(
            "zjsearch.browser is enabled but the camoufox package is missing"
            " -- run `python -m searx.zjsearch.ai.browser.install`; the"
            " web_reader tool stays unregistered"
        )
    return False
