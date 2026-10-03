// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { NotebookPen } from "lucide-react";
import { useState } from "react";
import { CallRowShell, DebugPanes, rawArgsOf, settledCallText } from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { AiSearchCall } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";

/** The learnings row: the ledger-write label and the recorded-fact count;
    its expansion is the raw arguments + the model receipt (the facts
    render as the findings card, never inside the row -- the shared
    expandable formula excludes result cards for it, so the row takes no
    results at all). */
export function LearningsRow({ call }: { call: AiSearchCall }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rawArgs = rawArgsOf(call);
  const expandable = rawArgs !== null || Boolean(call.feed);
  return (
    <div>
      <CallRowShell
        call={call}
        expandable={expandable}
        icon={<NotebookPen aria-hidden="true" className="size-3 shrink-0" />}
        label={t("ai_learnings_row")}
        metric={
          call.status === "pending"
            ? t("ai_learnings_running")
            : call.status === "ok"
              ? t("ai_learnings_done", { n: String(call.n ?? 0) })
              : settledCallText(call, t)
        }
        onToggle={() => {
          setOpen(!open);
        }}
        open={open}
      />
      {open && expandable ? <DebugPanes call={call} rawArgs={rawArgs} /> : null}
    </div>
  );
}
