# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Build-time installer for the built-in browser's Camoufox build.

The ``camoufox`` PACKAGE is an ordinary requirements.txt dependency;
this module downloads the BROWSER it drives (the anti-detect Firefox
build, ~1.3 GB compressed / ~2.4 GB extracted).  One entry, two audiences:

- dev workstation::

      ./local/py3/bin/python -m searx.zjsearch.ai.browser.install

- Docker image build -- run the same module in the BUILDER stage with
  ``XDG_CACHE_HOME`` pinned (Camoufox installs into
  ``$XDG_CACHE_HOME/camoufox``); the theme's own recipe is
  ``client/zjsearch/Dockerfile`` (installer + font-group trimmer in
  one build stage, the runtime library set in the dist stage).

``$XDG_CACHE_HOME`` decides WHERE the bundle lands; whatever is set at
install time must be set at run time too.  The CHANNEL pin is written
in-process, together with camoufox's own 0.5-compat marker: the CLI
``camoufox fetch`` entry rmtree's a flag-less install dir ("Cleaning
old data...", the config.json holding the pin included) before it
resolves anything -- without the marker the pin silently reverts to
the package-paired build.  The fetch itself stays on the CLI (sync,
channel bounds and cache resolution are upstream machinery).  After
the browser lands, the LAUNCH-TIME
downloads are prefetched into the same cache -- the fingerprint
generator's model, the GeoIP databases and uBlock Origin (the default
adblock addon) -- so the browser's first launch needs none of them on
the network.  Every prefetch is fail-open (a deployment without them
works once online; the GeoIP db additionally ages on camoufox's own
re-check schedule, so the prefetch buys freshness, not permanent
independence).
"""

import os
import subprocess
import sys

CHANNEL = "official/prerelease"
"""The install tracks this camoufox channel: releases move fast and stale
builds carry fixed bugs, so the channel is pinned in-process before the
resolution and the fetch installs the channel's LATEST (the CLI's own
spelling is `camoufox set official/prerelease`; the conservative train
would be official/stable).  Without the pin, the package's PAIRED build
(the one this camoufox release was tested against) is installed instead."""


def main() -> int:
    from searx.zjsearch.ai.browser.config import engine_missing  # pylint: disable=import-outside-toplevel

    missing = engine_missing()
    if missing is not None:
        print(f"error: the {missing} package is not installed in this environment", file=sys.stderr)
        print("       (pip install camoufox)", file=sys.stderr)
        return 1
    target = os.environ.get("XDG_CACHE_HOME")
    if target:
        print(f"zjsearch browser: downloading the Camoufox build into {target}/camoufox")
        print("(keep XDG_CACHE_HOME set at run time to the same path)")
    else:
        print("zjsearch browser: downloading the Camoufox build into the")
        print("user cache (set XDG_CACHE_HOME to relocate)")
    from camoufox.multiversion import (  # pylint: disable=import-outside-toplevel
        COMPAT_FLAG,
        load_config,
        save_config,
    )
    from camoufox.pkgman import INSTALL_DIR  # pylint: disable=import-outside-toplevel

    # the CHANNEL pin lives IN-PROCESS, written BEFORE the CLI fetch: the
    # fetch entry rmtree's a flag-less INSTALL_DIR ("Cleaning old
    # data...", the config.json holding the pin included) and silently
    # reverts to the package-paired build.  The 0.5-compat marker (this
    # dir's data is already 0.5-shaped: a config file) defuses that wipe.
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    cfg = load_config()
    cfg["channel"] = CHANNEL
    cfg.pop("pinned", None)
    cfg.pop("pinned_sha", None)
    save_config(cfg)
    COMPAT_FLAG.touch()

    # the fetch stays on the CLI (sync + channel bounds + cache
    # resolution are upstream machinery); the prerelease channel's
    # latest triggers an interactive confirm -- a non-interactive
    # install answers it through stdin (stable builds never read it)
    result = subprocess.run(
        [sys.executable, "-m", "camoufox", "fetch", *sys.argv[1:]],
        input='y\n',
        text=True,
        check=False,
    ).returncode
    if result != 0:
        return result
    try:
        from camoufox.pkgman import installed_verstr  # pylint: disable=import-outside-toplevel

        print(f"zjsearch browser: installed {installed_verstr()}")
    except Exception as exc:  # pylint: disable=broad-except
        print(
            f"error: no browser bundle is active after the fetch ({exc}) --"
            " rerun the install",
            file=sys.stderr,
        )
        return 1
    _prefetch_fingerprint_model()
    _prefetch_launch_payloads()
    return 0


def _prefetch_fingerprint_model() -> None:
    """The fingerprint GENERATOR's model is a separate one-time download
    (a scrapfly/fingerprint-generator release on github) that camoufox
    otherwise fetches on the browser's FIRST launch -- a firewalled
    deployment would fail its first read with a timeout.  Pull it here,
    while the build/dev network is expected to work; a failure only
    warns (the first online launch retries it)."""
    try:
        from camoufox.fpgen_model import ensure_fpgen_model  # pylint: disable=import-outside-toplevel

        ensure_fpgen_model()
    except Exception as exc:  # pylint: disable=broad-except
        print(
            f"warning: the fingerprint model pre-fetch failed ({exc});" " the browser's first launch retries it",
            file=sys.stderr,
        )
        return
    print("zjsearch browser: fingerprint model in place (first launch needs no network)")


def _prefetch_launch_payloads() -> None:
    """The launch-time downloads beyond the browser itself: the GeoIP
    databases (read whenever a proxy ride turns ``geoip`` on -- the
    default ``download_mmdb()`` source IS the launch path's source) and
    uBlock Origin (the default adblock addon; camoufox skips a cached
    copy on the manifest check).  camoufox's own fetch command ends by
    provisioning BOTH (0.5.8: ``download_mmdb`` + addons + the fpgen
    model after the browser lands), so this is the FALLBACK leg:
    ``download_mmdb`` has no freshness check (it always re-downloads),
    the geoip call gates on ``needs_update()`` -- fresh-from-fetch costs
    nothing here, a missing/stale database still prefetches.  Fail-open
    like the fingerprint model above: a deployment whose prefetch failed
    works once online."""
    try:
        from camoufox.geolocation import download_mmdb, needs_update  # pylint: disable=import-outside-toplevel

        if needs_update():
            download_mmdb()
            print("zjsearch browser: geoip databases in place")
        else:
            print("zjsearch browser: geoip databases already fresh (fetched with the browser)")
    except Exception as exc:  # pylint: disable=broad-except
        print(
            f"warning: the geoip prefetch failed ({exc}); first launch with a proxy fetches them",
            file=sys.stderr,
        )
    try:
        from camoufox.addons import DefaultAddons, maybe_download_addons  # pylint: disable=import-outside-toplevel

        maybe_download_addons([DefaultAddons.UBO])
        print("zjsearch browser: ublock origin in place")
    except Exception as exc:  # pylint: disable=broad-except
        print(
            f"warning: the ublock origin prefetch failed ({exc}); first launch fetches it",
            file=sys.stderr,
        )


if __name__ == "__main__":
    sys.exit(main())
