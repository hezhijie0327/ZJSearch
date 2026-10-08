// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";
import { askUserView } from "@/features/results/aiSearch/calls/views/askUser.tsx";
import { calculatorView } from "@/features/results/aiSearch/calls/views/calculator.tsx";
import { extractTableView } from "@/features/results/aiSearch/calls/views/extractTable.tsx";
import { judgeView } from "@/features/results/aiSearch/calls/views/judge.tsx";
import { learningsView } from "@/features/results/aiSearch/calls/views/learnings.tsx";
import { mcpView } from "@/features/results/aiSearch/calls/views/mcp.ts";
import { memoryView } from "@/features/results/aiSearch/calls/views/memory.tsx";
import { pastResearchView } from "@/features/results/aiSearch/calls/views/pastResearch.ts";
import { researchSubtaskView } from "@/features/results/aiSearch/calls/views/researchSubtask.ts";
import { tasksView } from "@/features/results/aiSearch/calls/views/tasks.tsx";
import { viewImageView } from "@/features/results/aiSearch/calls/views/viewImage.tsx";
import { webBrowserView } from "@/features/results/aiSearch/calls/views/webBrowser.tsx";
import { webReaderView } from "@/features/results/aiSearch/calls/views/webReader.tsx";
import { webSearchView } from "@/features/results/aiSearch/calls/views/webSearch.ts";
import type { AiSearchCall } from "@/features/results/aiSearch/useAiSearch.ts";

/**
 * The settlement-view registry: ONE entry per tool kind, mirroring the
 * server's tool registry (tools/__init__.py) -- adding a tool is one
 * view + one entry here.  Unknown tools fall back to the search view's
 * shape (the honest default: query + count + result cards).
 */
export const TOOL_VIEWS: Record<AiSearchCall["tool"], ToolView> = {
  web_search: webSearchView,
  web_reader: webReaderView,
  web_browser: webBrowserView,
  calculator: calculatorView,
  task_write: tasksView,
  learnings: learningsView,
  ask_user: askUserView,
  judge: judgeView,
  user_memory: memoryView,
  past_research: pastResearchView,
  mcp: mcpView,
  extract_table: extractTableView,
  view_image: viewImageView,
  research_subtask: researchSubtaskView,
};
