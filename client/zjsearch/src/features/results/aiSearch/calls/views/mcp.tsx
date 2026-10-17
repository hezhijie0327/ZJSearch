// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Plug } from "lucide-react";
import { CAP_CHIP_CLASS, CapChip } from "@/components/CapChip.tsx";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";
import type { AiToolMatch } from "@/features/results/aiSearch/timeline.ts";
import { useT } from "@/lib/i18n.ts";
import { useCapExpand } from "@/lib/useCapExpand.ts";

/** The MCP view: the server-scoped tool name (the discovery call shows
    the keyword it searched the inventory for -- the inventory covers the
    external MCP servers AND the run's own disclosed niche tools).  The
    discovery row's expansion renders the MATCHED TOOLS as cards in the
    engine-inventory's directory language: name + source badge, the
    description line, the parameter names, and the tool's own doctrine
    in a reading pane.  No-match and legacy replays keep the plain-text
    feed fallback. */
export const mcpView: ToolView = {
  Icon: Plug,
  label: ({ call, t }) =>
    call.name === "search_tools"
      ? `${t("ai_mcp_search_row")}${call.q ? `: ${call.q}` : ""}`
      : (call.name?.replace(/^mcp_/, "").replace(/_/g, " ") ?? t("ai_mcp_tool")),
  metric: ({ call, t }) =>
    call.status === "pending"
      ? t("ai_mcp_running")
      : call.status === "ok"
        ? call.tools
          ? t("ai_toolmatch_done", { n: String(call.tools.length) })
          : t("ai_mcp_done")
        : null,
  Content: ({ call }) => (call.tools?.length ? <ToolMatches tools={call.tools} /> : null),
};

const CELL = "min-w-0 rounded-md bg-surface-2/60 px-2 py-1.5";

function ToolMatches({ tools }: { tools: AiToolMatch[] }) {
  const t = useT();
  const CAP = 3;
  const { expanded, toggle, hidden } = useCapExpand(tools.length, CAP);
  const shown = expanded ? tools : tools.slice(0, CAP);
  return (
    <div className="flex flex-col gap-1.5">
      {shown.map((tool) => (
        <div className={CELL} key={tool.name}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-medium text-ink">{tool.name}</span>
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs ${
                tool.server ? "bg-accent-soft text-accent" : "bg-surface text-ink-3"
              }`}
            >
              {tool.server || t("ai_toolmatch_builtin")}
            </span>
          </div>
          {tool.description ? <p className="mt-1 text-[13px] leading-snug text-ink-2">{tool.description}</p> : null}
          {tool.params.length > 0 ? (
            <p className="mt-1 text-xs text-ink-3">
              {t("ai_toolmatch_params", { params: tool.params.join(", ") })}
              {tool.required.length > 0 ? (
                <>
                  {" · "}
                  {t("ai_toolmatch_required", { names: tool.required.join(", ") })}
                </>
              ) : null}
            </p>
          ) : null}
          {tool.instructions ? (
            <p className="mt-1 whitespace-pre-wrap rounded-md bg-surface-2/50 p-2 text-xs leading-relaxed text-ink-3">
              {tool.instructions}
            </p>
          ) : null}
        </div>
      ))}
      {hidden > 0 ? <CapChip className={CAP_CHIP_CLASS} expanded={expanded} hidden={hidden} onToggle={toggle} /> : null}
    </div>
  );
}
