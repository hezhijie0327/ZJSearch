# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The NDJSON stream wrapper the AI endpoints share: PRIME before
streaming (a run that dies before its first content event answers the
plain-text 502, never a 200 with an empty body), then buffer + iterate.

The search route's _Ndjson owns the mechanics (its own settle-merge
and post-settle late events); the overview tier rides the same route
now, so there is no second stream shape.  ``UpstreamDead`` is the one shared failure
type -- the routes map it to :py:func:`api.http.upstream_error_response`."""

import typing as t

from searx.zjsearch.ai.core import wire_format as wire


class UpstreamDead(Exception):
    """The run settled as an error before any content event: the route
    maps this to the plain-text 502."""
