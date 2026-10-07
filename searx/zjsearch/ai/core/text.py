# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Shared text guards: the raw tool-call arguments reader every tool
parser and debug pane goes through, and the keyword splitter the small
in-run scorers share.  A leaf on purpose -- it imports nothing from the
package."""

import json
import re
import typing as t


def raw_args(call: dict[str, t.Any]) -> dict[str, t.Any]:
    """The model's RAW tool-call arguments as a dict (``{}`` on any
    malformed input) -- the timeline row's debug expansion shows exactly
    what was passed (q, category, ...), unfiltered."""
    try:
        value = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def query_terms(query: str) -> list[str]:
    """The matchable terms of one tool-call query: whitespace/comma-split,
    lowercased, empties dropped -- the one splitter behind the in-run
    keyword scorers (``tools.memory``, ``tools.past_research``)."""
    return [term for term in re.split(r"[\s,，]+", str(query or "").lower()) if term]
