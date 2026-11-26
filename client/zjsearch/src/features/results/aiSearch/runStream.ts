// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The run stream's consumption machinery (the client half of the
    wire protocol's transport recovery): the watchdog, the reattach
    ladder, the background kick and the keepalive heartbeat -- one
    factory the run hook holds.  See useAiSearch.ts for the state
    side. */

import type { RefObject } from "react";
import { fetchEventStream, HttpError } from "@/lib/http.ts";
import { type RunKeepalive, startRunKeepalive } from "@/lib/keepalive.ts";
import { pg } from "@/lib/pg.ts";
import type { AiCapability } from "@/lib/types.ts";

export interface RunStreamContext {
  capability: AiCapability | undefined;
  seqWatermarkRef: RefObject<Map<string, number>>;
  settledRef: RefObject<boolean>;
  lastEventAtRef: RefObject<number>;
  abortRef: RefObject<AbortController | null>;
  awaitingHeadersRef: RefObject<boolean>;
  runKeyRef: RefObject<string | null>;
  heartbeatRef: RefObject<RunKeepalive | null>;
  beatOkAtRef: RefObject<number>;
  waitWindowRef: RefObject<boolean>;
  makeApply: (
    threadId: string,
    runNo: number,
    refCounts: Map<string, number>,
  ) => (event: Record<string, unknown>) => void;
}

export const STREAM_IDLE_MS = 170_000;
/** The stream watchdog's silence ceiling -- ABOVE every server-side
    quiet bound (the loop's 135s first-event / 125s idle timeouts), so a
    healthy run can never trip it.  Firing aborts a stream whose TCP path died silently (the
    half-open case: no error, no data, forever) and reattaches. */
export const STREAM_IDLE_FALLBACK_MS = 300_000;
/** The watchdog's threshold when the keepalive worker is unavailable (no
    beat verdict to prove the network is up) -- longer, to ride out
    legitimately silent wait_user windows on the plain-silence signal. */
const REATTACH_WINDOW_MS = 300_000;
/** The auto-reattach ladder's total budget -- ride out transient network
    blips up to ~5 minutes IN PLACE instead of settling locally: the host
    outlives the connection (every run lingers), so a recovered stream
    still carries the run's live tail.  A 404 (handle gone) breaks out
    immediately; the failure box is for genuinely dead runs. */
export const REATTACH_PROBE_MS = 6_000;
/** The continue-path attach probe's ladder budget -- the user just
    clicked, the network presumably works; two quick attempts, then the
    ctx-replay fallback takes over. */
const WATCHDOG_TICK_MS = 15_000;
const KICK_DELAY_MS = 1_500;
/** The beat is "fresh" within two keepalive intervals: a succeeded beat
    proves the network is up, so a silent stream is a dead stream. */
const BEAT_FRESH_MS = 100_000;

export const WAIT_WINDOW_CAP_MS = 600_000;
/** The wait_user stand-down's ceiling (B-2): frames are the heartbeats
    inside an interactive window, but a HALF-OPEN socket during it can
    never deliver the retiring frame -- the stand-down would last
    forever.  The takeover's own wait clock is bounded server-side (the
    window ends at the frame budget), so ten minutes covers any legal
    window with margin; past it the reattach ladder proves the run. */

/** The CONTINUE replay payload: the dead attempt's ctx checkpoints (its
    exact conversation), its [n] sources (the server's registry reseeds so
    repeat urls reuse their numbers), the entry/round bases (the resumed
    stream's timeline ids continue the stored ones), and -- report mode --
    the stored outline (the server restores the document skeleton instead
    of re-minting a different TOC mid-thread). */
