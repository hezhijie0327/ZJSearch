// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useEffect, useState } from "react";
import type { AiSearchStep } from "@/features/results/aiSearch/timeline.ts";
import type { AiSearchState } from "@/features/results/aiSearch/useAiSearch.ts";

/** One sent-but-maybe-not-yet-delivered steering message (the composer's
    pending chip): "pending" while the run host hasn't confirmed, "failed"
    when it rejected the steer (unknown run, guide-lane queue full).  A
    matching `steer` step in the timeline (drained OR discarded) retires
    the chip -- the record itself shows what happened. */
export interface AiSteerChip {
  text: string;
  state: "pending" | "failed";
}

/** The composer's steer lane: send steers against the live run and track
    their pending chips until the wire's own `steer` events retire them. */
export function useAiSteer(aiSearch: AiSearchState) {
  const [chips, setChips] = useState<AiSteerChip[]>([]);

  // retirement + cleanup: a folded steer step retires its chip; leaving
  // the streaming phase (settle / error / stop) clears whatever is left
  useEffect(() => {
    const last = aiSearch.runs[aiSearch.runs.length - 1];
    const delivered = new Set(
      (last?.steps ?? [])
        .filter((step): step is Extract<AiSearchStep, { kind: "steer" }> => step.kind === "steer")
        .map((step) => step.text),
    );
    setChips((prev) => {
      const alive = prev.filter((chip) => !delivered.has(chip.text));
      if (aiSearch.phase !== "streaming") {
        return alive.length && alive.every((chip) => chip.state === "failed") ? alive : [];
      }
      return alive;
    });
  }, [aiSearch.runs, aiSearch.phase]);

  const send = (text: string, preempt = false): void => {
    const value = text.trim();
    if (!value || aiSearch.phase !== "streaming") {
      return;
    }
    setChips((prev) =>
      prev.some((chip) => chip.text === value) ? prev : [...prev, { text: value, state: "pending" }],
    );
    void aiSearch.steer(value, preempt).then((ok) => {
      if (!ok) {
        setChips((prev) => prev.map((chip) => (chip.text === value ? { ...chip, state: "failed" } : chip)));
      }
    });
  };

  const retract = (text: string): void => {
    setChips((prev) => prev.filter((chip) => chip.text !== text));
  };

  return { chips, send, retract };
}
