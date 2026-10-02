// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useEffect, useRef, useState } from "react";
import type { AiSearchGallery } from "@/features/results/aiOverview.ts";
import { fetchEventStream } from "@/lib/http.ts";
import {
  appendRunEvents,
  archiveDocument,
  loadMemories,
  loadThreadEvents,
  recallCorpus,
  recallPages,
  saveMemory,
  settleRun,
} from "@/lib/knowledgeStore.ts";
import type { AiCapability } from "@/lib/types.ts";

/**
 * AI Search client state (POST /zjsearch/ai/search, NDJSON timeline ops) --
 * THREADED: every question (the initial one and each follow-up) appends a
 * run section to the page instead of replacing it.
 *
 * The SERVER owns the timeline: every wire event is a closed-set timeline
 * operation (framework/wire.py) -- deltas carry their entry id and channel
 * (`think` / `say` / `answer`), calls belong to their entry, one `settle`
 * declares the terminal state.  This hook APPENDS; it reconstructs
 * nothing (the old answerFrom/pending/thinkOpen heuristics are gone with
 * the protocol that required them).  Steps mirror the entries one-to-one:
 * a research entry renders as its think segment, its intent narration and
 * its call rows.
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
  /** which tool produced the row (legacy threads may still carry the old
      "web_crawler" name) */
  tool:
    | "web_search"
    | "web_reader"
    | "calculator"
    | "mcp"
    | "user_memory"
    | "past_research"
    | "task_write"
    | "ask_user";
  /** mcp rows: the server-scoped tool label (without the namespace);
      user_memory rows: "save" | "search" */
  name?: string;
  label?: string;
  /** web_search: the keyword query; web_reader rows leave it empty */
  q: string;
  /** web_reader: the page url (the row's label) */
  url?: string;
  category: string;
  status: "pending" | "ok" | "error" | "interrupted" | "duplicate";
  /** web_search: result count */
  n?: number;
  /** web_reader: characters of readable content returned */
  chars?: number;
  /** calculator: the exact evaluated result (the row shows expr = result) */
  result?: string;
  /** web_reader: the extracted page content -- the row's expansion is a
      READING PANE of what the model actually read, not a link card */
  text?: string;
  /** the model's RAW tool-call arguments (q / category / ...) -- the
      timeline row's debug expansion shows exactly what was passed */
  args?: Record<string, unknown>;
}

/** One chronological segment of a run's research timeline, mirroring one
    server-side ENTRY (framework/loop.py): a research entry renders as its
    think segment, its intent narration and its call rows; the clarify
    round-trip seeds a "clarify" step.  (The stored-legacy "plan" step kind
    of the pre-wire-v2 threads was dropped with the threads' own era --
    those rows simply no longer render.) */
