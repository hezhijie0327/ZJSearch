// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookUser } from "lucide-react";
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

/** The user_memory row: the save/search action + its label; a settled
    row with returned content opens it as a reading pane (the shared
    hasText rule), otherwise it falls through to the args/results body. */
export function MemoryRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
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
        icon={<BookUser aria-hidden="true" className="size-3 shrink-0" />}
        label={`${call.name === "save" ? t("ai_memory_save") : t("ai_memory_search")}${call.label ? `: ${call.label}` : ""}`}
        metric={
          call.status === "pending" ? t("ai_memory_running") : call.status === "ok" ? "" : settledCallText(call, t)
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
