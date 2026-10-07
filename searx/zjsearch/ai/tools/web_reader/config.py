# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Page reader configuration: the settings block, the budgets and the
shared error type.  The bottom of the reader package -- fetch, extract
and the package ``__init__`` read their knobs from here."""

import typing as t


from searx.zjsearch.ai.core import config as core_config

GOTO_TIMEOUT_MS = 30_000
SETTLE_MS = 1_200
"""Wait for ``load`` plus a short settle -- late hydration gets a moment
without paying a fixed second per page."""

REJECT_RESOURCE_TYPES = ("image", "media", "font", "stylesheet")
"""The reader only needs the DOM text: media loads are the bulk of the
wall time AND stylesheets gate the ``load`` event -- both are rejected
at the request level (the markdown conversion is CSS-free; a site that
misbehaves without its CSS re-enables it via ``params``)."""


class PageReadError(Exception):
    """A page could not be read -- the message travels to the model as the
    tool result (a dead end it is taught to move on from)."""


def cfg() -> dict[str, t.Any]:
    """The ``zjsearch.reader`` settings block (absent unless the
    deployment defines it) -- the page-reader config, a sibling of
    ``zjsearch.ai`` (Browserless v2 today; a future second implementation
    would reintroduce a discriminator key)."""
    return core_config.zj_block("reader")


def api_key(block: dict[str, t.Any]) -> str:
    """The effective API key: the ``api_key`` setting first, then the
    ``ZJSEARCH_READER_KEY`` environment."""
    return core_config.env_key(block, "ZJSEARCH_READER_KEY")


def base_url() -> str:
    """The provider root (``zjsearch.reader.base_url``), no trailing
    slash."""
    return str(cfg().get("base_url") or "").strip().rstrip("/")


def enabled() -> bool:
    """The reader feature flag: ``zjsearch.reader.enabled`` -- ``True``
    unless explicitly switched off (``false`` = the ``web_reader`` tool
    never registers, exactly like an unconfigured reader)."""
    return cfg().get("enabled") is not False


def configured() -> bool:
    """True when the tool may register: ``enabled`` and ``base_url``
    present.  The ``api_key`` is OPTIONAL -- a self-hosted Browserless on
    the LAN runs auth-free (cloud deployments set the key or the
    ``ZJSEARCH_READER_KEY`` env)."""
    return enabled() and bool(base_url())


def params() -> dict[str, t.Any]:
    """The ``zjsearch.reader.params`` block -- the provider's OWN request
    BODY properties (``gotoOptions``, ``waitForTimeout``,
    ``rejectResourceTypes``, ...), merged 1:1 over the structural body
    fields (the openai-transport ``params`` pattern).  Launch parameters
    (Browserless' ``stealth`` / ``blockAds`` / ``launch``) do NOT belong
    here -- they ride the URL query string, see :func:`query`."""
    raw = cfg().get("params")
    return raw if isinstance(raw, dict) else {}


def query() -> dict[str, t.Any]:
    """The ``zjsearch.reader.query`` block -- the provider's LAUNCH
    parameters, merged into the request URL's query string next to
    ``token`` (Browserless v2: ``stealth`` / ``blockAds`` / ``launch`` /
    ``proxy`` configure the BROWSER LAUNCH and ride the query string;
    putting them in the body trips the schema's "must NOT have additional
    properties")."""
    raw = cfg().get("query")
    return raw if isinstance(raw, dict) else {}


def normalize_url(url: str) -> str:
    """The dedup / cache key of a page: whitespace-stripped, fragment-free."""
    return str(url or "").strip().split("#", 1)[0]


def max_chars() -> int | None:
    """``zjsearch.reader.max_chars`` -- UNSET means NO cap (the whole
    readable text goes to the model; contexts are long now); a set value
    truncates, clamped to sane bounds."""
    value = cfg().get("max_chars")
    if value is None:
        return None
    try:
        limit = int(value)
    except (TypeError, ValueError):
        return None
    return max(2000, min(limit, 100_000))