export type AiSearchStep =
  | { kind: "think"; text: string; entry?: number }
  | { kind: "intent"; text: string; entry?: number }
  | { kind: "clarify"; pairs: Array<{ q: string; a: string }> }
  | { kind: "calls"; entry?: number; round: number; calls: AiSearchCall[] };

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
  /** result thumbnail (the classic presentations' img_src) -- the rail
      card pins it to the row end like the infobox-side cards do */
  img?: string;
  /** the result's search category -- the hook for type-aware cards
      (video duration, torrent filesize, ... the classic presentations) */
  category?: string;
  /** web_reader read this page in full (the card's read-in-full badge) */
  crawled?: boolean;
  /** the result's snippet from the SearXNG result payload -- the source's
      knowledge-projection body (uncrawled sources stay searchable) */
  content?: string;
  /** recalled from the browser's research memory (the writer-phase
      injection) -- the card's history badge; NOT re-verified this run */
  history?: boolean;
  /** how many PAST runs referenced this url (the cross-session badge;
      0/undefined = new to the corpus) */
  pastRefs?: number;
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
  /** inline image groups the writer embedded, in fence order -- the
      answer's `{{zjs-gallery:i}}` placeholders index into this array */
  galleries: AiSearchGallery[][];
  /** the zero-research run: the writer answered directly (the research
      box stays empty) */
  direct?: boolean;
  /** follow-up question suggestions generated for this answer */
  related: string[];
  /** the clarify gate's questions while the run waits for the user's
      direction (status "awaiting") */
  ask: { intro: string; questions: AiAskQuestion[] } | null;
  /** the user's answer text after submitClarify ("" = skipped) */
  clarify: string | undefined;
  /** the write phase opened (the 撰写 line covers its silence) */
  wrappingUp: boolean;
  /** client clock when the run's RESEARCH began (reset on clarify
      submit -- the question wait is not research time) */
  startedAt: number;
  /** client clock when the run settled (research duration display) */
  endedAt: number | null;
  /** the depth this run RAN with -- the pill displays it (the truthful
      last-run value), picking a new depth affects the next run */
  mode: AiSearchMode;
  /** the user pressed stop: a settled run without an answer is then
      intentional, not a failure (the failed box must not fire) */
  stopped?: boolean;
  /** the transports' finish reason of the run's LAST turn ("stop" |
      "length" | "content_filter" | ... -- the writer's, when a writer
      phase ran); null while unknown */
  finish?: string | null;
  /** the model id the API RESPONSE reported (what the endpoint actually
      ran, not what we asked for); null when the stream carries none */
  model?: string | null;
  /** token usage summed across the run's turns (null = the endpoint
      reported nothing); cached/cache_write are the prompt-cache hit and
      write counts (0 when the endpoint does not break them out);
      research/write/gates are the PER-PHASE split -- the whole flow,
      nothing dark matter */
  usage?: {
    input: number;
    output: number;
    thoughts: number | null;
    cached: number;
    cache_write: number;
    research?: { input: number; output: number } | null;
    write?: { input: number; output: number } | null;
    gates?: { input: number; output: number; calls: number } | null;
  } | null;
  /** the server's halt explanation carried on settle (stall verdict,
      truncation, transport cut) -- the meta row renders it */
  halt?: string | null;
  /** the extractor's concept tags (the LATE `tags` wire event) -- the
      settle writes them into the knowledge projections */
  tags?: string[];
  /** the living task list (the task_write tool maintains it; the task
      card renders it) -- empty for modes that do not decompose */
  tasks: Array<{
    title: string;
    /** "missed" (client-side at settle): the run concluded and this
        subtask never gathered a source -- the card shows a warning, not
        a dishonest check */
    status: "pending" | "active" | "done" | "missed";
    /** the global [n] numbers this subtask's research produced -- the
        provenance count on the task card */
    sources?: number[];
    /** LEGACY threads only (the dropped subagent era) */
    steps: AiSearchStep[];
    findings?: string;
  }>;
}

interface Core {
  phase: AiSearchPhase;
  runs: AiSearchRun[];
  /** the flat [n] registry across the thread (citation jumps, follow-up
      numbering base) */
  sources: AiSearchSource[];
  error: string | null;
  threadId: string;
}

export interface AiSearchState extends Core {
  start(q: string, lang: string, mode?: AiSearchMode, searchLanguage?: string): void;
  followup(q: string, lang: string, mode?: AiSearchMode, searchLanguage?: string): void;
  /** answer the awaiting run's clarify questions (null = skip) and start
      its research on the SAME run */
  submitClarify(text: string | null, lang: string, mode?: AiSearchMode, searchLanguage?: string): void;
  /** re-run the last run IN PLACE (the failed box's retry / regenerate) */
  retry(lang: string, mode?: AiSearchMode, searchLanguage?: string): void;
  /** restore a stored thread; false when the id is unknown */
  resume(threadId: string): Promise<boolean>;
  stop(): void;
  reset(): void;
}

const IDLE: Core = {
  phase: "idle",
  runs: [],
  sources: [],
  error: null,
  threadId: "",
};

/** The live fold's side effects: reader pages archive as their call
    settles, memories persist as their events arrive. */
const LIVE_FX: FoldFx = { archive: archiveDocument, saveMemory, now: () => Date.now() };
/** The replay fold: persistence already happened live, so both ports are
    no-ops (a replay must never double-archive or double-save). */
const REPLAY_FX: FoldFx = {
  archive: () => undefined,
  saveMemory: () => undefined,
  now: () => Date.now(),
};

/** Entries as step indices: think/say/calls events route by entry id. */
type EntryIndex = { think?: number; intent?: number; calls?: number };

/** Settle every still-pending call row (abort / stream cut / error settle):
    no timeline row spins forever. */
