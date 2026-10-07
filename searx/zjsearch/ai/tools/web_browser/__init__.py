# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``web_browser`` tool package: human-in-the-loop page sessions.

The model opens a page it cannot pass (a sign-in wall, a verification
gate, anything its reads cannot see through) and the USER completes the
human part -- the Lightbox takeover shows the live page and forwards
clicks/keys, a desktop ``headed`` window is directly operable.  The tool
then hands the resulting page back as reading material.  No heuristics:
the model decides from ``web_reader``'s content that a page needs a
human, and the tool only opens, mirrors, waits and extracts."""

from searx.zjsearch.ai.tools.web_browser.service import (
    run_action,
    wait_user_frames,
    wait_user_snapshot,
)
from searx.zjsearch.ai.tools.web_browser.spec import (
    WEB_BROWSER_TOOL,
    parse_web_browser_call,
    web_browser_spec,
)

__all__ = [
    "WEB_BROWSER_TOOL",
    "parse_web_browser_call",
    "run_action",
    "wait_user_frames",
    "wait_user_snapshot",
    "web_browser_spec",
]
