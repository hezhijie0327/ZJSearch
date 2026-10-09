# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search page reader: the HTML extraction lives in the BROWSER
package (:py:mod:`searx.zjsearch.ai.browser.extract` -- the render engine
renders AND extracts; tools importing browser is the legal edge, the old
upward one is not).  Re-exported here so the package's public surface is
unchanged."""

from searx.zjsearch.ai.browser.extract import (
    _cap,
    PageReadError,
    extract_page,
)  # noqa: F401  (pylint: disable=protected-access)

__all__ = ["PageReadError", "extract_page", "_cap"]
