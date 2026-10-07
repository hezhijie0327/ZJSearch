# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The one SSRF gate every server-side fetch shares.

The model is untrusted input and server fetches happen inside the
instance's network -- every URL a server thread touches (the page
reader's render, the image attachments) passes the public-address gate
first.  :py:func:`public_url_rejection` is the single implementation;
the callers wrap it in their own error type (the reader raises
``PageReadError`` with a model-facing message, the image attachments
ask the boolean question)."""

import ipaddress
from urllib.parse import urlsplit

_DENIED_SUFFIXES = (".local", ".internal", ".lan", ".intranet", ".home.arpa", ".localdomain")
"""DNS names that only exist inside an intranet -- nothing public ends
in one."""


def public_url_rejection(url: str, *, max_length: int = 2000) -> str | None:
    """WHY the URL must not be fetched, or ``None`` when it is a public
    http(s) address.  Browsers canonicalize more than Python does: a
    final numeric label (``2130706433``, ``0x7f.0.0.1``, ``0177.0.0.1``)
    parses as an IPv4 address per WHATWG, and single-label / site-local
    names resolve through the host's search domains -- both are refused
    up front."""
    candidate = str(url or "").strip()
    if not candidate:
        return "empty url"
    if len(candidate) > max_length:
        return "url too long"
    parts = urlsplit(candidate)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return "not a public http(s) url"
    host = parts.hostname.lower().rstrip(".")
    if not host or host == "localhost" or host.endswith(_DENIED_SUFFIXES):
        return f"refusing a non-public host: {host}"
    if "." not in host:
        return f"refusing a single-label host: {host}"
    last = host.rsplit(".", 1)[-1]
    if last.isdigit() or (last[:2] == "0x" and len(last) > 2 and all(c in "0123456789abcdefABCDEF" for c in last[2:])):
        # no public name ends in a numeric label -- this is a browser-
        # canonicalized IPv4 form, and its expanded address is exactly
        # the kind of target this gate exists for
        return f"refusing a numeric host form: {host}"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return None
    if not ip.is_global:
        # is_global covers private, loopback, link-local, reserved,
        # multicast and documentation ranges in one stroke
        return f"refusing a non-public address: {host}"
    return None
