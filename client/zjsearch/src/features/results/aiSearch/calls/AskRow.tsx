// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { CallRowShell, DebugArgs, rawArgsOf, settledCallText } from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { AiSearchCall, AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";

/** The ask_user row: the mid-research question (or the bare label); the
    answered questions render as the clarify archive segment, so the
    row's only expansion is the raw arguments. */
export function AskRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rawArgs = rawArgsOf(call);
  const expandable = results.length > 0 || rawArgs !== null;
  return (
    <div>
      <CallRowShell
        call={call}
        expandable={expandable}
        icon={<MessageCircleQuestion aria-hidden="true" className="size-3 shrink-0" />}
        label={call.q || t("ai_ask_row")}
        metric={call.status === "pending" ? t("ai_ask_awaiting") : call.status === "ok" ? "" : settledCallText(call, t)}
        onToggle={() => {
          setOpen(!open);
        }}
        open={open}
      />
      {open && expandable ? rawArgs ? <DebugArgs rawArgs={rawArgs} /> : null : null}
    </div>
  );
}
