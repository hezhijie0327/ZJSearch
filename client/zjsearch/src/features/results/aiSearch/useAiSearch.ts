// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useEffect, useRef, useState } from "react";
import { fetchEventStream } from "@/lib/http.ts";
import type { AiCapability } from "@/lib/types.ts";

/**
 * AI Search client state (POST /ai/search, NDJSON) -- THREADED: every
 * question (the initial one and each follow-up) appends a run section to
 * the page instead of replacing it.  Same abort discipline as useAiAnswer:
 * the controller is captured at start, aborted on unmount / re-run, every
 * settled callback re-checks the signal.
 *
 * Events arrive in the model's own order and rebuild a CHRONOLOGICAL
 * research timeline per run (steps): a round streams `think` deltas, then
 * its narration prose (`delta`), then its parallel batch (`calls`), and
 * the next round opens a fresh think step.  Prose after the first
 * `calls` streams into the answer live AND is held as the current turn's
 * pending slice -- when the turn's own `calls` land, that slice is split
 * back out of the answer into the round's intent step, so the settled
 * answer is the final synthesis alone.
 *
 * Follow-ups (`followup(q)`) append a new run to the thread: the prior
 * Q&A travels as conversation history and the global [n] numbering
 * continues after the existing sources (sources_base).
 */

export type AiSearchMode = "speed" | "balanced" | "quality";
export type AiSearchPhase = "idle" | "streaming" | "done" | "error";

export interface AiSearchCall {
  /** 1-based position of the call within its round */
  id: number;
  q: string;
  category: string;
  status: "pending" | "ok" | "error" | "timeout";
  n?: number;
}

/** One chronological segment of a run's research timeline. */
export type AiSearchStep =
  | { kind: "think"; text: string }
  | { kind: "intent"; text: string }
  | { kind: "calls"; round: number; calls: AiSearchCall[] };

export interface AiSearchSource {
  /** global [n] citation number (contiguous from 1) */
  n: number;
  runNo: number;
  round: number;
  callId: number;
  idx: number;
  title: string;
  url: string;
  netloc: string;
  favicon: string;
}

export interface AiSearchRun {
  runNo: number;
  q: string;
  mode: AiSearchMode;
  status: "streaming" | "done" | "error";
  error: string | null;
  /** the run's research timeline in the model's own order */
  steps: AiSearchStep[];
  /** settled synthesis of this run */
  answer: string;
  /** the [n] sources THIS run found (numbering continues across runs) */
  sources: AiSearchSource[];
  /** follow-up question suggestions generated for this answer */
  related: string[];
}

export interface AiSearchState {
  phase: AiSearchPhase;
  mode: AiSearchMode;
  runs: AiSearchRun[];
  sources: AiSearchSource[];
  error: string | null;
  start(q: string, lang: string, mode?: AiSearchMode): void;
  followup(q: string, lang: string, mode?: AiSearchMode): void;
  stop(): void;
  reset(): void;
}

interface Core {
  phase: AiSearchPhase;
  mode: AiSearchMode;
  runs: AiSearchRun[];
  /** the flat global [n] registry across every run (the follow-up
      sources_base derives from its length) */
  sources: AiSearchSource[];
  error: string | null;
  /** prose of the turn in progress: frozen as the round's intent step
      when its calls land, folded into the answer if the run ends before
      the first calls */
  pending: string;
  /** index in the last run's answer where the current turn's prose
      begins (turns after the first calls stream into the answer live) */
  answerFrom: number;
  /** true while the last think step still takes deltas */
  thinkOpen: boolean;
}

const IDLE: Core = {
  phase: "idle",
  mode: "balanced",
  runs: [],
  sources: [],
  error: null,
  pending: "",
  answerFrom: 0,
  thinkOpen: false,
};

const lastStep = (run: AiSearchRun): AiSearchStep | undefined =>
  run.steps.length > 0 ? run.steps[run.steps.length - 1] : undefined;

const hasCalls = (run: AiSearchRun): boolean => run.steps.some((step) => step.kind === "calls");

/** Settle the streaming run: fold a never-searched run's pending prose
    into its answer, mark it done. */
