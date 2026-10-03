# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``calls`` timeline rows -- the shared row builders.

One ``calls`` wire item -> the client's timeline row (``display_item``).
``tool`` discriminates the row kind -- a search renders its query, a
page read its url; a row's ``args`` always carries the RAW tool-call
arguments (``args.raw_args``), so the client's debug expansion shows
exactly what the model passed.  The single-tool row builders live with
their tool modules (``judge.decision_row``); the dispatch stays here.
"""

import typing as t

from searx.zjsearch.ai.capabilities import mcp
from searx.zjsearch.ai.runtime.tools.args import raw_args
from searx.zjsearch.ai.runtime.tools.ask_user import ASK_TOOL
from searx.zjsearch.ai.runtime.tools.calculator import CALCULATOR_TOOL_NAME
from searx.zjsearch.ai.runtime.tools.judge import DECISION_TOOL, decision_row
from searx.zjsearch.ai.runtime.tools.learnings import LEARNINGS_TOOL
from searx.zjsearch.ai.runtime.tools.memory import USER_MEMORY_TOOL
from searx.zjsearch.ai.runtime.tools.past_research import PAST_RESEARCH_TOOL
from searx.zjsearch.ai.runtime.tools.tasks import TASK_TOOL, parse_task_call
from searx.zjsearch.ai.runtime.tools.web_reader import PAGE_TOOL, parse_page_call
from searx.zjsearch.ai.runtime.tools.web_search import TOOL_NAME, parse_call


def display_item(  # pylint: disable=too-many-return-statements, too-many-branches
    idx: int, call: dict[str, t.Any]
) -> dict[str, t.Any]:
    """One ``calls`` wire item: the client's timeline row.  ``tool``
    discriminates the row kind -- a search renders its query, a page read
    its url.  Site filters display folded into the query so the row shows
    the operators the engine will enforce."""
    call_name = str(call.get("name") or "")
    if call_name == TASK_TOOL:
        items = parse_task_call(call)
        return {
            "id": idx,
            "tool": TASK_TOOL,
            "q": f"{sum(1 for i in items if i.get('status') == 'done')}/{len(items)}",
            "args": raw_args(call),
        }
    if call_name == LEARNINGS_TOOL:
        # the findings ledger write: a fixed row label (the settlement's
        # label carries the count); the raw facts ride the debug pane
        return {"id": idx, "tool": LEARNINGS_TOOL, "q": "", "args": raw_args(call)}
    if call_name == DECISION_TOOL:
        return decision_row(idx, call)
    if call_name == ASK_TOOL:
        # the human-in-the-loop ask: the row's label is the question's
        # intro (falling back to the first question's text) -- the raw
        # arguments ride along like every other row's debug pane
        try:
            ask_args = raw_args(call)
        except Exception:  # pylint: disable=broad-except
            ask_args = {}
        questions = ask_args.get("questions")
        first = ""
        if isinstance(questions, list) and questions and isinstance(questions[0], dict):
            first = str(questions[0].get("q") or "").strip()[:120]
        return {
            "id": idx,
            "tool": ASK_TOOL,
            "q": str(ask_args.get("intro") or "").strip()[:120] or first,
            "args": ask_args,
        }
    if call_name == PAST_RESEARCH_TOOL:
        try:
            memory_args = raw_args(call)
        except Exception:  # pylint: disable=broad-except
            memory_args = {}
        return {
            "id": idx,
            "tool": PAST_RESEARCH_TOOL,
            "q": str(memory_args.get("query") or "")[:120],
            "args": memory_args,
        }
    if call_name == USER_MEMORY_TOOL:
        try:
            memory_args = raw_args(call)
        except Exception:  # pylint: disable=broad-except
            memory_args = {}
        action = str(memory_args.get("action") or "search")
        return {
            "id": idx,
            "tool": USER_MEMORY_TOOL,
            "name": action,
            "q": str(memory_args.get("query") or memory_args.get("content") or "")[:120],
            "args": memory_args,
        }
    if call_name == mcp.SEARCH_TOOL:
        # progressive disclosure's discovery call: the row shows the
        # KEYWORD the model searched the tool inventory for (a bare
        # "tools" label reads as noise)
        try:
            search_args = raw_args(call)
        except Exception:  # pylint: disable=broad-except
            search_args = {}
        return {
            "id": idx,
            "tool": "mcp",
            "name": "search_tools",
            "q": str(search_args.get("query") or "")[:120],
            "args": search_args,
        }
    if call_name.startswith("mcp_"):
        # an MCP bridge call: the row shows the server-scoped tool name
        # (everything after the mcp_<server> prefix); the raw args ride
        # along like every other row's debug pane
        return {
            "id": idx,
            "tool": "mcp",
            "name": call_name.split("_", 2)[-1] if call_name.count("_") >= 2 else call_name,
            "args": raw_args(call),
        }
    if str(call.get("name") or "") == CALCULATOR_TOOL_NAME:
        try:
            calc_args = raw_args(call)
        except Exception:  # pylint: disable=broad-except
            calc_args = {}
        expression = str(calc_args.get("expression") or "")[:500]
        try:
            precision = max(0, min(int(calc_args.get("precision")), 12))
        except (TypeError, ValueError):
            precision = 10
        return {
            "id": idx,
            "tool": CALCULATOR_TOOL_NAME,
            # the expression IS the row's label (the result rides the right
            # side as "= x") -- the client renders `expr = result`
            "q": expression,
            "expression": expression,
            "precision": precision if precision != 10 else None,
            "args": raw_args(call),
        }
    if str(call.get("name") or "") == PAGE_TOOL:
        # args rides along: the RAW tool-call arguments -- the timeline row's
        # debug expansion shows exactly what the model passed
        return {
            "id": idx,
            "tool": PAGE_TOOL,
            "url": parse_page_call(call),
            "args": raw_args(call),
        }
    query, category, time_range, include, exclude = parse_call(call)
    operators = " ".join([f"site:{host}" for host in include] + [f"-site:{host}" for host in exclude])
    if operators:
        query = f"{query} {operators}"
    return {
        "id": idx,
        "tool": TOOL_NAME,
        "q": query,
        "category": category,
        "time_range": time_range or None,
        "args": raw_args(call),
    }
