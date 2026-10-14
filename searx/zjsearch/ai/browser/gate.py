# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The built-in browser's request gate -- the SSRF fence, now at REQUEST
level.

With the Browserless provider the render happened on the provider's host
and the string-level gate of :py:mod:`core.guard` was the whole story.
A LOCAL browser resolves and connects from THIS host: localhost and the
intranet are one navigation away, and a page's own subresource and
iframe requests navigate just as well as the URL the model typed.  The
gate is therefore a ``context.route("**/*")`` handler that sees every
request: the shared string checks first, then the hostname is RESOLVED
and every answer must be a global address -- a public name that answers
with a private record (DNS rebinding) dies here too.

Known, accepted edge (documented, not silently ignored): the small
TOCTOU window between this resolution and the browser's own connection
-- closing it needs a local connect-proxy, out of scope for this
stage.  WebRTC, the other un-routed leak, is closed at launch instead
(``block_webrtc``).
"""

import asyncio
import ipaddress
import logging
import time
import typing as t
from urllib.parse import urlsplit

from searx.zjsearch.ai.browser import config as browser_config
from searx.zjsearch.ai.core.guard import public_url_rejection

logger = logging.getLogger(__name__)

REJECT_RESOURCE_TYPES = frozenset({"image", "media", "font", "stylesheet"})
"""The reader only needs the DOM text: media loads are the bulk of the
wall time and stylesheets gate the ``load`` event (same list the
provider path sends as ``rejectResourceTypes``).  The observe stage
re-enables images when the mirror wants to show pages as rendered."""

_RESOLVE_TTL = 60.0
_RESOLVE_CACHE_MAX = 512
_resolved: dict[str, tuple[float, tuple[str, ...] | None]] = {}
"""Per-host resolution answers with a TTL -- one page makes dozens of
subresource requests against a handful of hosts.  Negative answers
(unresolvable) cache like positive ones."""


async def _resolve(host: str) -> tuple[str, ...] | None:
    """Every address ``host`` answers with, deduplicated in answer order
    -- ``None`` when nothing resolves.  ``asyncio.getaddrinfo`` keeps the
    resolution off the shared loop's thread."""
    now = time.monotonic()
    hit = _resolved.get(host)
    if hit is not None and now - hit[0] < _RESOLVE_TTL:
        return hit[1]
    try:
        answers = await asyncio.get_running_loop().getaddrinfo(host, None)
    except OSError:
        answers = []
    ips = tuple(dict.fromkeys(str(answer[4][0]) for answer in answers))
    while len(_resolved) >= _RESOLVE_CACHE_MAX:
        _resolved.pop(next(iter(_resolved)))
    _resolved[host] = (now, ips or None)
    return ips or None


visual_pages: dict[int, t.Any] = {}
"""Page OBJECTS registered by the interactive session, keyed by id(): their
page renders FOR THE USER (the Lightbox takeover), so stylesheets, fonts
and images load normally -- the resource-type rejection is a reader-only
optimization.  The SSRF checks still apply to every request.  Strong refs:
a closed page's id() can be recycled by a fresh reader page, and a bare
int set would then grant the bypass to the wrong page."""


async def gate(route: t.Any) -> None:
    """The ``context.route("**/*")`` handler: abort or continue every
    request the page makes.  Abort reasons stay at debug level -- a page
    full of third-party trackers would otherwise flood the log."""
    request = route.request
    if request.resource_type in REJECT_RESOURCE_TYPES:
        try:
            # frame/page are PROPERTIES on playwright's request object
            if id(request.frame.page) in visual_pages:
                await route.continue_()
                return
        except Exception:  # pylint: disable=broad-except
            pass
        await route.abort()
        return
    url = request.url
    host = (urlsplit(url).hostname or "").lower().rstrip(".")
    if host in browser_config.allow_hosts():
        await route.continue_()
        return
    reason = public_url_rejection(url)
    if reason is None and host:
        try:
            ipaddress.ip_address(host)
        except ValueError:
            # a name, not a literal: the string gate cannot see what it
            # answers with -- resolve and demand a global address each time
            ips = await _resolve(host)
            if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
                reason = f"refusing a non-public address behind: {host}"
    if reason is not None:
        logger.debug("zjsearch browser: blocked request %s (%s)", url, reason)
        await route.abort()
        return
    await route.continue_()
