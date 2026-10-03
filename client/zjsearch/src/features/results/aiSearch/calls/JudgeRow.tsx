// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Scale } from "lucide-react";
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

/** The judge (SystemOne decision) row: the question and the settled
    verdict; a settled row with returned content opens it as a reading
    pane (the shared hasText rule), otherwise it falls through to the
    args/receipt/results body. */
export function JudgeRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
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
        icon={<Scale aria-hidden="true" className="size-3 shrink-0" />}
        label={call.q || t("ai_decision_row")}
        metric={
          call.status === "pending"
            ? t("ai_decision_running")
            : call.status === "ok"
              ? (call.result ?? "")
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
