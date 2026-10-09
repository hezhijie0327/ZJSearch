// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { AiSearchGallery } from "@/features/results/aiOverview.ts";
import {
  completeTasks,
  type LedgerFact,
  type LedgerGap,
  learningFacts,
  learningGaps,
  mergeTaskSnapshot,
  parseClarifyPairs,
} from "@/features/results/aiSearch/ledger.ts";

/**
 * The AI Search timeline fold (the client half of the wire protocol v2):
 * every wire event is a closed-set timeline operation (framework/wire.py)
 * -- deltas carry their entry id and channel (`think` / `say` / `answer`),
 * calls belong to their entry, one `settle` declares the terminal state.
 * This fold APPENDS; it reconstructs nothing (the old
 * answerFrom/pending/thinkOpen heuristics are gone with the protocol that
 * required them).  Steps mirror the entries one-to-one: a research entry
 * renders as its think segment, its intent narration and its call rows.
 *
 * ONE reducer, TWO executions: the live stream folds through `applyEvent`
 * with the LIVE side effects (reader pages archive, memories persist);
 * a stored thread's evt log replays through the same function with
 * no-op persistence -- a stored run and a live run hit one renderer.
 */

export type AiSearchMode = "speed" | "balanced" | "deep" | "report";
/** "report" is a UI-level depth: it POSTs `mode: "deep"` + `report: true`
    (the server's output-shape flag) -- the wire itself only knows the
    three research depths plus the report flag. */

/** The run's macro stages (the wire's ``phase`` events -- Qwen Deep
    Research's spine): one value active at a time, the history kept for
    the run_summary record. */
export type AiSearchStage = "plan" | "research" | "write";
/** "awaiting": the clarify gate asked for the user's direction -- the run
    lives on until they answer (or skip) via submitClarify. */
export type AiSearchPhase = "idle" | "streaming" | "awaiting" | "done" | "error";

/** One user-attached image on a run (the composer's paperclip): METADATA
    only in the event log / fold -- the bytes live in the browser's
    attachment table and are filled in by the resume path (`data`). */
export interface AiSearchAttachment {
  /** "image" = data URL bytes; "file" = the document (md/txt as TEXT,
      pdf/docx/pptx/xlsx as base64 bytes -- the server converts) */
  kind: "image" | "file";
  mime: string;
  name?: string;
  bytes?: number;
  /** image: the compressed data URL; file: the document's text or its
      base64 bytes -- present in the live run and after the
      attachment-table join, absent from the folded event metadata */
  data?: string;
}

export interface AiAskQuestion {
  q: string;
  type: "single" | "multi";
  options: string[];
}

