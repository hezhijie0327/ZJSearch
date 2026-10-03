// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronDown, Scale } from "lucide-react";
import { useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import type { AiDecision } from "@/features/results/aiSearch/timeline.ts";
import { useT } from "@/lib/i18n.ts";

const PURPOSE_LABELS: Record<string, string> = {
  sources_gate: "ai_dec_sources_gate",
  read_gate: "ai_dec_read_gate",
  plan_review: "ai_dec_plan_review",
  judge: "ai_dec_judge",
  audit: "ai_dec_audit",
};

/**
 * The run's DECISION RESULTS card (决策结果): EVERY decision-model call --
 * loop gates (feed 4-noul / read gate / plan review) and the model's own
 * judge tool -- one row each.  A row shows purpose + target + the verdict
 * head; CLICK expands the raw record: the full question asked and the raw
 * model answer (verdicts with probabilities) -- 问题与结果都可溯源.
 */
export function DecisionsCard({ decisions }: { decisions: AiDecision[] }) {
  const t = useT();
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  if (decisions.length === 0) {
    return null;
  }
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2">
        <Scale aria-hidden="true" className="size-4.5 shrink-0 text-ink-3" />
        <h3 className="text-base font-semibold text-ink">{t("ai_decisions_card")}</h3>
        <span className="shrink-0 text-xs tabular-nums text-ink-3">{decisions.length}</span>
      </div>
      <ul className="mt-3 space-y-1">
        {decisions.map((decision, index) => {
          const label = PURPOSE_LABELS[decision.purpose] ?? "ai_decisions_card";
          const expanded = openIdx === index;
          return (
            <li key={index}>
              <button
                aria-expanded={expanded}
                className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-xs transition-colors hover:bg-surface-2/50"
                onClick={() => {
                  setOpenIdx(expanded ? null : index);
                }}
                type="button"
              >
                <span className="shrink-0 rounded-md bg-accent-soft px-1.5 text-[11px] leading-4 text-accent">
                  {t(label as "ai_dec_judge")}
                </span>
                <span className="min-w-0 flex-1 truncate text-start text-ink-2" dir="auto">
                  {decision.target || decision.question || decision.purpose}
                </span>
                {decision.ms ? (
                  <span className="shrink-0 font-mono tabular-nums text-ink-3">{decision.ms}ms</span>
                ) : null}
                <ChevronDown
                  aria-hidden="true"
                  className={`size-3 shrink-0 text-ink-3 transition-transform ${expanded ? "rotate-180" : ""}`}
                />
              </button>
              <Collapse className={expanded ? "mt-1" : ""} open={expanded}>
                <div className="rounded-lg bg-surface-2/50 px-2.5 py-2 text-xs leading-relaxed">
                  {decision.question ? (
                    <p className="break-words text-ink-2" dir="auto">
                      <span className="text-ink-3">{t("ai_dec_question")}: </span>
                      {decision.question}
                    </p>
                  ) : null}
                  {decision.answer !== undefined ? (
                    <>
                      <p className="mt-1.5 text-ink-3">{t("ai_dec_raw")}:</p>
                      <pre
                        className="mt-1 max-h-40 overflow-y-auto overscroll-contain break-words whitespace-pre-wrap break-words text-[11px] text-ink-2"
                        dir="ltr"
                      >
                        {JSON.stringify(decision.answer, null, 2)}
                      </pre>
                    </>
                  ) : null}
                </div>
              </Collapse>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
