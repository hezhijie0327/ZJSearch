// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Calculator } from "lucide-react";
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

/** The calculator row: the expression, the `= result` metric, and an
    expansion of the raw arguments only (a calculation never carries
    result cards, so the shared expandable formula's first disjunct is
    false for it -- the args are the sole fold trigger). */
export function CalcRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rawArgs = rawArgsOf(call);
  const expandable = rawArgs !== null;
  return (
    <div>
      <CallRowShell
        call={call}
        expandable={expandable}
        icon={<Calculator aria-hidden="true" className="size-3 shrink-0" />}
        label={call.q}
        metric={
          call.status === "pending"
            ? t("ai_calc_running")
            : call.status === "ok"
              ? `= ${call.result ?? "?"}`
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
