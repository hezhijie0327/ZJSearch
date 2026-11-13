// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Check, ListTodo } from "lucide-react";
import { BodyRow } from "@/features/results/aiSearch/calls/bodyParts.tsx";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The update_plan view: the rendered PLAN ITEMS fold open under the
    chevron (the same status-dot + title rows the rail's plan card
    shows); the settled metric is the done/total counter -- the raw plan
    query never sits in the numeric slot. */
export const updatePlanView: ToolView = {
  Icon: ListTodo,
  label: ({ t }) => t("ai_task_row"),
  metric: ({ call, t }) => {
    if (call.status === "pending") {
      return t("ai_task_writing");
    }
    if (call.status !== "ok") {
      return null;
    }
    const items = taskItems(call);
    const done = items.filter((item) => String(item.status ?? "") === "done").length;
    return `${done}/${items.length}`;
  },
  Content: ({ call }) => {
    const items = taskItems(call);
    if (!items.length) {
      return null;
    }
    return (
      // the search_web standard: each item its OWN elevated card (the
      // BODY_ROW vocabulary), the status glyph the task card speaks --
      // done = check, active = accent dot, pending = faint dot
      <ul className="space-y-1">
        {items.map((item, index) => {
          const status = String(item.status ?? "pending");
          const done = status === "done";
          return (
            <BodyRow className="flex items-start gap-2 text-[13px]" key={index}>
              {done ? (
                <Check aria-hidden="true" className="mt-px size-3.5 shrink-0 text-ok" />
              ) : (
                <span
                  aria-hidden="true"
                  className={`mt-1.5 size-1.5 shrink-0 rounded-full ${status === "active" ? "bg-accent" : "bg-ink-3/50"}`}
                />
              )}
              <span className={`min-w-0 flex-1 break-words ${done ? "text-ink-3" : "text-ink"}`} dir="auto">
                {String(item.title ?? "")}
              </span>
            </BodyRow>
          );
        })}
      </ul>
    );
  },
  expandable: ({ call }) => taskItems(call).length > 0,
};

function taskItems(call: Parameters<ToolView["metric"]>[0]["call"]): Array<{ title?: unknown; status?: unknown }> {
  return (Array.isArray(call.args?.items) ? call.args.items : []) as Array<{ title?: unknown; status?: unknown }>;
}
