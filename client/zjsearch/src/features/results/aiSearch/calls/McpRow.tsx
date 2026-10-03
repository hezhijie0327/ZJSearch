// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Plug } from "lucide-react";
import { useState } from "react";
import {
  CallContent,
  CallResults,
  CallRowShell,
  DebugArgs,
  rawArgsOf,
  settledCallText,
} from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { AiSearchCall, AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";

/** The MCP row: the server-scoped tool label (the `mcp_` namespace
    stripped, underscores spelled out; the discovery tool keeps its
    keyword query); a settled row with returned content opens it as a
    reading pane (the shared hasText rule), otherwise it falls through to
    the args/results body. */
export function McpRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rawArgs = rawArgsOf(call);
  const hasText = Boolean(call.text);
  const expandable = (hasText ? true : results.length > 0) || rawArgs !== null;
  return (
    <div>
      <CallRowShell
        call={call}
        expandable={expandable}
        icon={<Plug aria-hidden="true" className="size-3 shrink-0" />}
        label={
          call.name === "search_tools"
            ? `${t("ai_mcp_search_row")}${call.q ? `: ${call.q}` : ""}`
            : (call.name?.replace(/^mcp_/, "").replace(/_/g, " ") ?? t("ai_mcp_tool"))
        }
        metric={
          call.status === "pending"
            ? t("ai_mcp_running")
            : call.status === "ok"
              ? t("ai_mcp_done")
              : settledCallText(call, t)
        }
        onToggle={() => {
          setOpen(!open);
        }}
        open={open}
      />
      {open && expandable ? (
        <>
          {rawArgs ? <DebugArgs rawArgs={rawArgs} /> : null}
          {hasText ? <CallContent call={call} /> : <CallResults results={results} />}
        </>
      ) : null}
    </div>
  );
}
