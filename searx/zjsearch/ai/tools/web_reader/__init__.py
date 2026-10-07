# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``web_reader`` tool package: ONE self-contained tool -- the
model-facing spec (:py:mod:`.spec`), the render fetch
(:py:mod:`.fetch`), the extraction pipeline (:py:mod:`.extract`), the
settings knobs (:py:mod:`.config`) and the TTL-cached read service
(:py:mod:`.service`).  Consumers import the read surface from here;
adding a reader provider never touches the executor."""

from searx.zjsearch.ai.tools.web_reader.spec import PAGE_TOOL, page_spec, parse_page_call
from searx.zjsearch.ai.tools.web_reader.service import (
    PageReadError,
    api_key,
    base_url,
    cfg,
    configured,
    enabled,
    max_chars,
    normalize_url,
    params,
    read_page,
)

__all__ = [
    "PAGE_TOOL",
    "PageReadError",
    "api_key",
    "base_url",
    "cfg",
    "configured",
    "enabled",
    "max_chars",
    "normalize_url",
    "params",
    "page_spec",
    "parse_page_call",
    "read_page",
]
