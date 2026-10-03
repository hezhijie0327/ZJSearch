// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Plug } from "lucide-react";
import { useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import {
  CallContent,
  CallResults,
  CallRowShell,
  DebugPanes,
  rawArgsOf,
  settledCallText,
} from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { AiSearchCall, AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";

/** The MCP row: the server-scoped tool label (the `mcp_` namespace
    stripped, underscores spelled out; the discovery tool keeps its
    keyword query); a settled row with returned content opens it as a
    reading pane (the shared hasText rule), otherwise it falls through to
    the args/receipt/results body. */
export function McpRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [debug, setDebug] = useState(false);
  const rawArgs = rawArgsOf(call);
  const hasText = Boolean(call.text);
  // the chevron reveals the rendered result (reading pane / result
  // cards); the bug reveals the arguments and the receipt
  const expandable = hasText ? true : results.length > 0;
  const debuggable = rawArgs !== null || Boolean(call.feed);
  return (
    <div>
      <CallRowShell
        call={call}
        debuggable={debuggable}
        debugOpen={debug}
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
        onToggleDebug={() => {
          setDebug(!debug);
        }}
        open={open}
      />
      <Collapse className={debug ? "mt-1" : ""} open={debug && debuggable}>
        <DebugPanes call={call} rawArgs={rawArgs} />
      </Collapse>
      <Collapse className={open ? "mt-1" : ""} open={open && expandable}>
        {hasText ? <CallContent call={call} /> : <CallResults results={results} />}
      </Collapse>
    </div>
  );
}
