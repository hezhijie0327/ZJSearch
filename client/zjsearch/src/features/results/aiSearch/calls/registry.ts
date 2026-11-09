// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";
import { askUserView } from "@/features/results/aiSearch/calls/views/askUser.tsx";
import { browseView } from "@/features/results/aiSearch/calls/views/browse.tsx";
import { buildTableView } from "@/features/results/aiSearch/calls/views/buildTable.tsx";
import { calculateView } from "@/features/results/aiSearch/calls/views/calculate.tsx";
import { delegateResearchView } from "@/features/results/aiSearch/calls/views/delegateResearch.ts";
import { evaluateView } from "@/features/results/aiSearch/calls/views/evaluate.tsx";
import { inspectImageView } from "@/features/results/aiSearch/calls/views/inspectImage.tsx";
import { listEnginesView } from "@/features/results/aiSearch/calls/views/listEngines.tsx";
import { mcpView } from "@/features/results/aiSearch/calls/views/mcp.tsx";
import { memoryView } from "@/features/results/aiSearch/calls/views/memory.tsx";
import { messageSubtaskView } from "@/features/results/aiSearch/calls/views/messageSubtask.ts";
import { recallHistoryView } from "@/features/results/aiSearch/calls/views/recallHistory.tsx";
import { recordFindingsView } from "@/features/results/aiSearch/calls/views/recordFindings.tsx";
import { searchWebView } from "@/features/results/aiSearch/calls/views/searchWeb.ts";
import { setDeliverableView } from "@/features/results/aiSearch/calls/views/setDeliverable.tsx";
import { updatePlanView } from "@/features/results/aiSearch/calls/views/updatePlan.tsx";
import type { AiSearchCall } from "@/features/results/aiSearch/useAiSearch.ts";

/**
 * The settlement-view registry: ONE entry per tool kind, mirroring the
 * server's tool registry (tools/__init__.py) -- adding a tool is one
 * view + one entry here.  Unknown tools fall back to the search view's
 * shape (the honest default: query + count + result cards).
 */
export const TOOL_VIEWS: Record<AiSearchCall["tool"], ToolView> = {
  search_web: searchWebView,
  browse: browseView,
  calculate: calculateView,
  update_plan: updatePlanView,
  record_findings: recordFindingsView,
  ask_user: askUserView,
  evaluate: evaluateView,
  memory: memoryView,
  recall_history: recallHistoryView,
  list_engines: listEnginesView,
  mcp: mcpView,
  build_table: buildTableView,
  inspect_image: inspectImageView,
  delegate_research: delegateResearchView,
  message_subtask: messageSubtaskView,
  set_deliverable: setDeliverableView,
};
