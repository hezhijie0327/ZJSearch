// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Search } from "lucide-react";
import { useState } from "react";
import {
  CallResults,
  CallRowShell,
  DebugArgs,
  rawArgsOf,
  settledCallText,
} from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { AiSearchCall, AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";

/** The web_search row (and the unknown-tool fallback): the query, the
    result count, and an expansion of raw arguments + the result-card
    strip.  Also the DEFAULT branch: every tool without a row of its own
    lands here (a search-shaped row is the honest fallback). */
export function SearchRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rawArgs = rawArgsOf(call);
  // a search row never carries call text -- its fold triggers are the
  // result cards and the raw arguments
  const expandable = results.length > 0 || rawArgs !== null;
  return (
    <div>
      <CallRowShell
        call={call}
        expandable={expandable}
        icon={<Search aria-hidden="true" className="size-3 shrink-0" />}
        label={call.q}
        metric={
          call.status === "pending"
            ? t("ai_search_running")
            : call.status === "ok"
              ? t("ai_search_results", { n: String(call.n ?? 0) })
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
          <CallResults results={results} />
        </>
      ) : null}
    </div>
  );
}