export interface AiSearchCall {
  /** 1-based position of the call within its round */
  id: number;
  /** which tool produced the row */
  tool:
    | "web_search"
    | "web_reader"
    | "calculator"
    | "mcp"
    | "user_memory"
    | "past_research"
    | "task_write"
    | "learnings"
    | "judge"
    | "ask_user"
    | "extract_table"
    | "view_image"
    | "web_browser"
    | "research_subtask";
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
  /** web_browser rows: the page state the action left the session on --
      the row's expansion renders it as the location line */
  page?: { url: string; title: string };
  /** web_browser rows: the volatile frame jpeg (data URL) the action
      captured -- the screenshot's shot, the others' mirror frame.  NEVER
      persisted (stripped before the event log); a replay shows the
      trail without the bytes */
  img?: string;
  /** web_browser rows: the fresh element outline (open / snapshot / a
      click-through navigation) -- the expansion renders the session's
      interactive-element list */
  snapshot?: string;
  /** calculator: the exact evaluated result (the row shows expr = result) */
  result?: string;
  /** judge: the STRUCTURED verdict (question name -> choice/score/noul
      answer with its probability distribution) -- the row's expansion
      renders the same probability bars as the rail's decision card */
  answers?: Record<string, unknown>;
  /** web_reader: the extracted page content -- the row's expansion is a
      READING PANE of what the model actually read, not a link card */
  text?: string;
  /** the model's RAW tool-call arguments (q / category / ...) -- the
      timeline row's debug expansion shows exactly what was passed */
  args?: Record<string, unknown>;
  /** the model's RECEIPT: the head (800 chars) of the exact tool-result
      text the executor put in the round's feeds -- the debug expansion's
      second pane (empty dropped) */
  feed?: string;
  /** the call's wall time in milliseconds (the executor's settlement:
      pooled calls time submit -> settlement, inline branches time
      themselves) */
  ms?: number;
  /** web_search: a RE-search whose hits were all already-numbered
      produced no new sources -- these are the KNOWN [n]s the row's
      result strip resolves against the run's registry, so the row still
      expands to what it found */
  dupes?: number[];
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
  | {
      kind: "steer";
      /** the user's steered course correction (the 引述行) */
      text: string;
      /** guide = injected at the round boundary; preempt = interrupted
          the in-flight turn and injected immediately */
      delivery: "guide" | "preempt";
      /** discarded = the write phase had already closed the guide lane
          (the composer's pending chip flips to 未送达) */
      status: "drained" | "discarded";
    }
  | {
      kind: "sub";
      /** the subagent's OWN entry-id space (base 10000, disjoint from
          the lead's counter) -- think/call events route into `inner`
          by it */
      entry: number;
      title: string;
      objective: string;
      status: "active" | "done";
      inner: AiSearchStep[];
    }
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
  /** the engines that reported this result + the relevance score -- the
      card's engines row (the traditional result card's footer) */
  engines?: string[];
  score?: number;
  /** the type-aware meta (video duration / torrent filesize -- the
      classic presentations' tile badge) */
  meta?: string;
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
    rerank?: { calls: number; tokens: number };
    decision?: { calls: number; tokens: number };
  } | null;
  /** the server's halt explanation carried on settle (stall verdict,
      truncation, transport cut) -- the meta row renders it */
  halt?: string | null;
  /** the WRITER's own thread title (the related fence's title field, or
      the settle-tail's generated fallback) -- the thread_head projection
      adopts it unless the user renamed manually */
  title?: string;
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
  /** the BELIEF LEDGER's facts (the learnings tool's authoritative
      snapshots): what the researcher recorded as established, WITH the
      revision history (superseded/retracted stay visible on the card) --
      the writer received the active list as <findings> */
  learnings?: LedgerFact[];
  /** the ledger's gaps partition: the open questions the research still
      owed -- the findings card renders them under the facts */
  gaps?: LedgerGap[];
  /** the macro stage the run is in right now (the wire's ``phase``
      events) -- the PhaseStrip renders it; undefined = no phase events
      (legacy threads) and the strip stays hidden */
  stage?: AiSearchStage;
  /** every stage the run walked, in order -- the run_summary record */
  stages: AiSearchStage[];
  /** the run's DECISION RESULTS (framework gates + model judge), one
      entry per decision call -- the rail's 决策结果 card renders them
      with click-through raw answers */
  decisions: AiDecision[];
  /** the user's attached images for THIS question (metadata; `data`
      filled live / by the resume's attachment-table join) */
  attachments?: AiSearchAttachment[];
  /** the REPORT mode's document skeleton (the wire's ``outline``
      snapshot): absent = the single-write answer shape */
  outline?: AiSearchOutline;
  /** the report's per-section markdown buffers (the ``section`` deltas,
      keyed by section id -- the document renders them in outline order) */
  sections?: Record<string, string>;
  /** the recorded data tables (the ``artifact`` events, keyed by id) */
  artifacts?: Record<number, AiSearchArtifact>;
  /** the interactive session's live mirror (the web_browser call's
      viewport frames -- img stripped before persisting; null = no
      session or the run replays).  THE LEAD session's frame. */
  browser: { url: string; title: string; img: string; w: number; h: number; waitLeft?: number } | null;
  /** ALL live browser sessions keyed by session id (v2.1 R3B: the lead
      plus one per delegating subagent -- the rail card's tab strip).
      The lead also rides ``browser`` (the takeover's auto-open watch
      and the old render path). */
  browserSessions?: Record<
    string,
    { url: string; title: string; img: string; w: number; h: number; waitLeft?: number }
  >;
}

