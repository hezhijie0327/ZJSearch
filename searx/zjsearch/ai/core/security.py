# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The HMAC page-data token gate.

A stateless proof that the caller received a page rendered by THIS
instance: the server mints ``ts.signature`` tokens into every page-data
payload (:py:func:`issue_token`), and the AI route prologues check the
posted token (:py:func:`check_token`) before doing any work.  Not a
rate limit -- deployments front the AI routes with their own per-IP
limiter (see AGENTS.md, DEPLOYMENT).
"""

import hashlib
import hmac
import time

from searx import settings

TOKEN_TTL = 3600.0
"""Lifetime of a page-data token: an hour, like the reference design."""

_SECRET = hashlib.sha256(f"zjsearch_ai_{settings.get('server', {}).get('secret_key', '')}".encode()).hexdigest()
"""HMAC key derived once from ``server.secret_key`` at import time."""


def issue_token() -> str:
    """Stateless ``ts.signature`` token; the page-data payload carries one per
    render and the answer endpoint checks it before doing any work."""
    ts = str(int(time.time()))
    sig = hmac.new(_SECRET.encode(), ts.encode(), hashlib.sha256).hexdigest()
    return f"{ts}.{sig}"


def check_token(token: str) -> bool:
    try:
        ts, sig = token.split(".", 1)
        if time.time() - float(ts) > TOKEN_TTL:
            return False
    except (ValueError, OverflowError):
        return False
    expected = hmac.new(_SECRET.encode(), ts.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)
