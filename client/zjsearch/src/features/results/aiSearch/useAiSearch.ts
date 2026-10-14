// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useEffect, useRef, useState } from "react";
import { parseDepthMode } from "@/features/results/aiSearch/depth.tsx";
import { continueBrief } from "@/features/results/aiSearch/ledger.ts";
import type { ReportTemplate, TemplateShape } from "@/features/results/aiSearch/reportTemplates.ts";
import {
  type AiSearchAttachment,
  type AiSearchMode,
  applyEvent,
  type Core,
  type EntryIndex,
  emptyRun,
  type FoldFx,
  interruptPending,
  LATE_KINDS,
  settle,
} from "@/features/results/aiSearch/timeline.ts";
import { fetchEventStream, fetchJson, HttpError } from "@/lib/http.ts";
import { loadThreadAttachments, saveAttachments } from "@/lib/kb/attachments.ts";
import {
  appendRunEvents,
  clearRunCtx,
  deleteRunData,
  loadRunCtx,
  loadRunHost,
  loadThreadEvents,
  saveRunCtx,
  saveRunHost,
  seedSeqCounter,
  seedSeqCounterFromStore,
} from "@/lib/kb/events.ts";
import {
  archiveAttachments,
  archiveDocument,
  loadMemories,
  saveMemory,
  settleRun,
  startRun,
} from "@/lib/kb/projections.ts";
import { recallCorpus, recallPages } from "@/lib/kb/recall.ts";
import { type RunKeepalive, startRunKeepalive } from "@/lib/keepalive.ts";
import type { AiCapability } from "@/lib/types.ts";

/**
 * AI Search client state (POST /zjsearch/ai/search, NDJSON timeline ops) --
 * THREADED: every question (the initial one and each follow-up) appends a
 * run section to the page instead of replacing it.
 *
 * This file is the HOOK: the state owner, the stream consumer and the
 * storage bridge.  The wire-event fold itself (applyEvent + the run/call/
 * source types) lives in timeline.ts; the ledger helpers (tasks/learnings/
 * clarify grammar) live in ledger.ts -- the public surface is unchanged:
 * everything below re-exports what the rest of the app imports from here.
 *
 * The SERVER owns the timeline: every wire event is a closed-set timeline
 * operation (framework/wire.py).  This hook APPENDS; it reconstructs
 * nothing.  Follow-ups (`followup(q)`) append a new run to the thread: the
 * prior Q&A travels as conversation history and the global [n] numbering
 * continues after the existing sources (sources_base).
 */

export type {
  AiAskQuestion,
  AiSearchCall,
  AiSearchMode,
  AiSearchPhase,
  AiSearchRun,
  AiSearchSource,
  AiSearchStep,
} from "@/features/results/aiSearch/timeline.ts";
export { applyEvent, type FoldFx } from "@/features/results/aiSearch/timeline.ts";

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

export interface AiSearchState extends Core {
  start(
    q: string,
    lang: string,
    mode?: AiSearchMode,
    searchLanguage?: string,
    attachments?: AiSearchAttachment[],
    template?: ReportTemplate,
  ): void;
  followup(
    q: string,
    lang: string,
    mode?: AiSearchMode,
    searchLanguage?: string,
    attachments?: AiSearchAttachment[],
  ): void;
  /** answer the awaiting run's clarify questions (null = skip) and start
      its research on the SAME run */
  submitClarify(text: string | null, lang: string, mode?: AiSearchMode, searchLanguage?: string): void;
  /** the report rail's output-structure control: ONE pending template the
      write boundary consumes (research phase only -- the synthesizer
      re-mints the outline from it before the first section streams) */
  setTemplate(template: ReportTemplate): Promise<boolean>;
  /** the rail's shape flip (报告|演示文稿, research phase only): ONE
      pending shape the write boundary honors AND a canonical steer notice
      that adapts the researcher's remaining rounds (both server-composed) */
  setShape(shape: TemplateShape): Promise<boolean>;
  /** withdraw a previously-picked template (the free options of the
      unified picker): the write boundary consumes nothing */
  clearTemplate(): Promise<boolean>;
  /** delete ONE run from the thread -- its evt log, head row, runctx
      checkpoint and attachments leave the store and the timeline folds
      the section out (the stray extra run a legacy continue spawned) */
  deleteRun(runNo: number): void;
  /** re-run the last run IN PLACE (the failed box's retry / regenerate) */
  retry(lang: string, mode?: AiSearchMode, searchLanguage?: string): void;
  /** continue an INTERRUPTED research IN PLACE (the failed box's 继续):
      the dead attempt's stored conversation replays as the request's
      context -- same run, same timeline, numbering continues; a
      checkpoint-less run falls back to a fresh run seeded with the
      findings */
  continue(lang: string, mode?: AiSearchMode, searchLanguage?: string): void;
  /** restore a stored thread; false when the id is unknown */
  resume(threadId: string): Promise<boolean>;
  stop(): void;
  /** steer the LIVE run: guide = inject at the next round boundary;
      preempt = interrupt the in-flight turn and inject immediately.
      Resolves false when the run host rejects it (unknown run, steer
      queue full) -- the composer flips its pending chip to 未送达. */
  steer(text: string, preempt?: boolean): Promise<boolean>;
  /** 收尾: end the research gracefully and let the writer answer from
      the material gathered */
  wrap(): void;
  reset(): void;
}

