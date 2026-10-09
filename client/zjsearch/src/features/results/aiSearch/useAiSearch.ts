// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useEffect, useRef, useState } from "react";
import { continueBrief } from "@/features/results/aiSearch/ledger.ts";
import type { ReportTemplate } from "@/features/results/aiSearch/reportTemplates.ts";
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
import { fetchEventStream, fetchJson } from "@/lib/http.ts";
import { loadThreadAttachments, saveAttachments } from "@/lib/kb/attachments.ts";
import {
  appendRunEvents,
  clearRunCtx,
  loadRunCtx,
  loadThreadEvents,
  saveRunCtx,
  seedSeqCounter,
  seedSeqCounterFromStore,
} from "@/lib/kb/events.ts";
import { archiveDocument, loadMemories, saveMemory, settleRun, startRun } from "@/lib/kb/projections.ts";
import { recallCorpus, recallPages } from "@/lib/kb/recall.ts";
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
  outline?: {
    title: string;
    subtitle?: string;
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
  // the continue path's re-entry guard (the double-click race)
  const continuingRef = useRef(false);
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
  ) => {
    if (!capability) {
      return;
    }
    runKeyRef.current = "";
    continuingRef.current = false;
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
        // the UI's "report" depth is the wire's deep mode + the report
        // output-shape flag (the server's SEARCH_MODES stay the three
        // research depths)
        mode: mode === "report" ? "deep" : mode,
        report: mode === "report" ? true : undefined,
        template: mode === "report" && template ? template : undefined,
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
        // line holds): the outline gate sees adjacent past topics, the
        // researcher's feed never does
        history_topics: [...new Set(withUrl.map((item) => String(item.title || "").trim()).filter(Boolean))].slice(
          0,
          8,
        ),
        user_memories: userMemories.map((memory) => memory.content),
        past_research: [
          ...readerHits.map((hit) => ({ url: hit.url, title: hit.title, text: hit.text })),
          ...withUrl.map((item) => ({ url: item.url as string, title: item.title, host: item.host ?? "" })),
        ],
      };
      // the run host seqs every event: an ATTACH replay starts after the
      // last SEEN seq, so the guard only fires on a genuine overlap (a
      // live tail racing a reconnect).  The field is stripped before it
      // reaches the evt log -- the fold cares about wire shapes only.
      let lastSeq = 0;
      let settled = false;
      const apply = (raw: Record<string, unknown>) => {
        const seq = typeof raw.seq === "number" ? raw.seq : 0;
        if (seq) {
          if (seq <= lastSeq) {
            return;
          }
          lastSeq = seq;
        }
        const event: Record<string, unknown> = { ...raw };
        if (seq) {
          delete event.seq;
        }
        if (event.e === "settle") {
          settled = true;
        }
        // the resume checkpoints are STORAGE-ONLY: the researcher's exact
        // message list upserts into its own knowledge row (never the evt
        // log -- the full list is redundant across rounds -- and never the
        // reducer); a continued run reads the row back as its request's
        // replayed conversation
        if (event.e === "ctx") {
          const messages = Array.isArray(event.messages) ? (event.messages as unknown[]) : [];
          if (messages.length) {
            saveRunCtx(`${threadId}:${runNo}`, threadId, messages).catch((error) => {
              console.warn("zjs: runctx save failed", error);
            });
          }
          return;
        }
        // VOLATILE BYTES never persist: the browser mirror's frames and
        // the web_browser rows' settlement images (screenshots, frames)
        // keep their meta in the event log but never the jpeg bytes -- a
        // replay shows the session's trail without the megabytes
        const persist =
          event.e === "browser" || (event.e === "call" && typeof event.img === "string" && event.img !== "")
            ? { ...event, img: "" }
            : event;
        appendRunEvents(`${threadId}:${runNo}`, [persist]);
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
      try {
        await fetchEventStream("/zjsearch/ai/search", body, apply, signal, (response) => {
          runKeyRef.current = response.headers.get("X-Zjs-Run-Id") ?? "";
        });
        // the run HOST keeps the run alive across a dropped connection:
        // reattach from the server's buffer (after the last SEEN seq)
        // before giving up -- the same run continues, never a restart
        if (!signal.aborted && !settled && runKeyRef.current) {
          for (let attempt = 0; attempt < 5; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
            if (signal.aborted) {
              return;
            }
            try {
              await fetchEventStream(
                "/zjsearch/ai/run/attach",
                { tk: capability.tk, run_key: runKeyRef.current, after_seq: lastSeq },
                apply,
                signal,
              );
              if (settled) {
                return;
              }
            } catch (error) {
              if (String(error).includes("HTTP 404")) {
                // the handle is GONE (server restart, swept TTL): no amount
                // of backoff revives it -- settle locally now instead of
                // making the user wait out the full backoff ladder
                break;
              }
              // the attach itself failed (network still down): the backoff
              // loop retries
            }
          }
        }
        // a stream that ends WITHOUT a settle (server restart, the attach
        // attempts exhausted) settles locally -- no run hangs pending forever
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

  const followup = (
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
      attachments,
    );
    setCore((prev) => ({
      ...prev,
      phase: "streaming",
      runs: [
        ...prev.runs,
        { ...emptyRun(runNo, q.trim(), mode), attachments: (attachments ?? []).filter((item) => item.data) },
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
  const continueRun = (lang: string, _mode: AiSearchMode = "balanced", searchLanguage = "") => {
    if (core.phase !== "done" && core.phase !== "error") {
      return;
    }
    if (continuingRef.current) {
      return; // the click is async (the ctx load) -- the phase check alone
      // lets a double-click race a second POST of the same resume payload
    }
    const last = core.runs[core.runs.length - 1];
    if (!last || last.answer) {
      return; // a run that produced an answer has nothing to continue
    }
    continuingRef.current = true;
    // 继续 resumes THE RUN's own shape
    const mode: AiSearchMode = last.mode;
    void (async () => {
      const runId = `${threadIdRef.current}:${last.runNo}`;
      const stored = await loadRunCtx(runId).catch((error) => {
        console.warn("zjs: runctx load failed", error);
        return null;
      });
      if (!stored) {
        console.info("zjs: no resume checkpoint for", runId, "-- legacy continue");
        continueLegacy(lang, mode, searchLanguage);
        return;
      }
      // a still-alive hosted run (the client's attach attempts gave up,
      // the server has not noticed yet): stop it BEFORE the resumed run
      // starts -- two researchers on one question is pure waste
      const staleKey = runKeyRef.current;
      if (staleKey && capability) {
        void fetchJson("/zjsearch/ai/run/control", {
          body: JSON.stringify({ tk: capability.tk, run_key: staleKey, action: "stop" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }).catch(() => {});
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
      };
      if (mode === "report" && last.outline?.sections.length) {
        // the interrupted report's TOC travels back: the server restores
        // it instead of re-minting a different skeleton mid-thread
        resume.outline = {
          title: last.outline.title,
          subtitle: last.outline.subtitle,
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

  const stop = () => {
    // the run host keeps runs alive past the connection: stopping is an
    // INSTRUCTION now, not a broken pipe (fire-and-forget -- the local
    // abort below stays the UI's own cutoff either way; the hosted run
    // sees the flag at its next event slice / round boundary)
    const runKey = runKeyRef.current;
    if (runKey && capability) {
      void fetchJson("/zjsearch/ai/run/control", {
        body: JSON.stringify({ tk: capability.tk, run_key: runKey, action: "stop" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).catch(() => {});
    }
    abortRef.current?.abort();
    const last = core.runs[core.runs.length - 1];
    if (last && threadIdRef.current) {
      appendRunEvents(`${threadIdRef.current}:${last.runNo}`, [{ e: "client.stop" }]);
    }
    setCore((prev) => applyEvent(prev, { e: "client.stop" }, LIVE_FX));
  };

  const steer = async (text: string, preempt = false): Promise<boolean> => {
    const runKey = runKeyRef.current;
    const value = text.trim();
    if (!runKey || !capability || !value) {
      return false;
    }
    try {
      const out = await fetchJson<{ ok: boolean }>("/zjsearch/ai/run/control", {
        body: JSON.stringify({
          tk: capability.tk,
          run_key: runKey,
          action: preempt ? "preempt" : "steer",
          text: value,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      return Boolean(out.ok);
    } catch {
      return false;
    }
  };

  const setTemplate = async (template: ReportTemplate): Promise<boolean> => {
    const runKey = runKeyRef.current;
    if (!runKey || !capability) {
      return false;
    }
    try {
      const out = await fetchJson<{ ok: boolean }>("/zjsearch/ai/run/control", {
        body: JSON.stringify({ tk: capability.tk, run_key: runKey, action: "template", template }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      return Boolean(out.ok);
    } catch {
      return false;
    }
  };

  const wrap = () => {
    const runKey = runKeyRef.current;
    if (!runKey || !capability) {
      return;
    }
    void fetchJson("/zjsearch/ai/run/control", {
      body: JSON.stringify({ tk: capability.tk, run_key: runKey, action: "wrap" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).catch(() => {});
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
    return true;
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
    wrap,
    reset,
  };
}
