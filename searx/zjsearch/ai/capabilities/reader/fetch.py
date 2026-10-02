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
import json
import logging
import re
import typing as t
from urllib.parse import urlsplit

from searx.network.client import get_loop
from searx.network.network import get_network
from searx.zjsearch.ai.capabilities.reader.config import (
    GOTO_TIMEOUT_MS,
    REJECT_RESOURCE_TYPES,
    SETTLE_MS,
    PageReadError,
    api_key,
    base_url,
    cfg,
    params,
    query,
)

logger = logging.getLogger(__name__)

READER_NETWORK = "zjsearch-reader"
"""The reader's dedicated outgoing network (``outgoing.networks`` entry).
The app-initialized DEFAULT network is https-only (``enable_http: false``
is searx's hard-coded default), so a plain-http Browserless -- a
self-hosted LAN deployment, the audit gate's mock -- needs its own
network with ``enable_http: true``; when the entry is absent the reader
rides the default network like every engine (https endpoints are
unaffected)."""

FETCH_TIMEOUT = (10.0, 65.0)
"""The one page-read request's budget as a curl_cffi ``(connect, total)``
tuple -- the searx network client is curl_cffi, whose timeout conversion
does not understand httpx.Timeout objects (one would silently disable the
per-request AND the session default).  The goto itself may take 30 s
(Browserless' own ceiling) plus render, settle and transfer."""

_DENIED_SUFFIXES = (".local", ".internal", ".lan", ".intranet", ".home.arpa", ".localdomain")
"""DNS names that only exist inside the Browserless host's network -- the
render must never reach them."""


def guard_url(url: str) -> str:
    """Public http(s) URLs only: the model is untrusted input, and the
    render happens inside the Browserless host's network -- loopback,
    private ranges and the cloud metadata endpoint stay out of reach.
    Browsers canonicalize more than Python does: a final numeric label
    (``2130706433``, ``0x7f.0.0.1``, ``0177.0.0.1``) parses as an IPv4
    address per WHATWG, and single-label / site-local names resolve
    through the host's search domains -- both are refused up front."""
    candidate = str(url or "").strip()
    if not candidate or len(candidate) > 2000:
        raise PageReadError("not a usable url")
    parts = urlsplit(candidate)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise PageReadError(f"not a public http(s) url: {candidate[:120]}")
    host = parts.hostname.lower().rstrip(".")
    if not host or host == "localhost" or host.endswith(_DENIED_SUFFIXES):
        raise PageReadError(f"refusing a non-public host: {host}")
    if "." not in host:
        raise PageReadError(f"refusing a single-label host: {host}")
    last = host.rsplit(".", 1)[-1]
    if last.isdigit() or (last[:2] == "0x" and len(last) > 2 and all(c in "0123456789abcdefABCDEF" for c in last[2:])):
        # no public name ends in a numeric label -- this is a browser-
        # canonicalized IPv4 form, and its expanded address is exactly
        # the kind of target this gate exists for
        raise PageReadError(f"refusing a numeric host form: {host}")
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
    """One truncated, tag-stripped line of a provider error body (the
    server answers with HTML pages on some failures)."""
    plain = " ".join(re.sub(r"<[^>]+>", " ", str(text or "")).split())
    return plain[:200] or "no reason given"


_PARAMS_400_WARNED = False
"""One-time flag: the provider rejected the params block (its /content
schema rejects properties this build does not know -- observed with
blockAds/launch on a strict Browserless).  The degrade retry below must
not warn per read."""


def _query_params() -> dict[str, t.Any]:
    """The request's query string: the token + the deployment's launch
    parameters.  Scalar values pass through (``blockAds: true`` ->
    ``blockAds=true``, lowercased per the manual's shape); a dict/list
    value is the launch-JSON form (``launch: {stealth: true}`` ->
    ``launch={"stealth": true}``, URL-encoded by the network layer)."""
    out: dict[str, t.Any] = {"token": api_key(cfg())}
    for key, value in query().items():
        if isinstance(value, bool):
            out[str(key)] = str(value).lower()
        elif isinstance(value, (dict, list)):
            out[str(key)] = json.dumps(value)
        else:
            out[str(key)] = value
    return out


def _post_render(body: dict[str, t.Any]) -> t.Any:
    """One POST to the render endpoint: the shared-loop bridge (the page
    reader's sync caller runs on a worker thread), no network-layer raise
    -- status codes are THIS module's message to the model.  Connection
    failures and the wall clock become PageReadError."""
    future = asyncio.run_coroutine_threadsafe(
        (get_network(READER_NETWORK) or get_network()).request(
            "POST",
            f"{base_url()}/content",
            # the token + the deployment's LAUNCH parameters ride the query
            # string (Browserless v2: stealth/blockAds/launch configure the
            # browser launch -- in the body they trip the schema's
            # "must NOT have additional properties")
            params=_query_params(),
            json=body,
            headers={"Content-Type": "application/json"},
            timeout=FETCH_TIMEOUT,
            raise_for_httperror=False,
        ),
        get_loop(),
    )
    try:
        return future.result(timeout=80.0)
    except concurrent.futures.TimeoutError as exc:
        # the wall-clock budget died waiting: cancel the coroutine so a
        # hung endpoint cannot leak its connection on the shared loop
        future.cancel()
        raise PageReadError("page reader timed out") from exc
    except Exception as exc:  # pylint: disable=broad-except
        # the network layer re-raises whatever its client dialect raised
        # (curl_cffi / httpx connection failures) -- one line for the model
        raise PageReadError(f"page reader unreachable: {type(exc).__name__}: {exc}") from exc


def rendered_html(url: str) -> str:
    """The rendered HTML of one URL through the provider's render
    endpoint (Browserless v2 ``POST /content`` today; the instance's
    default network: proxies apply)."""
    # the structural DEFAULTS of the render request -- every key is
    # overridable through ``zjsearch.reader.params`` (merged in LAST):
    # gotoOptions / waitForTimeout / rejectResourceTypes included, a
    # params key replaces the WHOLE value.  ``url`` is the one exception
    # -- it is the tool call's argument, not a deployment setting.
    body: dict[str, t.Any] = {
        "url": url,
        "gotoOptions": {"waitUntil": "load", "timeout": GOTO_TIMEOUT_MS},
        "waitForTimeout": SETTLE_MS,
        "rejectResourceTypes": list(REJECT_RESOURCE_TYPES),
    }
    params_block = params()
    body.update(params_block)
    response = _post_render(body)
    if response.status_code == 400 and params_block:
        # the provider's schema rejected a params property (builds differ
        # -- blockAds/launch on a strict Browserless answer "must NOT have
        # additional properties"): degrade ONCE to the structural body --
        # every read failing would blind the whole web_reader tool, the
        # extras are optimisations, not requirements
        global _PARAMS_400_WARNED  # pylint: disable=global-statement
        if not _PARAMS_400_WARNED:
            _PARAMS_400_WARNED = True
            logger.warning(
                "zjsearch reader: the provider rejected the params block"
                " (HTTP 400) -- retrying reads with the structural body only;"
                " check zjsearch.reader.params against this provider build"
            )
        response = _post_render({k: v for k, v in body.items() if k not in params_block})
    if response.status_code != 200:
        raise PageReadError(f"page reader HTTP {response.status_code}: {_error_snippet(response.text)}")
    return response.text
