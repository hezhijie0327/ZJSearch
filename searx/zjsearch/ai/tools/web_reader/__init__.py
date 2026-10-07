# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``web_reader`` tool package: the whole tool in :py:mod:`.reader`
(spec + parsing + knobs + guard + TTL-cached read service) and the
extraction pipeline in :py:mod:`.extract` (the package's bottom module,
home of the shared ``PageReadError``).  Consumers import the read
surface from here; the render backend is the built-in browser
(:py:mod:`searx.zjsearch.ai.browser`) and never this package's concern."""

from searx.zjsearch.ai.tools.web_reader.extract import PageReadError
from searx.zjsearch.ai.tools.web_reader.reader import (
    PAGE_TOOL,
    configured,
    enabled,
    max_chars,
    normalize_url,
    page_spec,
    parse_page_call,
    read_page,
)

__all__ = [
    "PAGE_TOOL",
    "PageReadError",
    "configured",
    "enabled",
    "max_chars",
    "normalize_url",
    "page_spec",
    "parse_page_call",
    "read_page",
]
