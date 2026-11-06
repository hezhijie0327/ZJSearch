// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookUser } from "lucide-react";
import type { ReactNode } from "react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";
import type { Translate } from "@/lib/i18n.ts";

/** The memory view -- one row per v2 action, the CRUD the store executes:
    search (query + its hits as the accent-dot list), save (fact or
    procedure), update (the old wording above the corrected one), forget
    (what left), reinforce (the quiet re-observation).  The settled
    metric names the outcome; the search recall renders as the SAME
    accent-dot list as the findings row -- they are both "what the run
    got back, itemized", not machine prose. */

type MemoryAction = "search" | "save" | "update" | "forget" | "reinforce" | string;

function actionOf(call: { name?: string }): MemoryAction {
  return call.name ?? "search";
}

function labelKey(call: { name?: string; label?: string }, t: Translate) {
  switch (actionOf(call)) {
    case "save":
      return `${t("ai_memory_save")}${call.label ? `: ${call.label}` : ""}`;
    case "update":
      return `${t("ai_memory_update")}${call.label ? `: ${call.label}` : ""}`;
    case "forget":
      return `${t("ai_memory_forget")}${call.label ? `: ${call.label}` : ""}`;
    case "reinforce":
      return `${t("ai_memory_reinforce")}${call.label ? `: ${call.label}` : ""}`;
    default:
      return `${t("ai_memory_search")}${call.label ? `: ${call.label}` : ""}`;
  }
}

/** The boxed two-line block (the search list's ground): update renders
    the superseded wording dimmed above the corrected one, forget shows
    what left. */
function OldNewBlock({ old, children }: { old: string; children?: ReactNode }) {
  return (
    <div className="space-y-1 rounded-lg bg-surface-2/50 px-2.5 py-2">
      <p className="flex items-start gap-2 text-[13px] text-ink-3" dir="auto">
        <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-3/50" />
        <span className="min-w-0 flex-1 break-words line-through decoration-ink-3/50">{old}</span>
      </p>
      {children}
    </div>
  );
}

export const memoryView: ToolView = {
  Icon: BookUser,
  label: ({ call, t }) => labelKey(call, t),
  metric: ({ call, t }) => {
    if (call.status === "pending") {
      return t("ai_memory_running");
    }
    if (call.status !== "ok") {
      return null;
    }
    switch (actionOf(call)) {
      case "save":
        return t("ai_memory_saved");
      case "update":
        return t("ai_memory_updated");
      case "forget":
        return t("ai_memory_forgot");
      case "reinforce":
        return t("ai_memory_reinforced");
      default:
        return (call.n ?? 0) > 0 ? t("ai_memory_hits", { n: String(call.n ?? 0) }) : null;
    }
  },
  Content: ({ call }) => {
    const action = actionOf(call);
    if (action === "update" || action === "forget") {
      // the touched row's OLD wording rides the settlement's preview --
      // the correction (update) renders dimmed-and-struck above the new
      const old = (call.text ?? "").trim();
      if (!old) {
        return null;
      }
      return (
        <OldNewBlock old={old}>
          {action === "update" ? (
            <p className="flex items-start gap-2 text-[13px]" dir="auto">
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent/70" />
              <span className="min-w-0 flex-1 break-words text-ink-2">{call.label}</span>
            </p>
          ) : null}
        </OldNewBlock>
      );
    }
    if (action === "reinforce") {
      // the quiet re-observation: nothing to expand
      return null;
    }
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
  expandable: ({ call }) => {
    if (actionOf(call) === "update" || actionOf(call) === "forget") {
      return Boolean((call.text ?? "").trim());
    }
    if (actionOf(call) === "reinforce") {
      return false;
    }
    return (call.text ?? "").split("\n").some((line) => line.trim());
  },
};
