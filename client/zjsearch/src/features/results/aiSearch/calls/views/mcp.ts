// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Plug } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The MCP view: the server-scoped tool name (the discovery call shows
    the keyword it searched the inventory for). */
export const mcpView: ToolView = {
  Icon: Plug,
  label: ({ call, t }) =>
    call.name === "search_tools"
      ? `${t("ai_mcp_search_row")}${call.q ? `: ${call.q}` : ""}`
      : (call.name?.replace(/^mcp_/, "").replace(/_/g, " ") ?? t("ai_mcp_tool")),
  metric: ({ call, t }) =>
    call.status === "pending" ? t("ai_mcp_running") : call.status === "ok" ? t("ai_mcp_done") : null,
};
