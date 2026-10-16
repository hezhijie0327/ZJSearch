# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Build-time installer for the built-in browser's Camoufox build.

The ``camoufox`` PACKAGE is an ordinary requirements.txt dependency;
this module downloads the BROWSER it drives (the anti-detect Firefox
build, ~1.3 GB compressed / ~2.4 GB extracted).  One entry, two audiences:

- dev workstation::

      ./local/py3/bin/python -m searx.zjsearch.ai.browser.install

- Docker image build -- run the same module in the BUILDER stage with
  ``XDG_CACHE_HOME`` pinned (Camoufox installs into
  ``$XDG_CACHE_HOME/camoufox``), COPY that directory over in the dist
  stage, and install the Firefox runtime libraries there
  (``python -m playwright install-deps firefox``).  The exact recipe
  lives in AGENTS.md's render-contract section; nothing in this repo
  edits the Dockerfiles.

``$XDG_CACHE_HOME`` decides WHERE the bundle lands; whatever is set at
install time must be set at run time too.  Extra arguments pass
through to the camoufox CLI verbatim (``camoufox fetch``).  After the
browser lands, the LAUNCH-TIME downloads are prefetched into the same
cache -- the fingerprint generator's model, the GeoIP databases and
uBlock Origin (the default adblock addon) -- so the browser's first
launch needs none of them on the network.  Every prefetch is
fail-open (a deployment without them works once online; the GeoIP db
additionally ages on camoufox's own re-check schedule, so the
prefetch buys freshness, not permanent independence).
"""

import os
import subprocess
import sys


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
    result = subprocess.call([sys.executable, "-m", "camoufox", "fetch", *sys.argv[1:]])
    if result != 0:
        return result
    if not _bundle_landed():
        # the CLI can exit 0 on a FAILED download (observed when the
        # github releases API 404s mid-build: the repo cache is written,
        # the browser never lands) -- a silent no-op here would bake an
        # image whose every read fails at launch; fail the BUILD loudly
        # instead so a rerun retries the download
        print(
            "error: camoufox fetch reported success but no browser bundle"
            f" landed in {os.environ.get('XDG_CACHE_HOME') or 'the user cache'}"
            " -- usually the github releases API failing transiently; rerun"
            " the install",
            file=sys.stderr,
        )
        return 1
    _prefetch_fingerprint_model()
    _prefetch_launch_payloads()
    return 0


def _bundle_landed() -> bool:
    """Whether the multiversion layout actually holds a browser build
    (``INSTALL_DIR/browsers/<repo>/<version>/`` with the executable)."""
    try:
        from camoufox.pkgman import INSTALL_DIR  # pylint: disable=import-outside-toplevel
    except ImportError:
        return False
    browsers = INSTALL_DIR / "browsers"
    if not browsers.is_dir():
        return False
    for version_dir in browsers.glob("*/*/"):
        if any(version_dir.iterdir()):
            return True
    return False


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
    copy on the manifest check).  Fail-open like the fingerprint model
    above: a deployment whose prefetch failed works once online."""
    try:
        from camoufox.geolocation import download_mmdb  # pylint: disable=import-outside-toplevel

        download_mmdb()
        print("zjsearch browser: geoip databases in place")
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
