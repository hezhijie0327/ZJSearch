# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the raw tool-call arguments reader.

The one JSON-shape guard every tool family's parser shares: the model's
RAW ``arguments`` string as a dict (or ``{}`` on any malformed input) --
the timeline row's debug expansion shows exactly what was passed
(q, category, ...), unfiltered.  A leaf on purpose: the parsers
(``tasks.parse_task_call``, ``learnings.parse_learnings_call``,
``judge.parse_system_one_call``) and the row dispatch (``rows``) all
read through it, so it imports nothing from the package.
"""

import json
import typing as t


def raw_args(call: dict[str, t.Any]) -> dict[str, t.Any]:
    """The model's RAW tool-call arguments as a dict -- the timeline row's
    debug expansion shows exactly what was passed (q, category, ...),
    unfiltered."""
    try:
        value = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}
