// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { NotebookPen } from "lucide-react";
import { useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import { CallRowShell, DebugArgs, rawArgsOf, settledCallText } from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { AiSearchCall } from "@/features/results/aiSearch/useAiSearch.ts";
import { Snippet } from "@/features/results/cardParts.tsx";
import { useT } from "@/lib/i18n.ts";
import { escapeHtml } from "@/lib/print.ts";

/** The learnings row: the recorded FACTS fold open under the chevron --
    the call's rendered result, one clamped line each (the ledger's full
    history renders as the rail's findings card); the bug chip reveals
    the raw arguments. */
export function LearningsRow({ call }: { call: AiSearchCall }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [debug, setDebug] = useState(false);
  const rawArgs = rawArgsOf(call);
  const facts = (Array.isArray(call.args?.facts) ? call.args.facts : []) as Array<{ text?: unknown }>;
  const expandable = facts.length > 0;
  const debuggable = rawArgs !== null;
  return (
    <div>
      <CallRowShell
        call={call}
        debuggable={debuggable}
        debugOpen={debug}
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
        onToggleDebug={() => {
          setDebug(!debug);
        }}
        open={open}
      />
      <Collapse className={debug ? "mt-1" : ""} open={debug && debuggable}>
        {debuggable ? <DebugArgs rawArgs={rawArgs} /> : null}
      </Collapse>
      <Collapse className={open ? "mt-1" : ""} open={open && expandable}>
        <ul className={`space-y-1 bg-surface-2/50 px-2.5 py-2`}>
          {facts.map((fact, index) => (
            <li className="flex items-start gap-2" key={index}>
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent/70" />
              <div className="min-w-0 flex-1">
                <Snippet
                  contentHtml={escapeHtml(String(fact.text ?? ""))}
                  textClass="text-[13px] leading-relaxed text-ink-2"
                />
              </div>
            </li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
}
