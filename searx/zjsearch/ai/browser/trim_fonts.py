# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Image-build trimmer for the Camoufox font library.

The browser's ~2GB font library is packed per SPOOF-OS group
(``fonts/groups.json``: L/M/W letter combinations, each face stored
once) and the launch pins ``os: "windows"`` (``engine.py``) -- the
launch-time fontconfig only ever mounts the groups the pinned OS
reads, so the other OSes' EXCLUSIVE groups are dead weight in a Docker
image (~850 MB on the real bundle).  This module deletes them, keyed
on groups.json itself so upstream regroupings stay covered; a missing
file fails loudly rather than shipping a surprise.

IMAGE-ONLY: a dev workstation never runs this -- its install keeps
every group.  The Dockerfile invokes it right after ``browser.install``
with the pinned OS as the argument (a separate RUN layer is safe: the
final stage COPYs /app's end state, intermediate build layers never
reach it).  Moving the engine.py pin without moving this invocation
ships an image whose identities enumerate fonts their OS should not
have.
"""

import json
import shutil
import sys
from pathlib import Path

READ_BY_KEY = {"linux": "lin", "macos": "mac", "windows": "win"}
"""The spoof OS -> groups.json ``readBy`` key (camoufox's own map)."""


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in READ_BY_KEY:
        print(
            f"usage: python -m searx.zjsearch.ai.browser.trim_fonts {'|'.join(READ_BY_KEY)}",
            file=sys.stderr,
        )
        return 1
    try:
        from camoufox.pkgman import INSTALL_DIR  # pylint: disable=import-outside-toplevel
    except ImportError:
        print(
            "error: the camoufox package is not installed in this environment"
            " (run the trim inside the build venv, e.g. /app/bin/python3)",
            file=sys.stderr,
        )
        return 1
    key = READ_BY_KEY[sys.argv[1]]
    scanned = 0
    for fonts in INSTALL_DIR.glob("browsers/*/*/fonts"):
        scanned += 1
        meta = json.loads((fonts / "groups.json").read_bytes())
        keep = set(meta["readBy"][key])
        for name in meta["groups"]:
            if name not in keep and (fonts / name).is_dir():
                shutil.rmtree(fonts / name)
                print(f"zjsearch browser: trimmed font group {name}")
    if scanned == 0:
        print(
            f"error: no browser font bundle found under {INSTALL_DIR}/browsers"
            " -- run browser.install first",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
