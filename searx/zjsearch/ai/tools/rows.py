# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``calls`` timeline rows -- the shared row builders.

One ``calls`` wire item -> the client's timeline row (``display_item``).
``tool`` discriminates the row kind -- a search renders its query, a
page read its url; a row's ``args`` always carries the RAW tool-call
arguments (``args.raw_args``), so the client's debug expansion shows
exactly what the model passed.  The single-tool row builders live with
their tool modules (``evaluate.decision_row``); the dispatch stays here.
"""

import typing as t

from searx.zjsearch.ai.tools import mcp
from searx.zjsearch.ai.tools import search_tools
from searx.zjsearch.ai.core.text import raw_args
from searx.zjsearch.ai.tools.ask_user import ASK_USER_TOOL
from searx.zjsearch.ai.tools.build_table import BUILD_TABLE_TOOL
from searx.zjsearch.ai.tools.calculate import CALCULATE_TOOL
from searx.zjsearch.ai.tools.evaluate import EVALUATE_TOOL, decision_row
from searx.zjsearch.ai.tools.message_subtask import MESSAGE_SUBTASK_TOOL
from searx.zjsearch.ai.tools.memory import MEMORY_TOOL
from searx.zjsearch.ai.tools.recall_history import RECALL_HISTORY_TOOL
from searx.zjsearch.ai.tools.list_engines import LIST_ENGINES_TOOL
from searx.zjsearch.ai.tools.record_findings import RECORD_FINDINGS_TOOL
from searx.zjsearch.ai.tools.set_deliverable import SET_DELIVERABLE_TOOL, parse_set_deliverable_call
from searx.zjsearch.ai.tools.update_plan import UPDATE_PLAN_TOOL, parse_plan_call
from searx.zjsearch.ai.tools.browse import BROWSE_TOOL
from searx.zjsearch.ai.tools.delegate_research import DELEGATE_RESEARCH_TOOL
from searx.zjsearch.ai.tools.search_web import SEARCH_WEB_TOOL, parse_call


def display_item(  # pylint: disable=too-many-return-statements, too-many-branches
    idx: int, call: dict[str, t.Any]
) -> dict[str, t.Any]:
    """One ``calls`` wire item: the client's timeline row.  ``tool``
    discriminates the row kind -- a search renders its query, a page read
    its url.  Site filters display folded into the query so the row shows
    the operators the engine will enforce."""
    call_name = str(call.get("name") or "")
    if call_name == UPDATE_PLAN_TOOL:
        items = parse_plan_call(call)
        return {
            "id": idx,
            "tool": UPDATE_PLAN_TOOL,
            "q": f"{sum(1 for i in items if i.get('status') == 'done')}/{len(items)}",
            "args": raw_args(call),
        }
    if call_name == RECORD_FINDINGS_TOOL:
        # the findings ledger write: a fixed row label (the settlement's
        # label carries the count); the raw facts ride the debug pane
        return {"id": idx, "tool": RECORD_FINDINGS_TOOL, "q": "", "args": raw_args(call)}
    if call_name == SET_DELIVERABLE_TOOL:
        # the deliverable flip: the committed shape is the row's label
        # (the client renders it through the shape's own icon)
        shape = parse_set_deliverable_call(call)
        return {"id": idx, "tool": SET_DELIVERABLE_TOOL, "q": shape or "", "args": raw_args(call)}
    if call_name == EVALUATE_TOOL:
        return decision_row(idx, call)
    if call_name == ASK_USER_TOOL:
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
            "tool": ASK_USER_TOOL,
            "q": str(ask_args.get("intro") or "").strip()[:120] or first,
            "args": ask_args,
        }
    if call_name == DELEGATE_RESEARCH_TOOL:
        # the delegation row: the subtask's title is the label (the live
        # sub timeline lives under the open kind:"sub" row beside it)
        try:
            sub_args = raw_args(call)
        except Exception:  # pylint: disable=broad-except
            sub_args = {}
        return {
            "id": idx,
            "tool": DELEGATE_RESEARCH_TOOL,
            "q": str(sub_args.get("title") or "")[:80],
            "args": sub_args,
        }
    if call_name == MESSAGE_SUBTASK_TOOL:
        # the follow-up row: the resumed subagent's id + the message head
        # are the label; the resumed child's timeline RE-OPENS the same
        # kind:"sub" row beside it
        try:
            follow_args = raw_args(call)
        except Exception:  # pylint: disable=broad-except
            follow_args = {}
        return {
            "id": idx,
            "tool": MESSAGE_SUBTASK_TOOL,
            "q": f"{str(follow_args.get('id') or '')} · {str(follow_args.get('message') or '')[:80]}",
            "args": follow_args,
        }
    if call_name == RECALL_HISTORY_TOOL:
        try:
            memory_args = raw_args(call)
        except Exception:  # pylint: disable=broad-except
            memory_args = {}
        return {
            "id": idx,
            "tool": RECALL_HISTORY_TOOL,
            "q": str(memory_args.get("query") or "")[:120],
            "args": memory_args,
        }
    if call_name == LIST_ENGINES_TOOL:
        # the deployment inventory: a fixed row label (the settlement's
        # n + preview carry the engine count and the listing itself)
        return {"id": idx, "tool": LIST_ENGINES_TOOL, "q": "", "args": raw_args(call)}
    if call_name == MEMORY_TOOL:
        try:
            memory_args = raw_args(call)
        except Exception:  # pylint: disable=broad-except
            memory_args = {}
        action = str(memory_args.get("action") or "search")
        return {
            "id": idx,
            "tool": MEMORY_TOOL,
            "name": action,
            "q": str(memory_args.get("query") or memory_args.get("content") or "")[:120],
            "args": memory_args,
        }
    if call_name == search_tools.DISCOVERY_TOOL:
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
            "name": search_tools.DISCOVERY_TOOL,
            "q": str(search_args.get("query") or "")[:120],
            "args": search_args,
        }
    if call_name.startswith("mcp_"):
        # an MCP bridge call: the row shows the server-scoped tool name
        # (resolved through the same registry the call path uses); the
        # raw args ride along like every other row's debug pane
        return {
            "id": idx,
            "tool": "mcp",
            "name": mcp.tool_of(call_name) or call_name,
            "args": raw_args(call),
        }
    if str(call.get("name") or "") == BROWSE_TOOL:
        try:
            browser_args = raw_args(call)
        except Exception:  # pylint: disable=broad-except
            browser_args = {}
        return {
            "id": idx,
            "tool": BROWSE_TOOL,
            "q": str(browser_args.get("url") or browser_args.get("action") or "")[:120],
            "url": str(browser_args.get("url") or "")[:200],
            "args": browser_args,
        }
    if str(call.get("name") or "") == CALCULATE_TOOL:
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
            "tool": CALCULATE_TOOL,
            # the expression IS the row's label (the result rides the right
            # side as "= x") -- the client renders `expr = result`
            "q": expression,
            "expression": expression,
            "precision": precision if precision != 10 else None,
            "args": raw_args(call),
        }
    if call_name == BUILD_TABLE_TOOL:
        try:
            extract_args = raw_args(call)
        except Exception:  # pylint: disable=broad-except
            extract_args = {}
        return {
            "id": idx,
            "tool": BUILD_TABLE_TOOL,
            "q": str(extract_args.get("title") or "")[:120],
            "args": extract_args,
        }
    query, category, time_range, include, exclude, _paid_ok = parse_call(call)
    operators = " ".join([f"site:{host}" for host in include] + [f"-site:{host}" for host in exclude])
    if operators:
        query = f"{query} {operators}"
    return {
        "id": idx,
        "tool": SEARCH_WEB_TOOL,
        "q": query,
        "category": category,
        "time_range": time_range or None,
        "args": raw_args(call),
    }