function settle(core: Core, failed: { error: string } | null): Core {
  const runs = [...core.runs];
  const run = runs[runs.length - 1];
  if (run) {
    let settled: AiSearchRun = { ...run };
    if (!hasCalls(settled) && !settled.answer && core.pending.trim()) {
      settled = { ...settled, answer: core.pending.trim() };
    }
    runs[runs.length - 1] = failed
      ? { ...settled, status: "error", error: failed.error }
      : { ...settled, status: settled.status === "streaming" ? "done" : settled.status };
  }
  const hasContent = runs.some((item) => item.answer || item.steps.length > 0);
  return {
    ...core,
    runs,
    phase: failed && !hasContent ? "error" : "done",
    error: failed?.error ?? core.error,
    pending: "",
    answerFrom: 0,
    thinkOpen: false,
  };
}

function applyEvent(core: Core, event: Record<string, unknown>): Core {
  const kind = event.e as string;
  const runs = [...core.runs];
  const lastIdx = runs.length - 1;
  const run = runs[lastIdx];
  if (!run) {
    return core;
  }

  switch (kind) {
    case "think": {
      const text = String(event.t ?? "");
      const steps = [...run.steps];
      const last = lastStep(run);
      if (core.thinkOpen && last && last.kind === "think") {
        steps[steps.length - 1] = { ...last, text: last.text + text };
      } else {
        // a fresh round's reasoning opens a new segment
        steps.push({ kind: "think", text });
      }
      runs[lastIdx] = { ...run, steps };
      return { ...core, runs, thinkOpen: true };
    }
    case "delta": {
      const text = String(event.t ?? "");
      let answer = run.answer;
      let { answerFrom } = core;
      if (hasCalls(run)) {
        // after the first calls the prose streams into the answer live;
        // the turn's own slice is tracked so its calls can split it back
        // out into the intent step
        if (!core.pending) {
          answerFrom = answer.length;
        }
        answer += text;
      }
      runs[lastIdx] = { ...run, answer };
      return { ...core, runs, answerFrom, pending: core.pending + text };
    }
    case "calls": {
      const items = (event.items as Array<{ id: number; q: string; category: string }>) ?? [];
      const steps = [...run.steps];
      const earlier = hasCalls(run);
      let answer = run.answer;
      // the turn's narration becomes this round's intent: before the
      // first calls it lived in pending, afterwards it streamed into the
      // answer and is split back out
      const intent = (earlier ? answer.slice(core.answerFrom) : core.pending).trim();
      if (earlier) {
        answer = answer.slice(0, core.answerFrom);
      }
      if (intent) {
        steps.push({ kind: "intent", text: intent });
      }
      steps.push({
        kind: "calls",
        round: Number(event.round) || run.steps.filter((step) => step.kind === "calls").length + 1,
        calls: items.map((item) => ({ ...item, status: "pending" as const })),
      });
      runs[lastIdx] = { ...run, steps, answer };
      return {
        ...core,
        runs,
        pending: "",
        answerFrom: answer.length,
        thinkOpen: false,
      };
    }
    case "search": {
      const roundNo = Number(event.round);
      const callId = Number(event.id);
      const steps = run.steps.map((step) => {
        if (step.kind !== "calls" || step.round !== roundNo) {
          return step;
        }
        return {
          ...step,
          calls: step.calls.map((call) =>
            call.id === callId
              ? {
                  ...call,
                  status: (event.status as AiSearchCall["status"]) ?? "error",
                  n: Number(event.n) || 0,
                }
              : call,
          ),
        };
      });
      runs[lastIdx] = { ...run, steps };
      return { ...core, runs };
    }
    case "sources": {
      // the global [n] registry of the cited feed -- the entries ride the
      // run that found them (the grid under its question) and the flat
      // registry powers the follow-up numbering base and chip jumps
      const items = (event.items as Array<Record<string, unknown>>) ?? [];
      const fresh: AiSearchSource[] = [];
      for (const item of items) {
        const url = String(item.url ?? "");
        if (!url) {
          continue;
        }
        fresh.push({
          n: Number(item.n) || 0,
          runNo: run.runNo,
          round: Number(item.round) || 0,
          callId: Number(item.id) || 0,
          idx: Number(item.idx) || 0,
          title: String(item.title ?? ""),
          url,
          netloc: String(item.netloc ?? ""),
          favicon: String(item.favicon ?? ""),
        });
      }
      if (!fresh.length) {
        return core;
      }
      const sources = [...core.sources, ...fresh]
        .filter((source, index, all) => all.findIndex((entry) => entry.n === source.n) === index)
        .sort((a, b) => a.n - b.n);
      runs[lastIdx] = { ...run, sources: [...run.sources, ...fresh] };
      return { ...core, runs, sources };
    }
    case "related":
      runs[lastIdx] = { ...run, related: ((event.items as string[]) ?? []).map(String).slice(0, 3) };
      return { ...core, runs };
    case "error":
      return { ...core, error: String(event.reason ?? "error") };
    case "end":
      return settle(core, null);
    default:
      return core;
  }
}