export interface ResumePayload {
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

export interface StreamOutcome {
  settled: boolean;
  /** the FIRST stream's failure (HTTP errors, watchdog aborts) -- an
        HttpError's message is the failed box's text */
  error?: unknown;
  /** the LADDER's last attach failure -- the 404 verdict (handle gone)
        lives here, the continue path's probe reads it */
  attachError?: unknown;
}

export function createRunStreamConsumer(ctx: RunStreamContext) {
  return async function consumeRunStream(
    threadId: string,
    runNo: number,
    refCounts: Map<string, number>,
    firstUrl: string,
    firstBody: unknown,
    onFirstResponse?: (response: Response) => void,
    reattachWindowMs = REATTACH_WINDOW_MS,
  ): Promise<StreamOutcome> {
    if (!ctx.capability) {
      return { settled: false };
    }
    const capability = ctx.capability;
    const runId = `${threadId}:${runNo}`;
    const seenSeq = () => ctx.seqWatermarkRef.current.get(runId) ?? 0;
    const apply = ctx.makeApply(threadId, runNo, refCounts);
    // the store wakes WITH the stream -- off the submit path since the
    // submit-posts-immediately budget: the run's own recording needs it
    // within ~1.5s
    // anyway (the evt flush), and an early boot means the model's first
    // live-recall call finds a warm store instead of the 5s race
    void pg().catch(() => {});
    ctx.settledRef.current = false;
    ctx.lastEventAtRef.current = Date.now();
    const outer = ctx.abortRef.current;
    let current: AbortController | null = null;
    const openStream = (url: string, body: unknown, onResponse?: (response: Response) => void) => {
      const controller = new AbortController();
      current = controller;
      ctx.lastEventAtRef.current = Date.now();
      ctx.awaitingHeadersRef.current = true;
      const onAbort = () => controller.abort();
      outer?.signal.addEventListener("abort", onAbort);
      // the idle clock re-arms at HEADER time: everything before it is
      // the server's gate phase, not a dead stream
      return fetchEventStream(url, body, apply, controller.signal, (response) => {
        ctx.awaitingHeadersRef.current = false;
        ctx.lastEventAtRef.current = Date.now();
        onResponse?.(response);
      }).finally(() => {
        ctx.awaitingHeadersRef.current = false;
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
      if (
        ctx.settledRef.current ||
        outer?.signal.aborted ||
        !ctx.runKeyRef.current ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      if (kickTimer) clearTimeout(kickTimer);
      kickTimer = setTimeout(() => {
        kickTimer = null;
        if (ctx.settledRef.current || outer?.signal.aborted || !ctx.runKeyRef.current) return;
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        outer?.signal.addEventListener("abort", onAbort);
        fetchEventStream(
          "/zjsearch/ask/run/attach",
          { tk: capability.tk, run_key: ctx.runKeyRef.current, after_seq: seenSeq() },
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
      if (ctx.settledRef.current || !current || outer?.signal.aborted) {
        return;
      }
      if (ctx.awaitingHeadersRef.current) {
        return;
      }
      const idle = Date.now() - ctx.lastEventAtRef.current;
      // a fresh successful beat proves the network is up (every beat
      // opens a NEW connection) -- a silent stream then is a dead
      // stream; without the beat verdict only the long fallback
      // ceiling applies
      const beatsFresh = ctx.beatOkAtRef.current > 0 && Date.now() - ctx.beatOkAtRef.current < BEAT_FRESH_MS;
      // a wait_user window stands the watchdog down (frames ARE the
      // heartbeats) -- but a HALF-OPEN socket during the window would
      // otherwise stand down FOREVER (no retiring frame can arrive), so
      // the stand-down carries a ceiling: past it the reattach ladder
      // takes over and proves the run one way or the other
      const threshold = ctx.waitWindowRef.current
        ? WAIT_WINDOW_CAP_MS
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
          if (ctx.runKeyRef.current && !ctx.heartbeatRef.current) {
            ctx.heartbeatRef.current = startRunKeepalive(
              ctx.runKeyRef.current,
              { tk: capability.tk, run_key: ctx.runKeyRef.current },
              undefined,
              (ok) => {
                if (ok) ctx.beatOkAtRef.current = Date.now();
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
      // The window is the CLIENT's recovery budget (runs outlives the
      // connection since linger; a blip longer than the old 5-attempt
      // ladder still recovers in place).
      const firstGone = firstError instanceof HttpError && firstError.status === 404;
      if (!ctx.settledRef.current && ctx.runKeyRef.current && !firstGone && !outer?.signal.aborted) {
        const deadline = Date.now() + reattachWindowMs;
        let attempt = 0;
        while (!ctx.settledRef.current && !outer?.signal.aborted && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** attempt)));
          attempt += 1;
          if (ctx.settledRef.current || outer?.signal.aborted) break;
          try {
            await openStream("/zjsearch/ask/run/attach", {
              tk: capability.tk,
              run_key: ctx.runKeyRef.current,
              after_seq: seenSeq(),
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
      ctx.heartbeatRef.current?.stop();
      ctx.heartbeatRef.current = null;
    }
    if (outer?.signal.aborted) {
      return { settled: ctx.settledRef.current, error: firstError ?? attachError };
    }
    return { settled: ctx.settledRef.current, error: firstError, attachError };
  };
}
