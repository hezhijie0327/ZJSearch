// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { NotebookPen } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";
import { Snippet } from "@/features/results/cardParts.tsx";
import { escapeHtml } from "@/lib/print.ts";
import { CHIP } from "@/lib/styles.ts";

interface LedgerArgFact {
  text?: unknown;
  tags?: unknown;
}

/** The findings view: the recorded facts fold open (the measured-clamp
    snippet per fact, accent-marked, the fact's concept tags as meta
    chips); the settled metric is the fact count the settlement carried. */
export const recordFindingsView: ToolView = {
  Icon: NotebookPen,
  label: ({ t }) => t("ai_learnings_row"),
  metric: ({ call, t }) =>
    call.status === "pending"
      ? t("ai_learnings_running")
      : call.status === "ok"
        ? t("ai_learnings_done", { n: String(call.n ?? factCount(call)) })
        : null,
  Content: ({ call }) => {
    const list = (call.args?.facts as LedgerArgFact[] | undefined) ?? [];
    if (!list.length) {
      return null;
    }
    return (
      <ul className="space-y-1 rounded-lg bg-surface-2/50 px-2.5 py-2">
        {list.map((fact, index) => {
          const tags = Array.isArray(fact.tags)
            ? fact.tags
                .map((tag) => String(tag ?? "").trim())
                .filter(Boolean)
                .slice(0, 3)
            : [];
          return (
            <li className="flex items-start gap-2" key={index}>
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent/70" />
              <div className="min-w-0 flex-1">
                <Snippet
                  contentHtml={escapeHtml(String(fact.text ?? ""))}
                  textClass="text-[13px] leading-relaxed text-ink-2"
                />
                {tags.length ? (
                  <span className="mt-1 flex flex-wrap gap-1 text-xs text-ink-3">
                    {tags.map((tag) => (
                      <span className={CHIP} key={tag}>
                        {tag}
                      </span>
                    ))}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    );
  },
  expandable: ({ call }) => factCount(call) > 0,
};

function factCount(call: Parameters<ToolView["metric"]>[0]["call"]): number {
  const facts = call.args?.facts;
  return Array.isArray(facts) ? facts.length : 0;
}
