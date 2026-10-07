// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookUser } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The user_memory view: the save/search action + its label; a settled
    save shows 已保存, a search its hit count (the old empty metric --
    and its orphan `· time` separator -- is gone).  The search recall
    renders as the SAME accent-dot list as the findings row -- they are
    both "what the run got back, itemized", not machine prose. */
export const memoryView: ToolView = {
  Icon: BookUser,
  label: ({ call, t }) =>
    `${call.name === "save" ? t("ai_memory_save") : t("ai_memory_search")}${call.label ? `: ${call.label}` : ""}`,
  metric: ({ call, t }) => {
    if (call.status === "pending") {
      return t("ai_memory_running");
    }
    if (call.status !== "ok") {
      return null;
    }
    if (call.name === "save") {
      return t("ai_memory_saved");
    }
    return (call.n ?? 0) > 0 ? t("ai_memory_hits", { n: String(call.n ?? 0) }) : null;
  },
  Content: ({ call }) => {
    // the recall lines (server's search_memories output, "- content" per
    // line) as an accent-dot list -- Record findings' twin
    const lines = (call.text ?? "")
      .split("\n")
      .map((line) => line.replace(/^-\s*/, "").trim())
      .filter(Boolean);
    if (!lines.length) {
      return null;
    }
    return (
      <ul className="space-y-1 rounded-lg bg-surface-2/50 px-2.5 py-2">
        {lines.map((line, index) => (
          <li className="flex items-start gap-2 text-[13px]" key={index}>
            <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent/70" />
            <span className="min-w-0 flex-1 break-words text-ink-2" dir="auto">
              {line}
            </span>
          </li>
        ))}
      </ul>
    );
  },
  expandable: ({ call }) => (call.text ?? "").split("\n").some((line) => line.trim()),
};
