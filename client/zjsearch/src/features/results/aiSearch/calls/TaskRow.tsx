// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ListTodo } from "lucide-react";
import { useState } from "react";
import { CallRowShell, DebugArgs, rawArgsOf, settledCallText } from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { AiSearchCall, AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";

/** The task_write row: the plan-write label and the settled plan line;
    its only expansion is the raw arguments (the plan itself renders as
    the task card above the timeline, never inside the row). */
export function TaskRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rawArgs = rawArgsOf(call);
  const expandable = results.length > 0 || rawArgs !== null;
  return (
    <div>
      <CallRowShell
        call={call}
        expandable={expandable}
        icon={<ListTodo aria-hidden="true" className="size-3 shrink-0" />}
        label={t("ai_task_row")}
        metric={
          call.status === "pending"
            ? t("ai_task_writing")
            : call.status === "ok"
              ? (call.q ?? "")
              : settledCallText(call, t)
        }
        onToggle={() => {
          setOpen(!open);
        }}
        open={open}
      />
      {open && expandable ? rawArgs ? <DebugArgs rawArgs={rawArgs} /> : null : null}
    </div>
  );
}
