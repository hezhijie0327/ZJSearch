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

export type AiSearchMode = "speed" | "balanced" | "quality" | "goal";
/** "awaiting": the clarify gate asked for the user's direction -- the run
    lives on until they answer (or skip) via submitClarify. */
export type AiSearchPhase = "idle" | "streaming" | "awaiting" | "done" | "error";

export interface AiAskQuestion {
  q: string;
  type: "single" | "multi";
  options: string[];
}

export interface AiSearchCall {
  /** 1-based position of the call within its round */
  id: number;
  /** which tool produced the row: a keyword search or a full page read */
  tool: "web_search" | "web_crawler";
  /** web_search: the keyword query; web_crawler rows leave it empty */
  q: string;
  /** web_crawler: the page url (the row's label) */
  url?: string;
  category: string;
  status: "pending" | "ok" | "error" | "timeout" | "interrupted" | "duplicate";
  /** web_search: result count */
  n?: number;
  /** web_crawler: characters of readable content returned */
  chars?: number;
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
  title: string;
  url: string;
  netloc: string;
  favicon: string;
  /** web_crawler read this page in full (the card's read-in-full badge) */
  crawled?: boolean;
}

export interface AiSearchRun {
  runNo: number;
  q: string;
  status: "streaming" | "awaiting" | "done" | "error";
  error: string | null;
  /** the run's research timeline in the model's own order */
  steps: AiSearchStep[];
  /** settled synthesis of this run */
  answer: string;
  /** the [n] sources THIS run found (numbering continues across runs) */
  sources: AiSearchSource[];
  /** follow-up question suggestions generated for this answer */
  related: string[];
  /** the clarify gate's questions while the run waits for the user's
      direction (status "awaiting") */
  ask: { intro: string; questions: AiAskQuestion[] } | null;
  /** the user's answer text after submitClarify ("" = skipped) */
  clarify: string | undefined;
  /** the budget forced the wrap-up: partial prose was discarded */
  wrappingUp: boolean;
  /** client clock when the run's RESEARCH began (reset on clarify
      submit -- the question wait is not research time) */
  startedAt: number;
  /** client clock when the run settled (research duration display) */
  endedAt: number | null;
  /** the depth this run RAN with -- the pill displays it (the truthful
      last-run value), picking a new depth affects the next run */
  mode: AiSearchMode;
}

export interface AiSearchState {
  phase: AiSearchPhase;
  runs: AiSearchRun[];
  sources: AiSearchSource[];
  error: string | null;
  start(q: string, lang: string, mode?: AiSearchMode, searchLanguage?: string): void;
  followup(q: string, lang: string, mode?: AiSearchMode, searchLanguage?: string): void;
  /** answer the awaiting run's clarify questions (null = skip) and start
      its research on the SAME run */
  submitClarify(text: string | null, lang: string, mode?: AiSearchMode, searchLanguage?: string): void;
  stop(): void;
  reset(): void;
}

