// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Calculator } from "lucide-react";
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

/** The calculator row: the expression, the `= result` metric, and an
    expansion of the raw arguments + the model receipt (a calculation
    never carries result cards, so the shared expandable formula's first
    disjunct is false for it -- the args and the receipt are the fold
    triggers). */
export function CalcRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [debug, setDebug] = useState(false);
  const rawArgs = rawArgsOf(call);
  // the expression and its result sit in the row itself; the expansion is
  // debug material only (a calculation never carries result cards) -- no
  // chevron, just the bug
  const debuggable = rawArgs !== null || Boolean(call.feed);
  return (
    <div>
      <CallRowShell
        call={call}
        debuggable={debuggable}
        debugOpen={debug}
        expandable={false}
        icon={<Calculator aria-hidden="true" className="size-3 shrink-0" />}
        label={call.q}
        metric={
          call.status === "pending"
            ? t("ai_calc_running")
            : call.status === "ok"
              ? `= ${call.result ?? "?"}`
              : settledCallText(call, t)
        }
        onToggle={() => {}}
        onToggleDebug={() => {
          setDebug(!debug);
        }}
        open={false}
      />
      <Collapse className={debug ? "mt-1" : ""} open={debug && debuggable}>
        <DebugPanes call={call} rawArgs={rawArgs} />
      </Collapse>
      {results.length > 0 ? <CallResults results={results} /> : null}
    </div>
  );
}
