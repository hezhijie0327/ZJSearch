# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The tool-executor contract the loop consumes.

An executor is a generator over ONE round's calls
(``[{"id", "name", "arguments"}, ...]``, the pumps' flat shape).  It
yields framework events while the calls run -- ``("call", {...})``
settlements, ``("sources", {...})``, ``("tasks", {...})`` -- and MUST
end with ``("tool_results", [(call, text), ...])`` aligned BY POSITION
with the input list; the loop feeds those texts back as the tool
results message.  A missing pair degrades to an error tool result the
model can see.

The executor's settlement events carry ``call`` (the 1-based position
within the round) but NO entry/round numbers -- the loop stamps the
current timeline entry onto everything it relays.  One counter, no
cross-layer alignment convention.
"""

import typing as t

TOOL_RESULTS = "tool_results"
"""The terminal event kind that closes one executor round."""

Event = tuple[str, t.Any]
Executor = t.Callable[[list[dict[str, t.Any]]], t.Iterator[Event]]