export function useAiSearch(capability: AiCapability | undefined): AiSearchState {
  const [core, setCore] = useState<Core>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const beginRun = (
    q: string,
    lang: string,
    history: Array<{ q: string; a: string }>,
    sourcesBase: number,
    mode: AiSearchMode,
  ) => {
    if (!capability) {
      return;
    }
    // abort any in-flight run first, then take over the abort slot
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const apply = (event: Record<string, unknown>) => {
      if (!controller.signal.aborted) {
        // `related` deliberately trails the `end` line (the server settles
        // the run first so the follow-up box opens; the suggestions arrive
        // whenever their small completion finishes thinking)
        const late = event.e === "related";
        setCore((prev) => (prev.phase === "streaming" || late ? applyEvent(prev, event) : prev));
      }
    };
    void fetchEventStream(
      "/ai/search",
      { tk: capability.tk, q, lang, mode, history, sources_base: sourcesBase },
      apply,
      controller.signal,
    )
      .then(() => {
        if (!controller.signal.aborted) {
          // a stream that ended without its `end` line (server restart):
          // settle whatever arrived
          setCore((prev) => (prev.phase === "streaming" ? settle(prev, null) : prev));
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          setCore((prev) => (prev.phase === "streaming" ? settle(prev, { error: message }) : prev));
        }
      });
  };

  const start = (q: string, lang: string, mode: AiSearchMode = "balanced") => {
    if (!capability) {
      return;
    }
    setCore({
      phase: "streaming",
      mode,
      runs: [
        {
          runNo: 1,
          q,
          mode,
          status: "streaming",
          error: null,
          steps: [],
          answer: "",
          sources: [],
          related: [],
        },
      ],
      sources: [],
      error: null,
      pending: "",
      answerFrom: 0,
      thinkOpen: false,
    });
    beginRun(q, lang, [], 0, mode);
  };

  const followup = (q: string, lang: string, mode: AiSearchMode = "balanced") => {
    const trimmed = q.trim();
    if (core.phase !== "done" || !trimmed) {
      return;
    }
    beginRun(
      trimmed,
      lang,
      core.runs.map((run) => ({ q: run.q, a: run.answer })),
      core.sources.length,
      mode,
    );
    setCore((prev) => ({
      ...prev,
      phase: "streaming",
      pending: "",
      answerFrom: 0,
      thinkOpen: false,
      runs: [
        ...prev.runs,
        {
          runNo: prev.runs.length + 1,
          q: trimmed,
          mode,
          status: "streaming" as const,
          error: null,
          steps: [] as AiSearchStep[],
          answer: "",
          sources: [] as AiSearchSource[],
          related: [] as string[],
        },
      ],
    }));
  };

  const stop = () => {
    abortRef.current?.abort();
    setCore((prev) => {
      if (prev.phase !== "streaming") {
        return prev;
      }
      const runs = [...prev.runs];
      const run = runs[runs.length - 1];
      if (run) {
        runs[runs.length - 1] = {
          ...run,
          status: run.status === "streaming" ? "done" : run.status,
        };
      }
      const hasContent = runs.some((item) => item.answer || item.steps.length > 0);
      return { ...prev, runs, phase: hasContent ? "done" : "idle" };
    });
  };

  const reset = () => {
    abortRef.current?.abort();
    setCore(IDLE);
  };

  return { ...core, start, followup, stop, reset };
}