function interruptPending(runs: AiSearchRun[]): AiSearchRun[] {
  return runs.map((item) => {
    if (!item.steps.some((step) => step.kind === "calls" && step.calls.some((call) => call.status === "pending"))) {
      return item;
    }
    return {
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
    };
  });
}

function settle(core: Core, failed: { error: string } | null, stopped: boolean, now = Date.now()): Core {
  const runs = [...core.runs];
  const lastIdx = runs.length - 1;
  const run = runs[lastIdx];
  if (run) {
    const awaiting = !failed && run.ask !== null && !run.answer.trim() && !stopped;
    const endedAt = awaiting ? null : now;
    runs[lastIdx] = failed
      ? { ...run, status: "error", error: failed.error, endedAt }
      : {
          ...run,
          endedAt,
          status: awaiting ? "awaiting" : ("done" as const),
        };
  }
  const interrupted = interruptPending(runs);
  // the task card's settle completion, HONESTLY: a subtask with sources
  // is done; one that never gathered a source stays visibly unresearched
  const settled = interrupted.map((item) =>
    item.status === "streaming"
      ? {
          ...item,
          status: "done" as const,
          tasks: item.tasks.map((task) =>
            task.status === "done" || (task.sources?.length ?? 0) > 0
              ? { ...task, status: "done" as const }
              : { ...task, status: "missed" as const },
          ),
        }
      : item,
  );
  const hasContent = settled.some((item) => item.answer || item.steps.length > 0);
  const awaiting = settled[settled.length - 1]?.status === "awaiting";
  return {
    ...core,
    runs: settled,
    phase: failed && !hasContent ? "error" : awaiting ? "awaiting" : "done",
    error: failed?.error ?? core.error,
  };
}

/** Parse the clarify answer text ("1. Question：Answer" lines + a trailing
    free-text note) into Q/A pairs -- the same grammar the rail's
    ClarifySegment renders. */
function parseClarifyPairs(text: string): Array<{ q: string; a: string }> {
  const pairs: Array<{ q: string; a: string }> = [];
  let note = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^(?:\d+[.、]\s*)?(.+?)[：:]\s*(.+)$/.exec(trimmed);
    if (match?.[1] && match[2]) {
      pairs.push({ q: match[1].trim(), a: match[2].trim() });
    } else {
      note = (note ? `${note} ` : "") + trimmed;
    }
  }
  if (note) {
    pairs.push({ q: "", a: note });
  }
  return pairs;
}

/** The fold's side-effect ports: the LIVE run archives reader pages and
    persists memories as their events arrive and stamps the wall clock;
    a REPLAY no-ops the persistence (it happened live) and stamps the
    event's own arrival time (the duration displays stay truthful). */
export interface FoldFx {
  archive(url: string, title: string, text: string): void;
  saveMemory(content: string): void;
  now(): number;
}

/** Exported for the knowledge page's replay: the SAME fold renders a live
    stream and rebuilds a stored run from its evt rows (harness-style --
    one reducer, two executions). */
