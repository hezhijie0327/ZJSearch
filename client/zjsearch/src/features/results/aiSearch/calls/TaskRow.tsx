// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ListTodo } from "lucide-react";
import { useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import { CallRowShell, DebugArgs, rawArgsOf, settledCallText } from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { AiSearchCall, AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";

/** The task_write row: the rendered PLAN ITEMS (the call's result -- the
    same status-mark + title rows the rail's plan card shows) fold open
    under the chevron; the bug chip reveals the raw arguments.  The plan
    itself also renders as the rail's task card -- the row is the
    in-timeline record of the write. */
export function TaskRow({ call, results: _results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [debug, setDebug] = useState(false);
  const rawArgs = rawArgsOf(call);
  const items = (Array.isArray(call.args?.items) ? call.args.items : []) as Array<{
    title?: unknown;
    status?: unknown;
  }>;
  const expandable = items.length > 0;
  const debuggable = rawArgs !== null;
  return (
    <div>
      <CallRowShell
        call={call}
        debuggable={debuggable}
        debugOpen={debug}
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
          {items.map((item, index) => {
            const status = String(item.status ?? "pending");
            const done = status === "done";
            return (
              <li className="flex items-start gap-2 text-[13px]" key={index}>
                <span
                  aria-hidden="true"
                  className={`mt-2 size-1.5 shrink-0 rounded-full ${done ? "bg-ok" : status === "active" ? "bg-accent" : "bg-ink-3/50"}`}
                />
                <span className={`min-w-0 flex-1 break-words ${done ? "text-ink-3" : "text-ink"}`} dir="auto">
                  {String(item.title ?? "")}
                </span>
              </li>
            );
          })}
        </ul>
      </Collapse>
    </div>
  );
}
