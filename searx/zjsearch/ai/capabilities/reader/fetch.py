# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search page reader: the SSRF guard and the Browserless HTTP call.

The model is untrusted input and the render happens inside the
Browserless host's network -- every URL passes the public-address gate
before it reaches the browser.  One call, one timeout budget, and every
failure surfaces as a :class:`PageReadError` whose message travels to
the model as the tool result (a dead end it is taught to move on from).
"""

import asyncio
import concurrent.futures
import ipaddress
import logging
import re
from urllib.parse import urlsplit

import httpx

from searx.network.client import get_loop
from searx.network.network import get_network
from searx.zjsearch.ai.capabilities.reader.config import (
    GOTO_TIMEOUT_MS,
    REJECT_RESOURCE_TYPES,
    SETTLE_MS,
    PageReadError,
    _cfg,
    _key,
    endpoint,
)

logger = logging.getLogger(__name__)

FETCH_TIMEOUT = httpx.Timeout(75.0, connect=10.0)
"""The one browserless request's budget: the goto itself may take 30 s
(Browserless' own ceiling) plus render, settle and transfer."""


def _guard_url(url: str) -> str:
    """Public http(s) URLs only: the model is untrusted input, and the
    render happens inside the Browserless host's network -- loopback,
    private ranges and the cloud metadata endpoint stay out of reach."""
    candidate = str(url or "").strip()
    if not candidate or len(candidate) > 2000:
        raise PageReadError("not a usable url")
    parts = urlsplit(candidate)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise PageReadError(f"not a public http(s) url: {candidate[:120]}")
    host = parts.hostname.lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise PageReadError(f"refusing a non-public host: {host}")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return candidate
    if not ip.is_global:
        # is_global covers private, loopback, link-local, reserved,
        # multicast and documentation ranges in one stroke
        raise PageReadError(f"refusing a non-public address: {host}")
    return candidate


def _error_snippet(text: str) -> str:
    """One truncated, tag-stripped line of a browserless error body (the
    server answers with HTML pages on some failures)."""
    plain = " ".join(re.sub(r"<[^>]+>", " ", str(text or "")).split())
    return plain[:200] or "no reason given"


def rendered_html(url: str) -> str:
    """The rendered HTML of one URL through Browserless v2 ``POST
    /content`` (the instance's default network: proxies apply)."""
    body = {
        "url": url,
        "gotoOptions": {"waitUntil": "load", "timeout": GOTO_TIMEOUT_MS},
        "waitForTimeout": SETTLE_MS,
        "rejectResourceTypes": list(REJECT_RESOURCE_TYPES),
    }
    future = asyncio.run_coroutine_threadsafe(
        get_network().request(
            "POST",
            f"{endpoint()}/content",
            params={"token": _key(_cfg())},
            json=body,
            headers={"Content-Type": "application/json"},
            timeout=FETCH_TIMEOUT,
            # status codes are THIS module's message to the model (a 4xx/5xx
            # body carries the actual reason) -- no network-layer raise
            raise_for_httperror=False,
        ),
        get_loop(),
    )
    try:
        response = future.result(timeout=80.0)
    except concurrent.futures.TimeoutError as exc:
        raise PageReadError("browserless timed out") from exc
    except Exception as exc:  # pylint: disable=broad-except
        # the network layer re-raises whatever its client dialect raised
        # (curl_cffi / httpx connection failures) -- one line for the model
        raise PageReadError(f"browserless unreachable: {type(exc).__name__}") from exc
    if response.status_code != 200:
        raise PageReadError(f"browserless HTTP {response.status_code}: {_error_snippet(response.text)}")
    return response.text