interface Core {
  phase: AiSearchPhase;
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
    into its answer, mark it done (awaiting when the clarify gate asked). */
function settle(core: Core, failed: { error: string } | null): Core {
  const runs = [...core.runs];
  const run = runs[runs.length - 1];
  if (run) {
    let settled: AiSearchRun = { ...run };
    if (!hasCalls(settled) && !settled.answer && core.pending.trim()) {
      settled = { ...settled, answer: core.pending.trim() };
    }
    const awaiting = !failed && settled.ask !== null && !settled.answer.trim();
    const endedAt = awaiting ? null : Date.now();
    runs[runs.length - 1] = failed
      ? { ...settled, status: "error", error: failed.error, endedAt }
      : {
          ...settled,
          endedAt,
          status: awaiting ? "awaiting" : settled.status === "streaming" ? "done" : settled.status,
        };
  }
  // in-flight searches can never report a status once the run ends (budget
  // truncation, user stop, stream close) -- settle them as interrupted so
  // no timeline row spins forever
  const interruptedRuns = runs.map((item) =>
    item.steps.some((step) => step.kind === "calls" && step.calls.some((call) => call.status === "pending"))
      ? {
          ...item,
          steps: item.steps.map((step) =>
            step.kind === "calls"
              ? {
                  ...step,
                  calls: step.calls.map((call) =>
                    call.status === "pending" ? { ...call, status: "interrupted" as const } : call,
                  ),
                }
              : step,
          ),
        }
      : item,
  );
  runs.splice(0, runs.length, ...interruptedRuns);
  const hasContent = runs.some((item) => item.answer || item.steps.length > 0);
  const awaiting = runs[runs.length - 1]?.status === "awaiting";
  return {
    ...core,
    runs,
    phase: failed && !hasContent ? "error" : awaiting ? "awaiting" : "done",
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
      const items =
        (event.items as Array<{ id?: number; tool?: string; q?: string; url?: string; category?: string }>) ?? [];
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
        calls: items.map((item) => ({
          id: Number(item.id) || 0,
          tool: item.tool === "web_crawler" ? ("web_crawler" as const) : ("web_search" as const),
          q: String(item.q ?? ""),
          url: item.url ? String(item.url) : undefined,
          category: String(item.category ?? ""),
          status: "pending" as const,
        })),
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
    case "plan": {
      // the model planned its answer via the plan tool: this turn's prose
      // (which streamed into the answer live, or sat in pending) is
      // re-homed as the plan's intent step -- the answer stays clean
      const earlier = hasCalls(run);
      let answer = run.answer;
      const intent = (earlier ? answer.slice(core.answerFrom) : core.pending).trim();
      if (earlier) {
        answer = answer.slice(0, core.answerFrom);
      }
      const steps = [...run.steps];
      if (intent) {
        steps.push({ kind: "intent", text: intent });
      }
      runs[lastIdx] = { ...run, steps, answer };
      return { ...core, runs, pending: "", answerFrom: answer.length, thinkOpen: false };
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
    case "page": {
      // an web_crawler read settled: flip its row's status (the readable
      // character count replaces a search's result count)
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
                  chars: Number(event.chars) || 0,
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
      // registry powers the follow-up numbering base and chip jumps.
      // Merged by [n]: new entries append; a web_crawler re-emission of an
      // already-numbered url upgrades the existing card in place (its
      // read-in-full badge) instead of duplicating it
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
          title: String(item.title ?? ""),
          url,
          netloc: String(item.netloc ?? ""),
          favicon: String(item.favicon ?? ""),
          crawled: Boolean(item.crawled),
        });
      }
      if (!fresh.length) {
        return core;
      }
      const merge = (list: AiSearchSource[]): AiSearchSource[] => {
        const merged = [...list];
        for (const item of fresh) {
          const idx = merged.findIndex((entry) => entry.n === item.n);
          const existing = merged[idx];
          if (existing === undefined) {
            merged.push(item);
          } else if (item.crawled && !existing.crawled) {
            merged[idx] = { ...existing, crawled: true };
          }
        }
        return merged.sort((a, b) => a.n - b.n);
      };
      runs[lastIdx] = { ...run, sources: merge(run.sources) };
      return { ...core, runs, sources: merge(core.sources) };
    }
    case "ask": {
      // the clarify gate wants the user's direction BEFORE researching:
      // hold the questions on the run; the following `end` settles it as
      // awaiting (the answers travel on the next request)
      runs[lastIdx] = {
        ...run,
        ask: {
          intro: String(event.intro ?? ""),
          questions: ((event.questions as Array<Record<string, unknown>>) ?? []).map((raw) => ({
            q: String(raw.q ?? ""),
            type: String(raw.type ?? "single") === "multi" ? ("multi" as const) : ("single" as const),
            options: ((raw.options as unknown[]) ?? []).map(String),
          })),
        },
      };
      return { ...core, runs };
    }
    case "wrapup": {
      // the budget took the tools away: the model was TOLD to summarize
      // now and the partial prose it had streamed is discarded -- the
      // wrap-up turn's output becomes the answer wholesale
      runs[lastIdx] = { ...run, answer: "", wrappingUp: true };
      return { ...core, runs, pending: "", answerFrom: 0, thinkOpen: false };
    }
    case "related":
      runs[lastIdx] = { ...run, related: ((event.items as string[]) ?? []).map(String).slice(0, 3) };
      return { ...core, runs };
    case "error": {
      // mid-stream failure: terminal for the LLM turn, not necessarily for
      // the run (the agent may still force a no-tools answer).  Record the
      // reason on the run -- the failed box shows it if no answer lands.
      const reason = String(event.reason ?? "error");
      runs[lastIdx] = { ...run, error: reason };
      return { ...core, runs, error: reason };
    }
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
    /** the page's result-language filter -- the tool searches inherit it */
    searchLanguage = "",
    /** clarify round-trip fields: clarify_state + clarifications */
    clarify?: { state: "answered" | "skipped"; text: string },
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
      {
        tk: capability.tk,
        q,
        lang,
        mode,
        history,
        sources_base: sourcesBase,
        search_language: searchLanguage,
        clarify_state: clarify?.state ?? "ask",
        clarifications: clarify?.text ?? "",
      },
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