/** The REPORT mode's outline snapshot (the wire's ``outline`` event): the
    document's TOC -- the server synthesizes the summary/method sections,
    their status rides the same snapshot. */
export interface AiSearchOutlineSection {
  id: string;
  title: string;
  brief?: string;
  status: "pending" | "writing" | "done";
}

export interface AiSearchOutline {
  title: string;
  subtitle?: string;
  sections: AiSearchOutlineSection[];
}

/** One recorded data table (the ``extract_table`` tool's ``artifact``
    event, snapshot-replace per id): the researcher's structured
    evidence with per-row [n] refs resolved against the run's sources. */
export interface AiSearchArtifact {
  id: number;
  title: string;
  columns: string[];
  rows: Array<{ cells: string[]; refs: number[] }>;
  note?: string;
}

/** One decision-model call (loop gates or the model's judge tool): the
    question asked, the target it was about, and the RAW answer
    (verdicts + probabilities) for click-through. */
export interface AiDecision {
  purpose: string;
  question?: string;
  target?: string;
  answer?: unknown;
  raw?: unknown[];
  ms?: number;
  /** the wire entry verbatim (structured renderers read purpose-specific
      fields off it -- verdicts/citations/counts) */
  record?: Record<string, unknown>;
  /** the name→题文 map the generic verdict renderer labels rows with
      (server judgments carry it beside `answers`) */
  record_questions?: Array<{ name?: unknown; instructions?: unknown }>;
}

/** The fold's state: the threaded runs plus the thread-wide surfaces
    (phase, flat [n] registry, conversation identity). */
export interface Core {
  phase: AiSearchPhase;
  runs: AiSearchRun[];
  /** the flat [n] registry across the thread (citation jumps, follow-up
      numbering base) */
  sources: AiSearchSource[];
  error: string | null;
  threadId: string;
}

/** Entries as step indices: think/say/calls events route by entry id. */
export type EntryIndex = { think?: number; intent?: number; calls?: number };

export const LATE_KINDS = new Set(["related", "title", "memory", "tags", "usage"]);
/** The wire's LATE_EVENTS: they trail the settle on purpose and must
    fold in the settled phases too (the live-fold guard above). */

/** Settle every still-pending call row (abort / stream cut / error settle):
    no timeline row spins forever. */
