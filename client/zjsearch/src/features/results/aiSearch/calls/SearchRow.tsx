// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Search } from "lucide-react";
import { useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import {
  CallResults,
  CallRowShell,
  DebugPanes,
  rawArgsOf,
  settledCallText,
} from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { AiSearchCall, AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";

/** The web_search row (and the unknown-tool fallback): the query, the
    result count, and an expansion of raw arguments + the model receipt +
    the result-card strip.  Also the DEFAULT branch: every tool without a
    row of its own lands here (a search-shaped row is the honest
    fallback). */
export function SearchRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // the debug panes (raw arguments, the model's receipt, the timing) ride
  // their OWN toggle -- the chevron shows the rendered result, the bug
  // shows how it was made
  const [debug, setDebug] = useState(false);
  const rawArgs = rawArgsOf(call);
  // a search row never carries call text -- the chevron's fold trigger
  // is the result cards; the raw arguments and the receipt ride the bug
  const expandable = results.length > 0;
  const debuggable = rawArgs !== null || Boolean(call.feed);
  return (
    <div>
      <CallRowShell
        call={call}
        debuggable={debuggable}
        debugOpen={debug}
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
        onToggleDebug={() => {
          setDebug(!debug);
        }}
        open={open}
      />
      <Collapse className={debug ? "mt-1" : ""} open={debug && debuggable}>
        <DebugPanes call={call} rawArgs={rawArgs} />
      </Collapse>
      <Collapse className={open ? "mt-1" : ""} open={open && expandable}>
        <CallResults results={results} />
      </Collapse>
    </div>
  );
}
