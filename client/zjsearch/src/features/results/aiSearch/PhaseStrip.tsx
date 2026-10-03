// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Check, CircleAlert, CircleStop } from "lucide-react";
import type { AiSearchStage } from "@/features/results/aiSearch/timeline.ts";
import { useT } from "@/lib/i18n.ts";

const ORDER: readonly AiSearchStage[] = ["plan", "research", "write", "audit"];

const LABELS: Record<AiSearchStage, "ai_phase_plan" | "ai_phase_research" | "ai_phase_write" | "ai_phase_audit"> = {
  plan: "ai_phase_plan",
  research: "ai_phase_research",
  write: "ai_phase_write",
  audit: "ai_phase_audit",
};

/**
 * The run's macro-stage spine (规划 → 检索 → 撰写 → 核验): ONE strip under
 * the run title, the task card's own status language at strip scale --
 * done = check, active = the accent ping, pending = the hollow dot.
 * ``done`` (the run settled) turns EVERY segment green -- the spine ends
 * honestly instead of blinking 核验 forever.  ``verifying`` (the audit's
 * citation count) labels the active audit segment with its workload.
 * Hidden entirely when the run carries no phase events (legacy threads);
 * the timeline below remains the full record, this only tells the user
 * where in the research they are.
 */
export type PhaseStripState = "streaming" | "done" | "stopped" | "error" | "awaiting";

export function PhaseStrip({
  stage,
  state = "streaming",
}: {
  stage?: AiSearchStage;
  /** streaming = 实时;done = 全绿;stopped/error = 已达段绿 + 当前段警示
      (终止不是完成,全绿会撒谎);awaiting = 停在当前段等待 */
  state?: PhaseStripState;
}) {
  const t = useT();
  if (!stage) {
    return null;
  }
  const done = state === "done";
  const failed = state === "stopped" || state === "error";
  const active = done || failed ? ORDER.length : ORDER.indexOf(stage);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs" role="status">
      {ORDER.map((name, index) => {
        const isDone = done || (failed && index < active);
        const isFailedCurrent = failed && index === active;
        const isActive = !done && !failed && index === active;
        const label = t(LABELS[name]);
        return (
          <span className="flex items-center gap-1.5" key={name}>
            {index > 0 ? <span aria-hidden="true" className="h-3 w-px bg-line" /> : null}
            {isDone ? (
              <Check aria-hidden="true" className="size-3 shrink-0 text-ok" />
            ) : isFailedCurrent ? (
              state === "error" ? (
                <CircleAlert aria-hidden="true" className="size-3 shrink-0 text-warning" />
              ) : (
                <CircleStop aria-hidden="true" className="size-3 shrink-0 text-warning" />
              )
            ) : isActive ? (
              <span className="relative flex size-3 shrink-0 items-center justify-center">
                <span aria-hidden="true" className="absolute size-3 animate-ping rounded-full bg-accent/40" />
                <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
              </span>
            ) : (
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-ink-3/50" />
            )}
            <span
              className={`whitespace-nowrap ${isDone ? "text-ink-3" : isActive ? "font-medium text-accent" : isFailedCurrent ? "text-warning" : "text-ink-3"}`}
            >
              {label}
            </span>
          </span>
        );
      })}
    </div>
  );
}