export function interruptPending(runs: AiSearchRun[]): AiSearchRun[] {
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

export function settle(core: Core, failed: { error: string } | null, stopped: boolean, now = Date.now()): Core {
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
  const settled = interrupted.map((item) =>
    item.status === "streaming"
      ? {
          ...item,
          status: "done" as const,
          tasks: completeTasks(item.tasks),
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

/** The fold's side-effect ports: the LIVE run archives reader pages and
    persists memories as their events arrive and stamps the wall clock;
    a REPLAY no-ops the persistence (it happened live) and stamps the
    event's own arrival time (the duration displays stay truthful). */
export interface FoldFx {
  archive(url: string, title: string, text: string): void;
  saveMemory(content: string): void;
  now(): number;
}

/** The wire-event fold: one timeline operation in, the next state out.
    Exported for the knowledge page's replay (see the module doc). */
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
    // attachment METADATA rides the bootstrap event (the bytes live in the
    // browser's attachment table, never in the event log)
    const rawAttach = (Array.isArray(event.attachments) ? event.attachments : []) as Array<Record<string, unknown>>;
    if (rawAttach.length) {
      // the simulator's fixtures inline the bytes (no attachment table in
      // the debug stage); the live wire event carries metadata only
      fresh.attachments = rawAttach.map((raw) => ({
        kind: (raw.kind === "file" ? "file" : "image") as AiSearchAttachment["kind"],
        mime: String(raw.mime ?? ""),
        name: String(raw.name ?? "") || undefined,
        bytes: Number(raw.bytes) || 0,
        data: String(raw.data ?? "") || undefined,
      }));
    }
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
  // a SUBAGENT's entry (base 10000): its think/say/call events route into
  // the sub row's inner timeline instead of the lead's flat steps
  const subIndexOf = run.steps.findIndex((step) => step.kind === "sub" && step.entry === entryId);
  const inSub = run.steps[subIndexOf];
  const patchSub = (patch: (sub: Extract<AiSearchStep, { kind: "sub" }>) => Extract<AiSearchStep, { kind: "sub" }>) => {
    const steps = [...run.steps];
    steps[subIndexOf] = patch(steps[subIndexOf] as Extract<AiSearchStep, { kind: "sub" }>);
    runs[lastIdx] = { ...run, steps };
    return { ...core, runs };
  };

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
        browser: null,
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
        // re-opens the rebuilt timeline.  The LEDGER resets with the
        // attempt: the server built a fresh Searches (empty learnings, a
        // fresh task list) -- showing the dead attempt's findings card
        // and task states would present state the writer never received
        learnings: [],
        tasks: [],
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
    case "client.resume": {
      // the SAME run continues in place (the dead attempt's conversation
      // rides the request back as the replayed context): steps, sources,
      // ledger and cards all survive -- only the failure state resets.
      // The server-side ledgers restart empty and refill as the model
      // re-affirms them (the resume note instructs exactly that), so the
      // visible cards never flash empty.
      runs[lastIdx] = {
        ...run,
        status: "streaming",
        error: null,
        ask: null,
        browser: null,
        wrappingUp: false,
        endedAt: null,
        mode: (event.mode as AiSearchMode) ?? run.mode,
      };
      return { ...core, runs, phase: "streaming" };
    }
    case "ctx": {
      // storage-only wire event (the resume checkpoint): intercepted
      // BEFORE the fold on the live path -- this case only proves the
      // reducer tolerates one (a fixture, a future path)
      return core;
    }
    case "phase": {
      // the macro-stage spine: one value active, the history kept (the
      // run_summary record replays it); unknown names ignore
      const name = String(event.name ?? "") as AiSearchStage;
      if (!["plan", "research", "write"].includes(name)) {
        return core;
      }
      const stages = run.stages[run.stages.length - 1] === name ? run.stages : [...run.stages, name];
      runs[lastIdx] = { ...run, stage: name, stages };
      return { ...core, runs };
    }
    case "open": {
      if (String(event.kind) === "sub") {
        // a delegation's sub row opens: the live mini-timeline container.
        // The child RE-OPENS per round (same id) -- an existing row just
        // goes back to active, never duplicates
        const existing = run.steps.findIndex((step) => step.kind === "sub" && step.entry === entryId);
        if (existing >= 0) {
          return patchSub((sub) => ({ ...sub, status: "active" }));
        }
        runs[lastIdx] = {
          ...run,
          steps: [
            ...run.steps,
            {
              kind: "sub",
              entry: entryId,
              title: String(event.title ?? ""),
              objective: String(event.objective ?? ""),
              status: "active",
              inner: [],
            },
          ],
        };
        return { ...core, runs };
      }
      if (String(event.kind) === "write") {
        // the writer phase opened: the 撰写 line covers its silence
        runs[lastIdx] = { ...run, wrappingUp: true };
        return { ...core, runs };
      }
      return core;
    }
    case "think": {
      // a research/write entry's reasoning: its own think segment
      if (inSub) {
        return patchSub((sub) => ({
          ...sub,
          inner: [...sub.inner, { kind: "think", text: String(event.t ?? "") }],
        }));
      }
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
      const text = String(event.t ?? "");
      if (inSub) {
        return patchSub((sub) => ({
          ...sub,
          inner: [...sub.inner, { kind: "intent", text }],
        }));
      }
      const steps = [...run.steps];
      const idx = stepIndexFor("intent");
      if (idx >= 0) {
        const step = steps[idx] as Extract<AiSearchStep, { kind: "intent" }>;
        steps[idx] = { ...step, text: step.text + text };
      } else {
        steps.push({ kind: "intent", text, entry: entryId });
      }
      runs[lastIdx] = { ...run, steps };
      return { ...core, runs };
    }
    case "steer": {
      // a user steering of the live run: the 引述行 rides the timeline
      // (the record shows WHERE the course changed)
      const steps = [...run.steps];
      steps.push({
        kind: "steer",
        text: String(event.text ?? ""),
        delivery: String(event.delivery ?? "guide") === "preempt" ? "preempt" : "guide",
        status: String(event.status ?? "drained") === "discarded" ? "discarded" : "drained",
      });
      runs[lastIdx] = { ...run, steps };
      return { ...core, runs };
    }
    case "calls": {
      const items = (event.items as Array<Record<string, unknown>>) ?? [];
      if (inSub) {
        return patchSub((sub) => ({
          ...sub,
          inner: [
            ...sub.inner,
            {
              kind: "calls",
              entry: entryId,
              round: sub.inner.filter((step) => step.kind === "calls").length + 1,
              calls: items.map((item) => normalizeCall(item)),
            },
          ],
        }));
      }
      // the in-round display index: max existing + 1 (a resumed run's
      // steps keep their stored rounds -- a count would restart at 1)
      const round = run.steps.reduce((max, step) => Math.max(max, step.kind === "calls" ? step.round : 0), 0) + 1;
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
      if (inSub) {
        return patchSub((sub) => ({
          ...sub,
          inner: sub.inner.map((step) => {
            if (step.kind !== "calls" || step.entry !== entryId) {
              return step;
            }
            const settleOne = (call: AiSearchCall): AiSearchCall =>
              call.id === callId
                ? {
                    ...call,
                    status: (event.status as AiSearchCall["status"]) ?? "error",
                    ...(event.n !== undefined ? { n: Number(event.n) || 0 } : {}),
                    ...(event.ms !== undefined ? { ms: Number(event.ms) || 0 } : {}),
                    ...(event.chars !== undefined ? { chars: Number(event.chars) || 0 } : {}),
                    ...(event.feed !== undefined ? { feed: String(event.feed ?? "") || undefined } : {}),
                    ...(event.label !== undefined ? { label: String(event.label ?? "") || undefined } : {}),
                  }
                : call;
            return { ...step, calls: step.calls.map(settleOne) };
          }),
        }));
      }
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
                  ...(event.ms !== undefined ? { ms: Number(event.ms) || 0 } : {}),
                  ...(event.feed !== undefined ? { feed: String(event.feed ?? "") || undefined } : {}),
                  ...(event.chars !== undefined ? { chars: Number(event.chars) || 0 } : {}),
                  ...(event.result !== undefined ? { result: String(event.result ?? "") } : {}),
                  ...(event.answers !== undefined && event.answers !== null
                    ? { answers: event.answers as Record<string, unknown> }
                    : {}),
                  ...(event.text !== undefined ? { text: String(event.text ?? "") || undefined } : {}),
                  ...(event.dupes !== undefined
                    ? {
                        dupes: (Array.isArray(event.dupes) ? event.dupes : [])
                          .map((n) => Number(n) || 0)
                          .filter((n) => n > 0),
                      }
                    : {}),
                  ...(event.preview !== undefined ? { text: String(event.preview ?? "") || undefined } : {}),
                  ...(event.label !== undefined ? { label: String(event.label ?? "") || undefined } : {}),
                  ...(event.action !== undefined ? { name: String(event.action ?? "") } : {}),
                  // web_browser settlements: the page state, the volatile
                  // frame jpeg and the fresh outline (img stripped from
                  // the persisted copy by the stream consumer)
                  ...(event.page !== undefined && event.page !== null
                    ? {
                        page: {
                          url: String((event.page as Record<string, unknown>).url ?? ""),
                          title: String((event.page as Record<string, unknown>).title ?? ""),
                        },
                      }
                    : {}),
                  ...(event.img !== undefined ? { img: String(event.img ?? "") || undefined } : {}),
                  ...(event.snapshot !== undefined ? { snapshot: String(event.snapshot ?? "") || undefined } : {}),
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
    case "browser": {
      // the interactive session's mirror frame: replaces wholesale (img
      // stripped before persisting -- the event log keeps meta only).
      // R3B: the frames carry their session id (agent) -- the lead's
      // frame also rides run.browser (the takeover's auto-open watch)
      const sid = String(event.agent || "lead");
      const view = {
        url: String(event.url ?? ""),
        title: String(event.title ?? ""),
        img: String(event.img ?? ""),
        w: Number(event.w) || 1280,
        h: Number(event.h) || 800,
        ...(event.wait_left !== undefined ? { waitLeft: Number(event.wait_left) || 0 } : {}),
      };
      runs[lastIdx] = {
        ...run,
        ...(sid === "lead" ? { browser: view } : {}),
        browserSessions: { ...(run.browserSessions ?? {}), [sid]: view },
      };
      return { ...core, runs };
    }
    case "close":
      if (inSub) {
        // the subagent settled: its row flips to done (the digest arrived
        // as the delegation call's tool result)
        return patchSub((sub) => ({ ...sub, status: "done" }));
      }
      return core;
    case "tasks": {
      const items = (event.items as Array<Record<string, unknown>>) ?? [];
      runs[lastIdx] = { ...run, tasks: mergeTaskSnapshot(run.tasks, items) };
      return { ...core, runs };
    }
    case "decisions": {
      // the run's decision results (framework gates + model judge): the
      // rail's 决策结果 card reads them -- raw answers included
      const items = (Array.isArray(event.items) ? event.items : []).map((row) => {
        const record = row as Record<string, unknown>;
        return {
          purpose: String(record.purpose ?? ""),
          question: typeof record.question === "string" ? record.question : undefined,
          target: typeof record.target === "string" ? record.target : undefined,
          // judge 工具的裁决键是 verdicts(其余是 answers)
          answer: record.answer ?? record.answers ?? record.verdicts ?? record.raw ?? undefined,
          // record_questions(name→题文)并入 record,通用渲染器的
          // 标签解析链由此读取
          ...(Array.isArray(record.record_questions)
            ? { record_questions: record.record_questions as AiDecision["record_questions"] }
            : {}),
          ms: typeof record.ms === "number" ? record.ms : undefined,
          record,
        };
      });
      runs[lastIdx] = { ...run, decisions: [...(run.decisions ?? []), ...items] };
      return { ...core, runs };
    }
    case "learnings": {
      // the BELIEF LEDGER's AUTHORITATIVE snapshot -- replace, never
      // merge (the server's list is the truth, the writer read the same)
      runs[lastIdx] = {
        ...run,
        learnings: learningFacts(event.items),
        gaps: learningGaps(event.gaps),
      };
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
          engines: Array.isArray(item.engines) ? item.engines.map((e) => String(e)).slice(0, 4) : undefined,
          score: typeof item.score === "number" ? item.score : undefined,
          meta: String(item.meta ?? "") || undefined,
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
    case "outline": {
      // the REPORT mode's authoritative snapshot -- replace, never merge
      const rawSections = (Array.isArray(event.sections) ? event.sections : []) as Array<Record<string, unknown>>;
      if (!rawSections.length) {
        return core;
      }
      runs[lastIdx] = {
        ...run,
        outline: {
          title: String(event.title ?? ""),
          subtitle: String(event.subtitle ?? "") || undefined,
          sections: rawSections.map((raw) => ({
            id: String(raw.id ?? ""),
            title: String(raw.title ?? ""),
            brief: String(raw.brief ?? "") || undefined,
            status: (["pending", "writing", "done"].includes(String(raw.status)) ? String(raw.status) : "pending") as
              | "pending"
              | "writing"
              | "done",
          })),
        },
        sections: run.sections ?? {},
        artifacts: run.artifacts ?? {},
      };
      return { ...core, runs };
    }
    case "artifact": {
      // ONE recorded table -- snapshot-replace per id
      const id = Number(event.id) || 0;
      const item = event.item as Record<string, unknown> | undefined;
      if (!id || !item) {
        return core;
      }
      const artifact: AiSearchArtifact = {
        id,
        title: String(item.title ?? ""),
        columns: ((item.columns as unknown[]) ?? []).map(String),
        rows: ((item.rows as Array<Record<string, unknown>>) ?? []).map((row) => ({
          cells: ((row.cells as unknown[]) ?? []).map(String),
          refs: ((row.refs as unknown[]) ?? []).map((ref) => Number(ref) || 0).filter((ref) => ref > 0),
        })),
        note: String(item.note ?? "") || undefined,
      };
      runs[lastIdx] = { ...run, artifacts: { ...(run.artifacts ?? {}), [id]: artifact } };
      return { ...core, runs };
    }
    case "section": {
      // the report's per-section markdown delta -- the section buffer AND
      // the answer document grow together (the answer field stays the one
      // full-text the knowledge projection and the copy path read)
      const id = String(event.id ?? "");
      const delta = String(event.t ?? "");
      if (!id || !delta) {
        return core;
      }
      // a markdown block boundary BETWEEN sections: the per-section panes
      // render their own bodies, but the combined answer (knowledge
      // projection, copy/export) glues sections back to back -- without
      // the separator a section starting with `###` lands mid-paragraph
      // and renders as literal text
      const sep = run.answer && !run.answer.endsWith("\n") ? "\n\n" : "";
      runs[lastIdx] = {
        ...run,
        sections: { ...(run.sections ?? {}), [id]: (run.sections?.[id] ?? "") + delta },
        answer: run.answer + sep + delta,
      };
      return { ...core, runs };
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
    case "title":
      runs[lastIdx] = { ...run, title: String(event.text ?? "").slice(0, 60) };
      return { ...core, runs };
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
        browser: null,
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
              rerank: usage.rerank,
              decision: usage.decision,
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

const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  "web_search",
  "web_reader",
  "calculator",
  "mcp",
  "user_memory",
  "past_research",
  "task_write",
  "learnings",
  "judge",
  "ask_user",
  "extract_table",
  "view_image",
  "web_browser",
  "research_subtask",
]);

function normalizeCall(item: Record<string, unknown>): AiSearchCall {
  const tool = String(item.tool ?? "");
  return {
    id: Number(item.id) || 0,
    tool: (KNOWN_TOOLS.has(tool) ? tool : "web_search") as AiSearchCall["tool"],
    name: typeof item.name === "string" ? item.name : undefined,
    label: typeof item.label === "string" ? item.label : undefined,
    q: String(item.q ?? ""),
    url: item.url ? String(item.url) : undefined,
    category: String(item.category ?? ""),
    args: (item.args as Record<string, unknown>) ?? undefined,
    feed: typeof item.feed === "string" && item.feed ? item.feed : undefined,
    ms: typeof item.ms === "number" ? item.ms : undefined,
    status: "pending" as const,
  };
}

/** A fresh run row in the streaming state (the timeline's seed). */
export function emptyRun(runNo: number, q: string, mode: AiSearchMode): AiSearchRun {
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
    stages: [],
    gaps: [],
    decisions: [],
    sections: {},
    artifacts: {},
    browser: null,
  };
}