  const start = (q: string, lang: string, mode: AiSearchMode = "balanced", searchLanguage = "") => {
    if (!capability) {
      return;
    }
    setCore({
      phase: "streaming",
      runs: [
        {
          runNo: 1,
          q,
          status: "streaming",
          error: null,
          steps: [],
          answer: "",
          sources: [],
          related: [],
          ask: null,
          clarify: undefined,
          wrappingUp: false,
          startedAt: Date.now(),
          endedAt: null,
          mode,
        },
      ],
      sources: [],
      error: null,
      pending: "",
      answerFrom: 0,
      thinkOpen: false,
    });
    beginRun(q, lang, [], 0, mode, searchLanguage);
  };

  const followup = (q: string, lang: string, mode: AiSearchMode = "balanced", searchLanguage = "") => {
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
      searchLanguage,
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
          status: "streaming" as const,
          error: null,
          steps: [] as AiSearchStep[],
          answer: "",
          sources: [] as AiSearchSource[],
          related: [] as string[],
          ask: null,
          clarify: undefined,
          wrappingUp: false,
          startedAt: Date.now(),
          endedAt: null,
          mode,
        },
      ],
    }));
  };

  /** The clarify round-trip: the user answered the awaiting run's
      questions (or skipped) -- its research starts on the SAME run so
      the thread keeps one section per question. */
  const submitClarify = (text: string | null, lang: string, mode: AiSearchMode = "balanced", searchLanguage = "") => {
    if (core.phase !== "awaiting") {
      return;
    }
    const last = core.runs[core.runs.length - 1];
    if (!last) {
      return;
    }
    // prior ANSWERED runs travel as history; the awaiting run has none
    beginRun(
      last.q,
      lang,
      core.runs.slice(0, -1).map((run) => ({ q: run.q, a: run.answer })),
      core.sources.length,
      mode,
      searchLanguage,
      { state: text === null ? "skipped" : "answered", text: text ?? "" },
    );
    setCore((prev) => ({
      ...prev,
      phase: "streaming",
      pending: "",
      answerFrom: 0,
      thinkOpen: false,
      runs: prev.runs.map((run, index) =>
        index === prev.runs.length - 1
          ? {
              ...run,
              status: "streaming" as const,
              steps: [] as AiSearchStep[],
              answer: "",
              clarify: text ?? "",
              wrappingUp: false,
              startedAt: Date.now(),
              endedAt: null,
              mode,
            }
          : run,
      ),
    }));
  };

  const stop = () => {
    abortRef.current?.abort();
    // settle() folds the streamed narration the same way a natural end
    // would -- stopping must not throw away prose the user watched stream
    setCore((prev) => (prev.phase === "streaming" ? settle(prev, null) : prev));
  };

  const reset = () => {
    abortRef.current?.abort();
    setCore(IDLE);
  };

  return { ...core, start, followup, submitClarify, stop, reset };
}
