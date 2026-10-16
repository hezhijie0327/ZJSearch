// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Check, CircleAlert, CircleStop } from "lucide-react";
import type { AiSearchStage } from "@/features/results/aiSearch/timeline.ts";
import { useT } from "@/lib/i18n.ts";

const ORDER: readonly AiSearchStage[] = ["ideate", "plan", "research", "write"];

const LABELS: Record<AiSearchStage, "ai_phase_ideate" | "ai_phase_plan" | "ai_phase_research" | "ai_phase_write"> = {
  ideate: "ai_phase_ideate",
  plan: "ai_phase_plan",
  research: "ai_phase_research",
  write: "ai_phase_write",
};

/**
 * The run's macro-stage spine (plan → research → write): ONE strip under the
 * run title, the task card's own status language at strip scale --
 * done = check, active = the accent ping, pending = the hollow dot.
 * ``done`` (the run settled) turns EVERY segment green.  Hidden entirely
 * when the run carries no phase events (legacy threads); the timeline
 * below remains the full record, this only tells the user where in the
 * research they are.
 */
export type PhaseStripState = "streaming" | "done" | "stopped" | "error" | "awaiting";

export function PhaseStrip({
  stage,
  state = "streaming",
}: {
  stage?: AiSearchStage;
  /** streaming = live;done = all green;stopped/error = reached segments
      green + the current segment warned (a halt is not completion -- all
      green would lie);awaiting = parked on the current segment */
  state?: PhaseStripState;
}) {
  const t = useT();
  if (!stage) {
    return null;
  }
  const done = state === "done";
  const failed = state === "stopped" || state === "error";
  // only a SETTLED run paints every segment green; a stopped/errored one
  // keeps its real position -- the segments before it read done, the
  // segment it died in wears the warning icon (a halt is not completion --
  // all green would lie)
  // the ideate run's strip is ITS OWN single segment -- rendering the
  // three-segment research spine with two dead segments would read as a
  // search that never searched
  const order = stage === "ideate" ? (["ideate"] as readonly AiSearchStage[]) : ORDER;
  const active = done ? order.length : order.indexOf(stage);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs" role="status">
      {order.map((name, index) => {
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
