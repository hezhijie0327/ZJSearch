// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { AiSearchMode } from "@/features/results/aiSearch/runModel.ts";

/** One debug-stage scenario: a wire-event SCRIPT replayed through the real
    fold (`applyEvent`) and rendered by the real run section.  The scenarios
    are DEMO material -- a fictional paper-plane club standing in for a
    research subject -- so the stage shows every surface without carrying
    anyone's real research. */
export interface DebugScenario {
  id: string;
  /** the SHORT zh picker name -- the long English label stays the option's
      secondary line (the QA surface's own description) */
  name: string;
  label: string;
  q: string;
  mode: AiSearchMode;
  events: Array<Record<string, unknown>>;
  /** OPTIONAL continuation after the clarify gate is answered: the stage
      passes the user's transcript (or "" on skip) and the returned events
      replay from the awaiting settle -- the simulator's submit/skip are
      wired to this, so the clarify flow is testable end to end. */
  clarifyTail?: (transcript: string) => Array<Record<string, unknown>>;
}

export interface AiOverviewDebugScenario {
  id: string;
  label: string;
  q: string;
  /** the raw stream text, chunk by chunk (each step is a freezable
      mid-stream state; the joined text is what state.text would hold) */
  chunks: string[];
  /** favicon + domain + title per citation, in [n] order */
  sources: Array<{ favicon: string; domain: string; t: string; u: string }>;
  /** the terminal phase once every chunk has streamed */
  phase: "done" | "error";
  /** the transport error message when phase === "error" */
  error?: string;
}