export function applyEvent(
  core: Core,
  event: Record<string, unknown>,
  fx: FoldFx,
  pastRefCounts?: Map<string, number>,
): Core {
  const kind = event.e as string;
  // the bootstrap event CREATES the run -- it must pass before the
  // last-run guard (there is no run to fold into yet, that's the point)
  if (kind === "client.start") {
    const fresh = emptyRun(Number(event.runNo) || 1, String(event.q ?? ""), (event.mode as AiSearchMode) ?? "balanced");
    fresh.startedAt = Number(event.startedAt) || fresh.startedAt;
    return { ...core, runs: [...core.runs, fresh], phase: "streaming" };
  }
  const runs = [...core.runs];
  const lastIdx = runs.length - 1;
  const run = runs[lastIdx];
  if (!run) {
    return core;
  }
  const entryId = Number(event.id) || 0;
  const stepIndexFor = (kind2: "think" | "intent" | "calls"): number =>
    run.steps.findIndex((step) => step.kind === kind2 && (step as { entry?: number }).entry === entryId);

  switch (kind) {
    case "client.clarify": {
      // the user answered the clarify gate: the run restarts on the SAME
      // run id (the asking record survives, the answer resets)
      runs[lastIdx] = {
        ...run,
        status: "streaming",
        answer: "",
        clarify: String(event.text ?? ""),
        ask: null,
        wrappingUp: false,
        startedAt: Number(event.startedAt) || run.startedAt,
        endedAt: null,
        mode: (event.mode as AiSearchMode) ?? run.mode,
      };
      return { ...core, runs, phase: "streaming" };
    }
    case "client.retry": {
      const clarifyText = typeof event.clarify === "string" && event.clarify ? event.clarify : undefined;
      runs[lastIdx] = {
        ...run,
        status: "streaming",
        // the retry keeps its confirmed direction: the clarify step
        // re-opens the rebuilt timeline
        steps: (clarifyText
          ? [{ kind: "clarify" as const, pairs: parseClarifyPairs(clarifyText) }]
          : []) as AiSearchStep[],
        answer: "",
        galleries: [],
        related: [],
        ask: null,
        error: null,
        wrappingUp: false,
        startedAt: Number(event.startedAt) || run.startedAt,
        endedAt: null,
        mode: (event.mode as AiSearchMode) ?? run.mode,
      };
      return { ...core, runs, phase: "streaming", error: null };
    }
    case "client.stop": {
      if (core.phase !== "streaming") {
        return core;
      }
      const flagged = runs.map((item, index) => (index === lastIdx ? { ...item, stopped: true } : item));
      return { ...settle({ ...core, runs: flagged }, null, true, fx.now()), phase: "done" };
    }
    case "open": {
      if (String(event.kind) === "write") {
        // the writer phase opened: the 撰写 line covers its silence
        runs[lastIdx] = { ...run, wrappingUp: true };
        return { ...core, runs };
      }
      return core;
    }
    case "think": {
      // a research/write entry's reasoning: its own think segment
      const steps = [...run.steps];
      const idx = stepIndexFor("think");
      const text = String(event.t ?? "");
      if (idx >= 0) {
        const step = steps[idx] as Extract<AiSearchStep, { kind: "think" }>;
        steps[idx] = { ...step, text: step.text + text };
      } else {
        steps.push({ kind: "think", text, entry: entryId });
      }
      runs[lastIdx] = { ...run, steps };
      return { ...core, runs };
    }
    case "say": {
      // a research entry's narration: its intent line
      const steps = [...run.steps];
      const idx = stepIndexFor("intent");
      const text = String(event.t ?? "");
      if (idx >= 0) {
        const step = steps[idx] as Extract<AiSearchStep, { kind: "intent" }>;
        steps[idx] = { ...step, text: step.text + text };
      } else {
        steps.push({ kind: "intent", text, entry: entryId });
      }
      runs[lastIdx] = { ...run, steps };
      return { ...core, runs };
    }
    case "calls": {
      const items = (event.items as Array<Record<string, unknown>>) ?? [];
      const round = run.steps.filter((step) => step.kind === "calls").length + 1;
      runs[lastIdx] = {
        ...run,
        steps: [
          ...run.steps,
          {
            kind: "calls",
            entry: entryId,
            round,
            calls: items.map((item) => normalizeCall(item)),
          },
        ],
      };
      return { ...core, runs };
    }
    case "call": {
      // ONE call settled (the entry id + in-round position address the row)
      const callId = Number(event.call) || 0;
      const steps = run.steps.map((step) => {
        if (step.kind !== "calls" || step.entry !== entryId) {
          return step;
        }
        return {
          ...step,
          calls: step.calls.map((call) =>
            call.id === callId
              ? {
                  ...call,
                  status: (event.status as AiSearchCall["status"]) ?? "error",
                  ...(event.n !== undefined ? { n: Number(event.n) || 0 } : {}),
                  ...(event.ms !== undefined ? {} : {}),
                  ...(event.chars !== undefined ? { chars: Number(event.chars) || 0 } : {}),
                  ...(event.result !== undefined ? { result: String(event.result ?? "") } : {}),
                  ...(event.text !== undefined ? { text: String(event.text ?? "") || undefined } : {}),
                  ...(event.preview !== undefined ? { text: String(event.preview ?? "") || undefined } : {}),
                  ...(event.label !== undefined ? { label: String(event.label ?? "") || undefined } : {}),
                  ...(event.action !== undefined ? { name: String(event.action ?? "") } : {}),
                }
              : call,
          ),
        };
      });
      runs[lastIdx] = { ...run, steps };
      // a page read's extracted text persists as a document row (the
      // url-identity full-text store the recall pages from)
      const text = typeof event.text === "string" ? event.text : "";
      if (text) {
        const url = String(event.url ?? "");
        fx.archive(url, run.sources.find((source) => source.url === url)?.title ?? "", text);
      }
      return { ...core, runs };
    }
    case "close":
      return core;
    case "tasks": {
      const items = (event.items as Array<Record<string, unknown>>) ?? [];
      const tasks = items.map((item) => {
        const existing = run.tasks.find((t) => t.title === String(item.title ?? ""));
        return {
          title: String(item.title ?? ""),
          status: String(item.status ?? "pending") as "pending" | "active" | "done",
          sources: Array.isArray(item.sources)
            ? item.sources.map((n) => Number(n) || 0).filter((n) => n > 0)
            : undefined,
          steps: existing?.steps ?? [],
          findings: existing?.findings,
        };
      });
      runs[lastIdx] = { ...run, tasks };
      return { ...core, runs };
    }
    case "sources": {
      // the global [n] registry of the cited feed -- new entries append, a
      // crawled re-emission upgrades the existing card in place, an
      // img-bearing entry back-fills a missing thumbnail
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
          img: String(item.img ?? "") || undefined,
          category: String(item.category ?? "") || undefined,
          crawled: Boolean(item.crawled),
          content: String(item.content ?? "") || undefined,
          history: Boolean(item.history),
          // the cross-session badge: how many PAST runs referenced this
          // url, captured at the pre-run recall (never the run's own
          // ref-count increment -- the map is read-only after beginRun)
          pastRefs: pastRefCounts?.get(url) || undefined,
        });
      }
      if (!fresh.length) {
        return core;
      }
      const merged = [...run.sources];
      for (const source of fresh) {
        const existing = merged.find((candidate) => candidate.n === source.n);
        if (existing) {
          existing.crawled = existing.crawled || source.crawled;
          existing.img = existing.img ?? source.img;
        } else {
          merged.push(source);
        }
      }
      merged.sort((a, b) => a.n - b.n);
      const flat = [...core.sources];
      for (const source of merged) {
        const at = flat.findIndex((existing) => existing.n === source.n);
        if (at < 0) {
          flat.push(source);
        }
      }
      runs[lastIdx] = { ...run, sources: merged };
      return { ...core, runs, sources: flat };
    }
    case "answer": {
      // the writer's answer buffer -- ITS OWN channel, never narration
      runs[lastIdx] = { ...run, answer: run.answer + String(event.t ?? "") };
      return { ...core, runs };
    }
    case "ask": {
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
    case "gallery": {
      const items = (event.items as Array<Record<string, unknown>>) ?? [];
      const fresh: AiSearchGallery[] = [];
      for (const item of items) {
        const url = String(item.u ?? "");
        if (!url) {
          continue;
        }
        const n = Number(item.n) || 0;
        fresh.push({ url, n, title: run.sources.find((source) => source.n === n)?.title ?? "" });
      }
      if (!fresh.length) {
        return core;
      }
      runs[lastIdx] = { ...run, galleries: [...run.galleries, fresh] };
      return { ...core, runs };
    }
    case "related":
      runs[lastIdx] = { ...run, related: ((event.items as string[]) ?? []).map(String).slice(0, 3) };
      return { ...core, runs };
    case "usage": {
      // LATE: the trailing completions' (related fallback / memory
      // extraction) updated gates account -- ABSOLUTE values, the client
      // sets the bucket (idempotent)
      const gates = event.gates as NonNullable<AiSearchRun["usage"]>["gates"];
      if (gates && typeof gates === "object") {
        const base = run.usage ?? { input: 0, output: 0, thoughts: null, cached: 0, cache_write: 0 };
        runs[lastIdx] = { ...run, usage: { ...base, gates } };
        return { ...core, runs };
      }
      return core;
    }
    case "memory":
      // the model saved a durable fact about the user: persist into the
      // local store (no timeline rendering -- a silent background save)
      if (typeof event.content === "string" && event.content) {
        fx.saveMemory(event.content);
      }
      return core;
    case "tags": {
      // LATE: the extractor's concept tags for this run -- parked on the
      // run so settleRun writes them into the projections (and the evt
      // log carries them for replay)
      const items = ((event.items as string[]) ?? []).map(String).filter(Boolean).slice(0, 12);
      if (items.length) {
        runs[lastIdx] = { ...run, tags: items };
        return { ...core, runs };
      }
      return core;
    }
    case "settle": {
      // the SERVER-DECLARED terminal state (status: done | awaiting |
      // error) -- no client inference
      const status = String(event.status ?? "done");
      const usage = event.usage as AiSearchRun["usage"];
      const halt = typeof event.halt === "string" && event.halt ? event.halt : null;
      let next: AiSearchRun = {
        ...run,
        finish: event.finish ? String(event.finish) : (run.finish ?? null),
        model: typeof event.model === "string" && event.model ? event.model : (run.model ?? null),
        usage: usage
          ? {
              input: Number(usage.input) || 0,
              output: Number(usage.output) || 0,
              thoughts: typeof usage.thoughts === "number" ? usage.thoughts : null,
              cached: Number(usage.cached) || 0,
              cache_write: Number(usage.cache_write) || 0,
              research: usage.research ?? null,
              write: usage.write ?? null,
              gates: usage.gates ?? null,
            }
          : (run.usage ?? null),
        halt,
      };
      if (status === "awaiting") {
        next = { ...next, status: "awaiting", endedAt: null };
        runs[lastIdx] = next;
        return { ...core, runs, phase: "awaiting" };
      }
      if (status === "error") {
        const reason = halt ?? "error";
        next = { ...next, status: "error", error: reason, endedAt: fx.now() };
        runs[lastIdx] = next;
        const withInterrupted = interruptPending(runs);
        const hasContent = withInterrupted.some((item) => item.answer || item.steps.length > 0);
        return {
          ...core,
          runs: withInterrupted,
          phase: hasContent ? "done" : "error",
          error: hasContent ? core.error : reason,
        };
      }
      runs[lastIdx] = next;
      return settle({ ...core, runs }, null, false, fx.now());
    }
    default:
      return core;
  }
}

