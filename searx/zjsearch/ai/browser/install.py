# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Build-time installer for the built-in browser's Camoufox build.

The ``camoufox`` PACKAGE is an ordinary requirements.txt dependency;
this module downloads the BROWSER it drives (the anti-detect Firefox
build, ~150 MB).  One entry, two audiences:

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
through to the camoufox CLI verbatim (``camoufox fetch``).  uBlock
Origin (the default adblock addon) is NOT downloaded here -- it lands
in the same cache on the browser's first online launch and fails open
without network.
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
    return subprocess.call([sys.executable, "-m", "camoufox", "fetch", *sys.argv[1:]])


if __name__ == "__main__":
    sys.exit(main())