/** A fresh conversation identity (the thread url's uuid). */
function newThreadId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-4${Math.random().toString(16).slice(2, 11)}`;
}

const STREAM_IDLE_MS = 170_000;
/** The stream watchdog's silence ceiling -- ABOVE every server-side
    quiet bound (the loop's 135s first-event / 125s idle timeouts, the
    synthesizer's 150s section streams), so a healthy run can never trip
    it.  Firing aborts a stream whose TCP path died silently (the
    half-open case: no error, no data, forever) and reattaches. */
const STREAM_IDLE_FALLBACK_MS = 300_000;
/** The watchdog's threshold when the keepalive worker is unavailable (no
    beat verdict to prove the network is up) -- longer, to ride out
    legitimately silent wait_user windows on the plain-silence signal. */
const REATTACH_WINDOW_MS = 300_000;
/** The auto-reattach ladder's total budget -- ride out transient network
    blips up to ~5 minutes IN PLACE instead of settling locally: the host
    outlives the connection (every run lingers), so a recovered stream
    still carries the run's live tail.  A 404 (handle gone) breaks out
    immediately; the failure box is for genuinely dead runs. */
const REATTACH_PROBE_MS = 6_000;
/** The continue-path attach probe's ladder budget -- the user just
    clicked, the network presumably works; two quick attempts, then the
    ctx-replay fallback takes over. */
const WATCHDOG_TICK_MS = 15_000;
const KICK_DELAY_MS = 1_500;
/** The beat is "fresh" within two keepalive intervals: a succeeded beat
    proves the network is up, so a silent stream is a dead stream. */
const BEAT_FRESH_MS = 100_000;

/** The CONTINUE replay payload: the dead attempt's ctx checkpoints (its
    exact conversation), its [n] sources (the server's registry reseeds so
    repeat urls reuse their numbers), the entry/round bases (the resumed
    stream's timeline ids continue the stored ones), and -- report mode --
    the stored outline (the server restores the document skeleton instead
    of re-minting a different TOC mid-thread). */
interface ResumePayload {
  messages: unknown[];
  sources: Array<{ n: number; url: string; title: string }>;
  entry_base: number;
  round_base: number;
  /** the dead attempt was INSIDE the writer: the server swaps in the
      write-direct resume note (no new gathering -- straight to the write) */
  write_direct?: boolean;
  outline?: {
    title: string;
    subtitle?: string;
    template?: string;
    sections: Array<{ title: string; brief?: string }>;
  };
}

export function useAiSearch(capability: AiCapability | undefined): AiSearchState {
  const [core, setCore] = useState<Core>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  // the conversation identity rides a ref: start() mints it synchronously
  // and beginRun (called right after) must POST the NEW id, not the stale
  // state's
  const threadIdRef = useRef("");
  // the CURRENT run's server-side handle (the run host's X-Zjs-Run-Id
  // response header): the reattach key for a dropped connection -- the
  // same run continues from the server buffer, never a restart.  Reset
  // per beginRun (the clarify / no-research streams carry no host).
  const runKeyRef = useRef("");
  // the live run's answer language -- the shape flip's steer wording is
  // composed server-side in this language
  const langRef = useRef("");
  // the continue path's re-entry guard (the double-click race)
  const continuingRef = useRef(false);
  const entryIndexRef = useRef<Map<number, EntryIndex>>(new Map());
  // the current run's recalled-refs badge map (set at beginRun, read by
  // the sources fold)
  const refCountsRef = useRef<Map<string, number>>(new Map());
  // the run host's seq watermark: the highest wire seq this client has
  // folded, shared by the main stream and every attach so replays and
  // live tails dedup against ONE monotonic guard.  Reset per beginRun
  // (a fresh run's host seqs from 1); an attach continues the same
  // handle's sequence.
  const lastSeqRef = useRef(0);
  // the last wire line's wall clock + the live keepalive verdict (the
  // stream watchdog's inputs) and the wait_user window flag (the
  // watchdog stands down while the run legitimately blocks on the user)
  const lastEventAtRef = useRef(0);
  const beatOkAtRef = useRef(0);
  const waitWindowRef = useRef(false);
  const settledRef = useRef(false);
  const heartbeatRef = useRef<RunKeepalive | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // the run's knowledge checkpoint: once the run is terminal its
  // projections land (idempotent per run id); DURING streaming the evt
  // buffer flushes on its own debounce, nothing else needs doing.  A
  // COMPLETED run's resume checkpoint dies here (nothing can continue
  // it); a failed one's stays -- the continue path's conversation.
  useEffect(() => {
    if ((core.phase !== "done" && core.phase !== "error") || !core.threadId) {
      return;
    }
    const last = core.runs[core.runs.length - 1];
    if (!last) {
      return;
    }
    if (last.status === "done" && !last.stopped) {
      // a finished run cannot be continued; a STOPPED one can (the user
      // may reverse the stop) -- its checkpoint stays
      void clearRunCtx(`${core.threadId}:${last.runNo}`).catch(() => {});
    }
    void settleRun(core.threadId, last);
  }, [core.phase, core.threadId, core.runs]);

  /** The wire fold for ONE run, shared by the main stream and every
      attach: the host seq guard is the HOOK-level watermark (a replay
      and a live tail racing two connections dedup against one
      monotonic counter), the watchdog's inputs update here. */
  const makeApply = (threadId: string, runNo: number, refCounts: Map<string, number>) => {
    const runId = `${threadId}:${runNo}`;
    return (raw: Record<string, unknown>) => {
      const seq = typeof raw.seq === "number" ? raw.seq : 0;
      if (seq) {
        if (seq <= lastSeqRef.current) {
          return;
        }
        lastSeqRef.current = seq;
      }
      lastEventAtRef.current = Date.now();
      // the wait_user window: the mirror frame's wait_left marks the run
      // legitimately blocked on the user -- the watchdog stands down
      // (the mirror event WITHOUT wait_left retires the window)
      if (raw.e === "browser") {
        waitWindowRef.current = raw.wait_left !== undefined;
      }
      const event: Record<string, unknown> = { ...raw };
      // the wire seq STAYS on the persisted row: a reloaded page recomputes
      // the run's server-seq watermark from the stored rows (the reload
      // recovery's after_seq -- without it a journal/attach replay cannot
      // dedup against what the pre-reload session already folded)
      if (event.e === "settle") {
        settledRef.current = true;
      }
      // the resume checkpoints are STORAGE-ONLY: the researcher's exact
      // message list upserts into its own knowledge row (never the evt
      // log -- the full list is redundant across rounds -- and never the
      // reducer); a continued run reads the row back as its request's
      // replayed conversation
      if (event.e === "ctx") {
        const messages = Array.isArray(event.messages) ? (event.messages as unknown[]) : [];
        if (messages.length) {
          saveRunCtx(runId, threadId, messages).catch((error) => {
            console.warn("zjs: runctx save failed", error);
          });
        }
        return;
      }
      // the server's attachment-conversion receipt (STORAGE-ONLY, the
      // ctx pattern): the extracted markdown lands in the knowledge
      // base as document rows -- searchable, embeddable, recallable by
      // future runs -- while the attachment table keeps the raw bytes
      // for the thread's replay.  Never the evt log, never the reducer.
      if (event.e === "attachment") {
        const items = Array.isArray(event.items) ? (event.items as unknown[]) : [];
        const docs = items
          .map((item) => item as { name?: unknown; mime?: unknown; text?: unknown })
          .filter((item) => typeof item.text === "string" && item.text.trim().length > 0)
          .map((item) => ({
            name: String(item.name ?? "attachment"),
            mime: String(item.mime ?? "text/markdown"),
            text: String(item.text ?? ""),
          }));
        if (docs.length) {
          archiveAttachments(threadId, runId, docs).catch((error) => {
            console.warn("zjs: attachment archive failed", error);
          });
        }
        return;
      }
      // VOLATILE BYTES mostly never persist: the browser mirror's frames
      // and the web_browser rows' settlement images keep their meta in
      // the event log but not the jpeg bytes -- a replay shows the
      // session's trail without the megabytes.  THE EXCEPTION is the
      // screenshot action's deliberate shot (wire mark `shot: true`,
      // the ZCode tool-result pattern): it persists so the row shows
      // the image in replays and the answer can reference it.
      const persist =
        event.e === "browser" ||
        (event.e === "call" && typeof event.img === "string" && event.img !== "" && event.shot !== true)
          ? { ...event, img: "" }
          : event;
      appendRunEvents(runId, [persist]);
      setCore((prev) => {
        // LATE wire events (related/memory/tags/usage) trail the settle
        // BY DESIGN -- the settled phases must still fold them (the
        // fallback suggestions render live, memory saves persist BEFORE
        // settleRun, tags park on the run, the gates correction lands);
        // everything else after the settle is dropped
        if (prev.phase !== "streaming" && prev.phase !== "awaiting" && !LATE_KINDS.has(String(event.e ?? ""))) {
          return prev;
        }
        return applyEvent(prev, event, LIVE_FX, refCounts);
      });
    };
  };

  interface StreamOutcome {
    settled: boolean;
    /** the FIRST stream's failure (HTTP errors, watchdog aborts) -- an
        HttpError's message is the failed box's text */
    error?: unknown;
    /** the LADDER's last attach failure -- the 404 verdict (handle gone)
        lives here, the continue path's probe reads it */
    attachError?: unknown;
  }

  /** One run's consumption machinery, shared by the run POST and the
      continue path's attach probe: the stream watchdog (a silent stream
      with fresh keepalive beats is a half-open socket -- abort and
      reattach), the extended reattach ladder (covers the run host's
      whole detach grace, so a blip recovers in place), the background
      kick listeners and the keepalive heartbeat.  NEVER local-settles --
      the caller owns the failure UI. */
  const consumeRunStream = async (
    threadId: string,
    runNo: number,
    refCounts: Map<string, number>,
    firstUrl: string,
    firstBody: unknown,
    onFirstResponse?: (response: Response) => void,
    reattachWindowMs = REATTACH_WINDOW_MS,
  ): Promise<StreamOutcome> => {
    if (!capability) {
      return { settled: false };
    }
    const apply = makeApply(threadId, runNo, refCounts);
    settledRef.current = false;
    lastEventAtRef.current = Date.now();
    const outer = abortRef.current;
    let current: AbortController | null = null;
    const openStream = (url: string, body: unknown, onResponse?: (response: Response) => void) => {
      const controller = new AbortController();
      current = controller;
      lastEventAtRef.current = Date.now();
      const onAbort = () => controller.abort();
      outer?.signal.addEventListener("abort", onAbort);
      return fetchEventStream(url, body, apply, controller.signal, onResponse).finally(() => {
        outer?.signal.removeEventListener("abort", onAbort);
        if (current === controller) {
          current = null;
        }
      });
    };
    // the BACKGROUND-TAB self-heal (visibility/online/page-lifecycle
    // resume): a frozen or dropped fetch can sit half-dead for the
    // whole run -- on return to the foreground an extra ATTACH streams
    // the missed tail (the seq guard dedups against a live stream);
    // the aux attach is UNTRACKED -- the watchdog only manages the
    // primary lane
    let kickTimer: ReturnType<typeof setTimeout> | null = null;
    const kick = () => {
      if (settledRef.current || outer?.signal.aborted || !runKeyRef.current || document.visibilityState !== "visible") {
        return;
      }
      if (kickTimer) clearTimeout(kickTimer);
      kickTimer = setTimeout(() => {
        kickTimer = null;
        if (settledRef.current || outer?.signal.aborted || !runKeyRef.current) return;
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        outer?.signal.addEventListener("abort", onAbort);
        fetchEventStream(
          "/zjsearch/ai/run/attach",
          { tk: capability.tk, run_key: runKeyRef.current, after_seq: lastSeqRef.current },
          apply,
          controller.signal,
        )
          .catch(() => {})
          .finally(() => outer?.signal.removeEventListener("abort", onAbort));
      }, KICK_DELAY_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") kick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", kick);
    document.addEventListener("resume", kick);
    const watchdog = setInterval(() => {
      if (settledRef.current || !current || outer?.signal.aborted) {
        return;
      }
      const idle = Date.now() - lastEventAtRef.current;
      // a fresh successful beat proves the network is up (every beat
      // opens a NEW connection) -- a silent stream then is a dead
      // stream; without the beat verdict only the long fallback
      // ceiling applies
      const beatsFresh = beatOkAtRef.current > 0 && Date.now() - beatOkAtRef.current < BEAT_FRESH_MS;
      const threshold = waitWindowRef.current
        ? Number.POSITIVE_INFINITY
        : beatsFresh
          ? STREAM_IDLE_MS
          : STREAM_IDLE_FALLBACK_MS;
      if (idle > threshold) {
        current.abort();
      }
    }, WATCHDOG_TICK_MS);
    let firstError: unknown;
    let attachError: unknown;
    try {
      try {
        await openStream(firstUrl, firstBody, (response) => {
          onFirstResponse?.(response);
          if (runKeyRef.current && !heartbeatRef.current) {
            heartbeatRef.current = startRunKeepalive(
              runKeyRef.current,
              { tk: capability.tk, run_key: runKeyRef.current },
              undefined,
              (ok) => {
                if (ok) beatOkAtRef.current = Date.now();
              },
            );
          }
        });
      } catch (error) {
        firstError = error;
      }
      // the run HOST keeps the run alive across a dropped connection:
      // reattach from the server's buffer (after the last SEEN seq)
      // before giving up -- the same run continues, never a restart.
      // The window covers the host's whole detach grace, so a blip
      // longer than the old 5-attempt ladder still recovers in place.
      const firstGone = firstError instanceof HttpError && firstError.status === 404;
      if (!settledRef.current && runKeyRef.current && !firstGone && !outer?.signal.aborted) {
        const deadline = Date.now() + reattachWindowMs;
        let attempt = 0;
        while (!settledRef.current && !outer?.signal.aborted && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** attempt)));
          attempt += 1;
          if (settledRef.current || outer?.signal.aborted) break;
          try {
            await openStream("/zjsearch/ai/run/attach", {
              tk: capability.tk,
              run_key: runKeyRef.current,
              after_seq: lastSeqRef.current,
            });
          } catch (error) {
            attachError = error;
            if (error instanceof HttpError && error.status === 404) {
              // the handle is GONE (server restart, swept TTL): no amount
              // of backoff revives it -- settle locally now instead of
              // making the user wait out the full backoff ladder
              break;
            }
            // the attach itself failed (network still down): retry
          }
        }
      }
    } finally {
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", kick);
      document.removeEventListener("resume", kick);
      if (kickTimer) clearTimeout(kickTimer);
      heartbeatRef.current?.stop();
      heartbeatRef.current = null;
    }
    if (outer?.signal.aborted) {
      return { settled: settledRef.current, error: firstError ?? attachError };
    }
    return { settled: settledRef.current, error: firstError, attachError };
  };

  const beginRun = (
    q: string,
    lang: string,
    history: Array<{ q: string; a: string }>,
    sourcesBase: number,
    mode: AiSearchMode,
    searchLanguage: string,
    runNo: number,
    clarify?: { state: "answered" | "skipped"; text: string },
    attachments?: AiSearchAttachment[],
    template?: ReportTemplate,
    resume?: ResumePayload,
    threadLedger?: { facts: string[]; gaps: string[] },
  ) => {
    if (!capability) {
      return;
    }
    runKeyRef.current = "";
    continuingRef.current = false;
    // a NEW run's host seqs from 1: the watermark resets with it (an
    // attach on the SAME handle continues the sequence -- only beginRun
    // resets)
    lastSeqRef.current = 0;
    waitWindowRef.current = false;
    beatOkAtRef.current = 0;
    // the shape-flip control's steer wording follows the RUN language
    // (the server composes the notice) -- remembered from beginRun
    langRef.current = lang;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const threadId = threadIdRef.current;
    entryIndexRef.current = new Map();
    const signal = controller.signal;
    // run-start persistence: the run row + the thread's directory entry
    // land NOW, not at settle -- a crashed tab or a dead network leaves a
    // visible, replayable run behind (the continue path's storage);
    // settleRun updates the same row, so this never double-counts
    startRun(threadId, { runNo, q, mode, startedAt: Date.now() });
    // the attachment BYTES land in the browser's own table (the server
    // stores nothing); the evt log carries metadata only
    const wireAttachments: Array<{
      kind: "image" | "file";
      mime: string;
      name?: string;
      bytes?: number;
      data?: string;
    }> = (attachments ?? []).map(({ kind, mime, name, bytes, data }) => ({ kind, mime, name, bytes, data }));
    saveAttachments(
      threadId,
      `${threadId}:${runNo}`,
      wireAttachments.filter((item): item is AiSearchAttachment & { data: string } => Boolean(item.data)),
    );
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
        // the UI's "report"/"deck" depths are the wire's deep mode + the
        // output-shape flag (the server's SEARCH_MODES stay the three
        // research depths; deck is the report machinery on the slide
        // contract -- the two flags are mutually exclusive)
        mode: mode === "report" || mode === "deck" ? "deep" : mode,
        report: mode === "report" ? true : undefined,
        deck: mode === "deck" ? true : undefined,
        template: (mode === "report" || mode === "deck") && template ? template : undefined,
        // the CONTINUE replay: the dead attempt's conversation rides the
        // request body -- the stateless server rebuilds its loop state
        // from it instead of a fresh first turn
        resume,
        attachments: wireAttachments.length ? wireAttachments : undefined,
        history,
        sources_base: sourcesBase,
        search_language: searchLanguage,
        clarify_state: clarify?.state ?? "ask",
        clarifications: clarify?.text ?? "",
        thread: threadId || undefined,
        history_sources: withUrl.map((item) => ({ url: item.url as string, title: item.title })),
        // the knowledge base's METADATA recall (titles only -- the red
        // line holds): the outline gate sees adjacent past topics AND the
        // user's uploaded files (the attachment documents), the
        // researcher's feed never does
        history_topics: [
          ...new Set(
            [
              ...withUrl.map((item) => String(item.title || "").trim()),
              ...readerHits.filter((hit) => !hit.url).map((hit) => hit.title.trim()),
            ].filter(Boolean),
          ),
        ].slice(0, 8),
        user_memories: userMemories.map((memory) => memory.content),
        // the thread ledger: the earlier runs' established facts + open
        // gaps (the sub-topic contract -- build on, never re-research)
        thread_ledger: threadLedger,
        past_research: [
          ...readerHits.map((hit) => ({ url: hit.url, title: hit.title, text: hit.text })),
          ...withUrl.map((item) => ({ url: item.url as string, title: item.title, host: item.host ?? "" })),
        ],
      };
      // the consumption machinery (the seq guard, the stream watchdog,
      // the reattach ladder, the heartbeat, the background kicks) is the
      // hook's shared consumeRunStream -- the probe path of continueRun
      // rides the exact same machinery against the attach endpoint
      try {
        const outcome = await consumeRunStream(threadId, runNo, refCounts, "/zjsearch/ai/search", body, (response) => {
          runKeyRef.current = response.headers.get("X-Zjs-Run-Id") ?? "";
          if (runKeyRef.current) {
            // the reload recovery's probe address (the journal fetch and
            // the live-host attach both key on it) -- out-of-log metadata
            saveRunHost(`${threadId}:${runNo}`, threadId, runKeyRef.current).catch(() => {});
          }
        });
        if (signal.aborted) {
          return;
        }
        if (!outcome.settled) {
          // a stream that ends WITHOUT a settle (server restart, the
          // attach ladder exhausted) settles locally -- no run hangs
          // pending forever; an HttpError's own message is the honest text
          const message =
            outcome.error instanceof HttpError ? outcome.error.message : "the AI stream ended without settling";
          setCore((prev) =>
            prev.phase === "streaming" ? settle({ ...prev, runs: [...prev.runs] }, { error: message }, false) : prev,
          );
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        // a death AFTER the settle (the late tail: related/memory/tags riding
        // the same stream) must not demote the COMPLETED run to a failure --
        // the local settle below is for runs that never settled
        setCore((prev) =>
          prev.phase === "streaming" || prev.phase === "awaiting" ? settle(prev, { error: message }, false) : prev,
        );
      }
    })();
  };

  const start = (
    q: string,
    lang: string,
    mode: AiSearchMode = "balanced",
    searchLanguage = "",
    attachments?: AiSearchAttachment[],
    template?: ReportTemplate,
  ) => {
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
    const meta = (attachments ?? []).map(({ kind, mime, name, bytes }) => ({ kind, mime, name, bytes }));
    appendRunEvents(`${threadIdRef.current}:1`, [
      { e: "client.start", q, runNo: 1, mode, startedAt: Date.now(), attachments: meta },
    ]);
    beginRun(q, lang, [], 0, mode, searchLanguage, 1, undefined, attachments, template);
    // the LIVE run shows the staged bytes immediately (the evt log only
    // carries metadata; the table owns the bytes for the replay path)
    const staged = (attachments ?? []).filter((item) => item.data);
    if (staged.length) {
      setCore((prev) => {
        const runs = [...prev.runs];
        const last = runs[runs.length - 1];
        if (last) {
          runs[runs.length - 1] = { ...last, attachments: staged };
        }
        return { ...prev, runs };
      });
    }
  };

  const followup = async (
    q: string,
    lang: string,
    mode: AiSearchMode = "balanced",
    searchLanguage = "",
    attachments?: AiSearchAttachment[],
  ) => {
    if (core.phase !== "done" || !q.trim()) {
      return;
    }
    const runNo = core.runs.length + 1;
    // THE THREAD CONTRACT: every later run is a sub-topic of the first --
    // (a) the prior runs' findings ledger + open gaps ride as the
    // thread_ledger (the researcher builds on them instead of
    // re-researching), and (b) FILE attachments attached earlier in the
    // thread ride along (a domain framework pinned once covers every
    // run) until manually removed from THIS run's picker.
    const seen = new Set<string>();
    const facts = core.runs
      .flatMap((run) => run.learnings ?? [])
      .filter((fact) => fact.status === "active" && fact.text && !seen.has(fact.text))
      .map((fact) => {
        seen.add(fact.text);
        return fact.text;
      })
      .slice(0, 40);
    const gaps = core.runs
      .flatMap((run) => run.gaps ?? [])
      .filter((gap) => gap.status === "open" && gap.q && !seen.has(gap.q))
      .map((gap) => {
        seen.add(gap.q);
        return gap.q;
      })
      .slice(0, 12);
    const threadLedger = facts.length || gaps.length ? { facts, gaps } : undefined;
    let merged = attachments;
    try {
      const prior = await loadThreadAttachments(threadIdRef.current);
      const manual = new Set((attachments ?? []).map((item) => item.name ?? ""));
      const inherited: AiSearchAttachment[] = [];
      for (const rows of prior.values()) {
        for (const row of rows) {
          if (row.kind !== "file" || !row.name || manual.has(row.name)) {
            continue;
          }
          if (inherited.some((item) => item.name === row.name)) {
            continue;
          }
          inherited.push(row);
        }
      }
      merged = inherited.length ? [...inherited.slice(0, 6), ...(attachments ?? [])] : attachments;
    } catch {
      merged = attachments;
    }
    const meta = (attachments ?? []).map(({ kind, mime, name, bytes }) => ({ kind, mime, name, bytes }));
    appendRunEvents(`${threadIdRef.current}:${runNo}`, [
      { e: "client.start", q: q.trim(), runNo, mode, startedAt: Date.now(), attachments: meta },
    ]);
    beginRun(
      q.trim(),
      lang,
      core.runs.map((run) => ({ q: run.q, a: run.answer })),
      core.sources.length,
      mode,
      searchLanguage,
      runNo,
      undefined,
      merged,
      undefined,
      undefined,
      threadLedger,
    );
    setCore((prev) => ({
      ...prev,
      phase: "streaming",
      runs: [
        ...prev.runs,
        { ...emptyRun(runNo, q.trim(), mode), attachments: (merged ?? []).filter((item) => item.data) },
      ],
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
    // THE WRITER-REGEN ROUTE: a run that already gathered material (a
    // report/deck outline, a partial or full answer, the write stage)
    // regenerates through the WRITER -- the stored conversation rides
    // back (write_direct) and the writer re-runs over it (the server
    // rehydrates the corpus/feed from the replayed tool results).  A
    // research-phase failure holds none of these and keeps the fresh
    // re-run below.
    if (last.outline || last.answer || last.stage === "write") {
      continueRun(lang, mode, searchLanguage, true);
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

  /** Continue an INTERRUPTED research (the failed box's 继续 button): the
      SAME run resumes in place -- the dead attempt's ctx checkpoint (its
      EXACT conversation) rides the request back and the server rebuilds
      its loop state from it (the [n] registry reseeds from the stored
      sources, the timeline ids continue via entry/round bases).  The
      run's OWN mode carries (the dropdown's current pick must not
      convert an interrupted report into a balanced answer).  A run
      without a checkpoint (predating the feature) falls back to the old
      contract: a new run seeded with the findings as the clarified
      direction. */
  const continueRun = (lang: string, _mode: AiSearchMode = "balanced", searchLanguage = "", forceWrite = false) => {
    if (core.phase !== "done" && core.phase !== "error") {
      return;
    }
    if (continuingRef.current) {
      return; // the click is async (the ctx load) -- the phase check alone
      // lets a double-click race a second POST of the same resume payload
    }
    const last = core.runs[core.runs.length - 1];
    if (!last) {
      return;
    }
    // NO material gate here: a RESEARCH-phase interruption (no outline, no
    // answer) is the continue contract's namesake case -- the checkpoint
    // resumes it in place below, and a checkpoint-less run (predating the
    // feature, or dead before its first round boundary) takes the legacy
    // fallback.  A silent no-op here stranded the failed box's and the
    // stopped pill's primary action (the buttons show on totalCalls > 0,
    // which a called-but-unanswered research satisfies).
    continuingRef.current = true;
    // 继续 resumes THE RUN's own shape
    const mode: AiSearchMode = last.mode;
    void (async () => {
      const runId = `${threadIdRef.current}:${last.runNo}`;
      // THE ATTACH PROBE comes first: the failed box can mean the client
      // gave up while the server run lived on (the old ladder's ~31s sat
      // far under the host's 90s detach grace -- the run kept writing,
      // sometimes to a real finish the client never saw).  A successful
      // probe RE-SUBSCRIBES to that handle: the buffer replays from the
      // last seen seq and the live tail follows -- a mid-write death
      // completes the very report it was writing, no restart.  A 404
      // (server restart, swept TTL) or a dead network falls through to
      // the ctx-replay restart below; a stopped run skips the probe (its
      // handle was told to stop -- the reverse-stop path replays).
      const staleKey = runKeyRef.current;
      if (staleKey && capability && last.status === "error" && !last.stopped) {
        appendRunEvents(runId, [{ e: "client.reattach", runNo: last.runNo, startedAt: Date.now() }]);
        setCore((prev) =>
          applyEvent(prev, { e: "client.reattach", runNo: last.runNo, startedAt: Date.now() }, LIVE_FX),
        );
        const outcome = await consumeRunStream(
          threadIdRef.current,
          last.runNo,
          refCountsRef.current,
          "/zjsearch/ai/run/attach",
          { tk: capability.tk, run_key: staleKey, after_seq: lastSeqRef.current },
          undefined,
          REATTACH_PROBE_MS,
        ).catch((error: unknown) => ({ settled: false, error, attachError: error as unknown }));
        if (outcome.settled) {
          continuingRef.current = false;
          return;
        }
        const probeError = (outcome.attachError ?? outcome.error) as unknown;
        const handleGone = probeError instanceof HttpError && probeError.status === 404;
        if (!handleGone) {
          // the probe failed on the network (or its ladder ran out): the
          // handle may still be alive -- stop it BEFORE the resumed run
          // starts (two researchers on one question is pure waste)
          void fetchJson("/zjsearch/ai/run/control", {
            body: JSON.stringify({ tk: capability.tk, run_key: staleKey, action: "stop" }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }).catch(() => {});
        }
      }
      const stored = await loadRunCtx(runId).catch((error) => {
        console.warn("zjs: runctx load failed", error);
        return null;
      });
      if (!stored) {
        console.info("zjs: no resume checkpoint for", runId, "-- legacy continue");
        continueLegacy(lang, mode, searchLanguage);
        return;
      }
      let entryBase = 0;
      let roundBase = 0;
      for (const step of last.steps) {
        const withEntry = step as { entry?: number };
        entryBase = Math.max(entryBase, Number(withEntry.entry) || 0);
        const withRound = step as { round?: number };
        roundBase = Math.max(roundBase, Number(withRound.round) || 0);
      }
      // the evt-log numbering floor: without this the fresh tab's counters
      // restart at 1 and every resumed event silently collides with the
      // stored rows (ON CONFLICT DO NOTHING) -- the resume streamed and
      // replayed as nothing
      await seedSeqCounterFromStore(runId).catch(() => {});
      const resume: ResumePayload = {
        messages: stored,
        sources: core.sources
          .filter((source) => source.url && source.n > 0)
          .map((source) => ({ n: source.n, url: source.url, title: source.title })),
        entry_base: entryBase,
        round_base: roundBase,
        // died inside the writer (or an explicit writer-regen): the resumed
        // run skips re-research and steers straight back into the write
        // (the server's note swap + the corpus/feed rehydration from the
        // replayed tool results)
        write_direct: forceWrite || last.stage === "write",
      };
      if ((mode === "report" || mode === "deck") && last.outline?.sections.length) {
        // the interrupted report/deck's TOC travels back: the server
        // restores it instead of re-minting a different skeleton mid-thread
        // (the template name rides along -- the 输出结构 card keeps its
        // identity face across the resume)
        resume.outline = {
          title: last.outline.title,
          subtitle: last.outline.subtitle,
          template: last.outline.template,
          sections: last.outline.sections.map((section) => ({ title: section.title, brief: section.brief })),
        };
      }
      appendRunEvents(runId, [{ e: "client.resume", runNo: last.runNo, mode, startedAt: Date.now() }]);
      beginRun(
        last.q,
        lang,
        [],
        core.sources.length,
        mode,
        searchLanguage,
        last.runNo,
        // clarify answered-EMPTY: if the server later rejects the stored
        // conversation (schema drift, oversize) the fallback is a fresh
        // run WITHOUT re-opening the clarify gate -- the run already
        // passed it once
        { state: "answered", text: "" },
        undefined,
        undefined,
        resume,
      );
      setCore((prev) =>
        applyEvent(prev, { e: "client.resume", runNo: last.runNo, mode, startedAt: Date.now() }, LIVE_FX),
      );
    })();
  };

  /** The pre-checkpoint fallback: a NEW run that inherits the ledger the
      old way -- the findings travel as the confirmed <clarified> block. */
  const continueLegacy = (lang: string, mode: AiSearchMode, searchLanguage: string) => {
    const last = core.runs[core.runs.length - 1];
    if (!last) {
      return;
    }
    const runNo = core.runs.length + 1;
    const text = continueBrief(last.q, last.learnings ?? [], last.gaps ?? []);
    appendRunEvents(`${threadIdRef.current}:${runNo}`, [
      { e: "client.start", q: last.q, runNo, mode, startedAt: Date.now(), continued: true },
    ]);
    beginRun(
      last.q,
      lang,
      core.runs.map((run) => ({ q: run.q, a: run.answer })),
      core.sources.length,
      mode,
      searchLanguage,
      runNo,
      {
        state: "answered",
        text,
      },
    );
    setCore((prev) => ({ ...prev, phase: "streaming", runs: [...prev.runs, emptyRun(runNo, last.q, mode)] }));
  };

  /** The run host's ONE control plane call (stop / steer / preempt /
      wrap / template / shape): every inbound lane posts through here --
      the action payload varies, the transport never does.  Resolves to
      the endpoint's `ok` (false when no live handle answers). */
  const control = async (action: string, extra: Record<string, unknown> = {}): Promise<boolean> => {
    const runKey = runKeyRef.current;
    if (!runKey || !capability) {
      return false;
    }
    try {
      const out = await fetchJson<{ ok: boolean }>("/zjsearch/ai/run/control", {
        body: JSON.stringify({ tk: capability.tk, run_key: runKey, action, ...extra }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      return Boolean(out.ok);
    } catch {
      return false;
    }
  };

  const stop = () => {
    // the run host keeps runs alive past the connection: stopping is an
    // INSTRUCTION now, not a broken pipe (fire-and-forget -- the local
    // abort below stays the UI's own cutoff either way; the hosted run
    // sees the flag at its next event slice / round boundary)
    void control("stop");
    abortRef.current?.abort();
    const last = core.runs[core.runs.length - 1];
    if (last && threadIdRef.current) {
      appendRunEvents(`${threadIdRef.current}:${last.runNo}`, [{ e: "client.stop" }]);
    }
    setCore((prev) => applyEvent(prev, { e: "client.stop" }, LIVE_FX));
  };

  const steer = (text: string, preempt = false): Promise<boolean> => {
    const value = text.trim();
    if (!value) {
      return Promise.resolve(false);
    }
    return control(preempt ? "preempt" : "steer", { text: value });
  };

  const setTemplate = (template: ReportTemplate): Promise<boolean> => control("template", { template });

  const setShape = (shape: TemplateShape): Promise<boolean> => control("shape", { shape, lang: langRef.current });

  const clearTemplate = (): Promise<boolean> => {
    // the unified picker's free options: withdraw a previously-picked
    // template (the write boundary consumes nothing -- the free outline
    // stands)
    return control("template");
  };

  const deleteRun = (runNo: number) => {
    const tid = threadIdRef.current;
    // storage first (the evt rows are the replay truth), then the fold
    void deleteRunData(tid, runNo);
    setCore((prev) => applyEvent(prev, { e: "client.delete_run", runNo }, LIVE_FX));
  };

  const wrap = () => {
    void control("wrap");
  };

  const reset = () => {
    abortRef.current?.abort();
    setCore(IDLE);
  };

  /** The store-empty fallback of the reload recovery: the browser's copy
      of the thread is gone (cleared, degraded store, another origin) --
      but the SERVER knows the thread uuid.  The journal's thread index
      resolves the run and its whole wire log replays from zero (the
      leading meta line seeds the timeline the events fold into). */
  const recoverFromJournal = async (threadId: string): Promise<boolean> => {
    if (!capability) {
      return false;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    threadIdRef.current = threadId;
    let seeded = false;
    let runKey = "";
    const apply = makeApply(threadId, 1, new Map());
    const wrapped = (raw: Record<string, unknown>) => {
      if (!seeded && raw.journal) {
        const meta = raw.journal as { run_key?: unknown; q?: unknown; mode?: unknown };
        runKey = String(meta.run_key ?? "");
        const q = String(meta.q ?? "");
        const mode = parseDepthMode(meta.mode == null ? null : String(meta.mode));
        runKeyRef.current = runKey;
        lastSeqRef.current = 0;
        entryIndexRef.current = new Map();
        settledRef.current = false;
        void saveRunHost(`${threadId}:1`, threadId, runKey).catch(() => {});
        appendRunEvents(`${threadId}:1`, [{ e: "client.start", q, runNo: 1, mode, startedAt: Date.now() }]);
        setCore((prev) => {
          const next = applyEvent(
            { ...prev, threadId },
            { e: "client.start", q, runNo: 1, mode, startedAt: Date.now() },
            LIVE_FX,
          );
          return { ...next, phase: "streaming", threadId };
        });
        seeded = true;
        return;
      }
      if (seeded) {
        apply(raw);
      }
    };
    await fetchEventStream(
      "/zjsearch/ai/run/journal",
      { tk: capability.tk, thread: threadId, after_seq: 0 },
      wrapped,
      controller.signal,
    ).catch(() => {});
    return seeded;
  };

  const resume = async (threadId: string): Promise<boolean> => {
    // the replay: the thread's evt log folds through the SAME reducer the
    // live stream used -- a stored run and a live run hit one renderer
    const events = await loadThreadEvents(threadId).catch(() => []);
    if (!events.length) {
      // the local store has nothing: ask the SERVER -- the journal's
      // thread index matches the uuid in the url
      return recoverFromJournal(threadId);
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
    // the attachments' BYTES load from the browser's table (the evt log
    // carries metadata only) -- a replayed run re-shows what was attached
    const attachmentsByRun = await loadThreadAttachments(threadId).catch(() => new Map());
    const runsWithAttach = core.runs.map((run) => {
      const rows = attachmentsByRun.get(`${threadId}:${run.runNo}`);
      return rows?.length ? { ...run, attachments: rows } : run;
    });
    core = { ...core, runs: runsWithAttach };
    // the evt-log numbering floor rides the replay: a follow-up run
    // started in THIS tab after a reload appends after the stored rows,
    // never from 1 (the resume path's seq-collision fix, replay side)
    for (const run of core.runs) {
      const runId = `${threadId}:${run.runNo}`;
      let max = 0;
      for (const entry of events) {
        if (entry.runId === runId && entry.n > max) {
          max = entry.n;
        }
      }
      seedSeqCounter(runId, max);
    }
    // normalize: an interrupted run is a done run with interrupted call
    // rows; an awaiting clarify never survives a reload; a mirror that
    // outlived its stream is DEAD (the live card must not render on a
    // replay, let alone auto-open a takeover for a run that is over)
    const runs = interruptPending(
      core.runs.map((run) => ({
        ...run,
        status: run.status === "streaming" || run.status === "awaiting" ? ("done" as const) : run.status,
        ask: null,
        browser: null,
        wrappingUp: false,
      })),
    );
    setCore({ ...core, runs, phase: "done", error: null });
    // THE RELOAD RECOVERY: a run that was IN FLIGHT at the disconnect
    // gets its true ending back -- probe the host (still live? the
    // reattach replays the missed tail), fall through to the journal
    // (the settled tail across restarts / past the terminal TTL), and
    // only then accept the interrupted state.  Awaiting runs stay
    // interrupted: their clarify card never survives a reload, and a
    // recovered ask without its card is a silent wait.
    const last = core.runs[core.runs.length - 1];
    if (last && last.status === "streaming") {
      void recoverAfterReload(threadId, last, events);
    }
    return true;
  };

  /** The reload recovery's ladder: the live host first (attach -- a
      background run may still be researching), then the journal (the
      run settled unattended).  Both consume through the shared fold, so
      the interrupted run wakes up live and completes in place; both
      missing leaves the interrupted state as it was (the 继续 path's
      business).  Runs whose stored rows predate the wire-seq persistence
      cannot be recovered -- there is no dedup base for a replay. */
  const recoverAfterReload = (
    threadId: string,
    run: { runNo: number },
    events: Array<{ runId: string; event: unknown }>,
  ) => {
    if (!capability) {
      return;
    }
    const runId = `${threadId}:${run.runNo}`;
    let afterSeq = 0;
    let sawUnsequenced = false;
    for (const entry of events) {
      if (entry.runId !== runId) {
        continue;
      }
      const evt = entry.event as { seq?: unknown; e?: unknown } | null;
      if (String(evt?.e ?? "").startsWith("client.")) {
        continue;
      }
      if (typeof evt?.seq === "number") {
        if (evt.seq > afterSeq) {
          afterSeq = evt.seq;
        }
      } else {
        // a pre-2026-10 row: the wire seq was stripped -- a replay has
        // no dedup base against the already-folded rows
        sawUnsequenced = true;
      }
    }
    void (async () => {
      const runKey = await loadRunHost(runId).catch(() => null);
      if (!runKey || sawUnsequenced) {
        return;
      }
      // wake the run up: the fold's phase guard drops events on a done
      // phase, and the run must render live while the tail streams
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      threadIdRef.current = threadId;
      runKeyRef.current = runKey;
      lastSeqRef.current = afterSeq;
      settledRef.current = false;
      setCore((prev) => ({
        ...prev,
        phase: "streaming",
        runs: prev.runs.map((item) =>
          item.runNo === run.runNo && item.status === "done" ? { ...item, status: "streaming" as const } : item,
        ),
      }));
      const giveUp = () => {
        if (!controller.signal.aborted) {
          setCore((prev) => ({
            ...prev,
            phase: "done",
            runs: prev.runs.map((item) =>
              item.runNo === run.runNo && item.status === "streaming" ? { ...item, status: "done" as const } : item,
            ),
          }));
        }
      };
      const outcome = await consumeRunStream(
        threadId,
        run.runNo,
        new Map(),
        "/zjsearch/ai/run/attach",
        { tk: capability.tk, run_key: runKey, after_seq: afterSeq },
        undefined,
        REATTACH_PROBE_MS,
      ).catch((error: unknown) => ({ settled: false, error, attachError: error as unknown }));
      if (outcome.settled || controller.signal.aborted) {
        return;
      }
      const probeError = (outcome.attachError ?? outcome.error) as unknown;
      if (!(probeError instanceof HttpError) || probeError.status !== 404) {
        // the network failed with the host MAYBE still alive: back to
        // the interrupted state -- the continue path owns the retry
        giveUp();
        return;
      }
      // the host is gone (restart / swept TTL): the journal is the last
      // copy of the true ending
      const journalled = await consumeRunStream(
        threadId,
        run.runNo,
        new Map(),
        "/zjsearch/ai/run/journal",
        { tk: capability.tk, run_key: runKey, after_seq: afterSeq },
        undefined,
        REATTACH_PROBE_MS,
      ).catch(() => ({ settled: false }));
      if (!journalled.settled) {
        giveUp();
      }
    })();
  };

  return {
    ...core,
    start,
    followup,
    submitClarify,
    resume,
    retry,
    continue: continueRun,
    stop,
    steer,
    setTemplate,
    setShape,
    clearTemplate,
    deleteRun,
    wrap,
    reset,
  };
}