function normalizeCall(item: Record<string, unknown>): AiSearchCall {
  const tool = String(item.tool ?? "");
  return {
    id: Number(item.id) || 0,
    // the tool name carries no versioning -- browser-stored legacy threads
    // may still say "web_crawler": normalize it in
    tool:
      tool === "web_reader" || tool === "web_crawler"
        ? ("web_reader" as const)
        : tool === "calculator"
          ? ("calculator" as const)
          : tool === "mcp"
            ? ("mcp" as const)
            : tool === "user_memory"
              ? ("user_memory" as const)
              : tool === "past_research" || tool === "web_memory"
                ? ("past_research" as const)
                : tool === "task_write"
                  ? ("task_write" as const)
                  : tool === "ask_user"
                    ? ("ask_user" as const)
                    : ("web_search" as const),
    name: typeof item.name === "string" ? item.name : undefined,
    label: typeof item.label === "string" ? item.label : undefined,
    q: String(item.q ?? ""),
    url: item.url ? String(item.url) : undefined,
    category: String(item.category ?? ""),
    args: (item.args as Record<string, unknown>) ?? undefined,
    status: "pending" as const,
  };
}

/** A fresh conversation identity (the thread url's uuid). */
function newThreadId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-4${Math.random().toString(16).slice(2, 11)}`;
}

export function useAiSearch(capability: AiCapability | undefined): AiSearchState {
  const [core, setCore] = useState<Core>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  // the conversation identity rides a ref: start() mints it synchronously
  // and beginRun (called right after) must POST the NEW id, not the stale
  // state's
  const threadIdRef = useRef("");
  const entryIndexRef = useRef<Map<number, EntryIndex>>(new Map());
  // the current run's recalled-refs badge map (set at beginRun, read by
  // the sources fold)
  const refCountsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // the run's knowledge checkpoint: once the run is terminal its
  // projections land (idempotent per run id); DURING streaming the evt
  // buffer flushes on its own debounce, nothing else needs doing
  useEffect(() => {
    if ((core.phase !== "done" && core.phase !== "error") || !core.threadId) {
      return;
    }
    const last = core.runs[core.runs.length - 1];
    if (!last) {
      return;
    }
    void settleRun(core.threadId, last);
  }, [core.phase, core.threadId, core.runs]);

  const beginRun = (
    q: string,
    lang: string,
    history: Array<{ q: string; a: string }>,
    sourcesBase: number,
    mode: AiSearchMode,
    searchLanguage: string,
    runNo: number,
    clarify?: { state: "answered" | "skipped"; text: string },
  ) => {
    if (!capability) {
      return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const threadId = threadIdRef.current;
    entryIndexRef.current = new Map();
    const signal = controller.signal;
    void (async () => {
      // the browser recalls its knowledge BEFORE the POST, on TWO
      // dimensions: the corpus (sources + past answers, WRITER-phase only)
      // and the past_research index (archived full texts) -- each fusing
      // the hybrid (BM25+vector) and the tag-graph dimensions -- plus the
      // user-memory snapshot
      const [corpus, readerHits, userMemories] = await Promise.all([
        recallCorpus(q, 6).catch(() => []),
        recallPages(q, 4).catch(() => []),
        loadMemories().catch(() => []),
      ]);
      if (signal.aborted) {
        return;
      }
      const withUrl = corpus.filter((item) => item.url);
      // the cross-session badge's lookup: captured BEFORE this run links
      // anything (the run's own ref-count increment must not badge itself)
      const refCounts = new Map(withUrl.map((item) => [item.url as string, item.refs]));
      refCountsRef.current = refCounts;
      const body = {
        tk: capability.tk,
        q,
        lang,
        mode,
        history,
        sources_base: sourcesBase,
        search_language: searchLanguage,
        clarify_state: clarify?.state ?? "ask",
        clarifications: clarify?.text ?? "",
        thread: threadId || undefined,
        history_sources: withUrl.map((item) => ({ url: item.url as string, title: item.title })),
        user_memories: userMemories.map((memory) => memory.content),
        past_research: [
          ...readerHits.map((hit) => ({ url: hit.url, title: hit.title, text: hit.text })),
          ...withUrl.map((item) => ({ url: item.url as string, title: item.title, host: item.host ?? "" })),
        ],
      };
      const apply = (event: Record<string, unknown>) => {
        appendRunEvents(`${threadId}:${runNo}`, [event]);
        setCore((prev) => {
          if (prev.phase !== "streaming" && prev.phase !== "awaiting") {
            return prev;
          }
          return applyEvent(prev, event, LIVE_FX, refCounts);
        });
      };
      try {
        await fetchEventStream("/zjsearch/ai/search", body, apply, signal);
        // a stream that ends WITHOUT a settle (server restart) settles
        // locally -- no run hangs pending forever
        setCore((prev) =>
          prev.phase === "streaming"
            ? settle({ ...prev, runs: [...prev.runs] }, { error: "the AI stream ended without settling" }, false)
            : prev,
        );
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setCore((prev) => settle(prev, { error: message }, false));
      }
    })();
  };

  const start = (q: string, lang: string, mode: AiSearchMode = "balanced", searchLanguage = "") => {
    if (!capability) {
      return;
    }
    threadIdRef.current = newThreadId();
    setCore((prev) => ({
      ...applyEvent(
        { ...prev, threadId: threadIdRef.current },
        { e: "client.start", q, runNo: 1, mode, startedAt: Date.now() },
        LIVE_FX,
      ),
      threadId: threadIdRef.current,
    }));
    appendRunEvents(`${threadIdRef.current}:1`, [{ e: "client.start", q, runNo: 1, mode, startedAt: Date.now() }]);
    beginRun(q, lang, [], 0, mode, searchLanguage, 1);
  };

  const followup = (q: string, lang: string, mode: AiSearchMode = "balanced", searchLanguage = "") => {
    if (core.phase !== "done" || !q.trim()) {
      return;
    }
    const runNo = core.runs.length + 1;
    appendRunEvents(`${threadIdRef.current}:${runNo}`, [
      { e: "client.start", q: q.trim(), runNo, mode, startedAt: Date.now() },
    ]);
    beginRun(
      q.trim(),
      lang,
      core.runs.map((run) => ({ q: run.q, a: run.answer })),
      core.sources.length,
      mode,
      searchLanguage,
      runNo,
    );
    setCore((prev) => ({
      ...prev,
      phase: "streaming",
      runs: [...prev.runs, emptyRun(runNo, q.trim(), mode)],
    }));
  };

  const submitClarify = (text: string | null, lang: string, mode: AiSearchMode = "balanced", searchLanguage = "") => {
    if (core.phase !== "awaiting") {
      return;
    }
    const last = core.runs[core.runs.length - 1];
    if (!last) {
      return;
    }
    const runId = `${threadIdRef.current}:${last.runNo}`;
    appendRunEvents(runId, [{ e: "client.clarify", text: text ?? "", startedAt: Date.now(), mode }]);
    // prior ANSWERED runs travel as history; the awaiting run has none
    beginRun(
      last.q,
      lang,
      core.runs.slice(0, -1).map((run) => ({ q: run.q, a: run.answer })),
      core.sources.length,
      mode,
      searchLanguage,
      last.runNo,
      { state: text === null ? "skipped" : "answered", text: text ?? "" },
    );
    setCore((prev) =>
      applyEvent(prev, { e: "client.clarify", text: text ?? "", startedAt: Date.now(), mode }, LIVE_FX),
    );
  };

  const retry = (lang: string, mode: AiSearchMode = "balanced", searchLanguage = "") => {
    if (core.phase !== "done" && core.phase !== "error") {
      return;
    }
    const last = core.runs[core.runs.length - 1];
    if (!last) {
      return;
    }
    const runId = `${threadIdRef.current}:${last.runNo}`;
    appendRunEvents(runId, [{ e: "client.retry", clarify: last.clarify ?? "", startedAt: Date.now(), mode }]);
    beginRun(
      last.q,
      lang,
      core.runs.slice(0, -1).map((run) => ({ q: run.q, a: run.answer })),
      core.sources.length,
      mode,
      searchLanguage,
      last.runNo,
      last.clarify ? { state: "answered", text: last.clarify } : undefined,
    );
    setCore((prev) =>
      applyEvent(prev, { e: "client.retry", clarify: last.clarify ?? "", startedAt: Date.now(), mode }, LIVE_FX),
    );
  };

  const stop = () => {
    abortRef.current?.abort();
    const last = core.runs[core.runs.length - 1];
    if (last && threadIdRef.current) {
      appendRunEvents(`${threadIdRef.current}:${last.runNo}`, [{ e: "client.stop" }]);
    }
    setCore((prev) => applyEvent(prev, { e: "client.stop" }, LIVE_FX));
  };

  const reset = () => {
    abortRef.current?.abort();
    setCore(IDLE);
  };

  const resume = async (threadId: string): Promise<boolean> => {
    // the replay: the thread's evt log folds through the SAME reducer the
    // live stream used -- a stored run and a live run hit one renderer
    const events = await loadThreadEvents(threadId).catch(() => []);
    if (!events.length) {
      return false;
    }
    abortRef.current?.abort();
    threadIdRef.current = threadId;
    let core: Core = { ...IDLE, threadId };
    for (const entry of events) {
      core = applyEvent(core, entry.event as Record<string, unknown>, { ...REPLAY_FX, now: () => entry.at });
    }
    if (!core.runs.length) {
      return false;
    }
    // normalize: an interrupted run is a done run with interrupted call
    // rows; an awaiting clarify never survives a reload
    const runs = interruptPending(
      core.runs.map((run) => ({
        ...run,
        status: run.status === "streaming" || run.status === "awaiting" ? ("done" as const) : run.status,
        ask: null,
        wrappingUp: false,
      })),
    );
    setCore({ ...core, runs, phase: "done", error: null });
    return true;
  };

  return { ...core, start, followup, submitClarify, resume, retry, stop, reset };
}

function emptyRun(runNo: number, q: string, mode: AiSearchMode): AiSearchRun {
  return {
    runNo,
    q,
    status: "streaming",
    error: null,
    steps: [],
    answer: "",
    sources: [],
    galleries: [],
    related: [],
    ask: null,
    tasks: [],
    clarify: undefined,
    wrappingUp: false,
    startedAt: Date.now(),
    endedAt: null,
    mode,
  };
}
