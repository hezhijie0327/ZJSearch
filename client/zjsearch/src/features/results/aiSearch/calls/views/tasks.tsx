// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ListTodo } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The task_write view: the rendered PLAN ITEMS fold open under the
    chevron (the same status-dot + title rows the rail's plan card
    shows); the settled metric is the done/total counter -- the raw plan
    query never sits in the numeric slot. */
export const tasksView: ToolView = {
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
      <ul className="space-y-1 rounded-lg bg-surface-2/50 px-2.5 py-2">
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
    );
  },
  expandable: ({ call }) => taskItems(call).length > 0,
};

function taskItems(call: Parameters<ToolView["metric"]>[0]["call"]): Array<{ title?: unknown; status?: unknown }> {
  return (Array.isArray(call.args?.items) ? call.args.items : []) as Array<{ title?: unknown; status?: unknown }>;
}
