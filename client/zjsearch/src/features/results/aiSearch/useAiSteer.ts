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
      // identity-stable while streaming when nothing retired (this effect
      // re-runs on every wire fold -- a fresh array each time would
      // re-render the composer area on every streamed delta for no
      // visible change); the settle/stop clear below must still run
      if (aiSearch.phase === "streaming" && alive.length === prev.length) {
        return prev;
      }
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

  /** The drag order: the queue's visual permutation commits here, and
      ONLY the pending chips' new relative order posts -- failed chips
      never entered the host's guide lane, so their texts must not ride
      the reorder (the endpoint validates against the live queue and a
      stale view answers false: the pre-drag order stands). */
  const reorder = (next: AiSteerChip[]): void => {
    const pendingOf = (list: AiSteerChip[]) =>
      list
        .filter((chip) => chip.state === "pending")
        .map((chip) => chip.text)
        .join("\n");
    if (pendingOf(next) === pendingOf(chips)) {
      return;
    }
    setChips(next);
    void aiSearch.reorderSteer(next.filter((chip) => chip.state === "pending").map((chip) => chip.text)).then((ok) => {
      if (!ok) {
        setChips(chips);
      }
    });
  };

  return { chips, send, retract, reorder };
}
