// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store's run-event stream (the evt log): the wire log in
    its OWN table (`run_event`, storage-only -- excluded from every
    retrieval index).  The live stream buffers events, flushed in
    debounced single-statement batches (a crashed tab loses at most one
    batch); the reads serve the replay (a stored run rebuilds from its evt
    rows through the same fold that rendered it live). */

import { enqueue, safeParse } from "@/lib/kb/shared.ts";
import { pgQuery, type QueryClient } from "@/lib/pg.ts";

/** Per-run wire-sequence counters and the unflushed event buffer. */
const seqCounters = new Map<string, number>();
const evtBuffers = new Map<string, Array<{ n: number; event: unknown; at: number }>>();
let evtFlushTimer: number | null = null;

function threadIdOf(runId: string): string {
  const cut = runId.lastIndexOf(":");
  return cut > 0 ? runId.slice(0, cut) : runId;
}

/** Buffer one wire event (or client event) of a live run.  The store owns
    the sequence: callers hand the event in arrival order, the store
    numbers it.  Flushes in debounced batches -- a crashed tab loses at
    most one batch. */
export function appendRunEvents(runId: string, events: unknown[]): void {
  if (events.length === 0) {
    return;
  }
  let seq = seqCounters.get(runId) ?? 0;
  const buffer = evtBuffers.get(runId) ?? [];
  for (const event of events) {
    seq += 1;
    buffer.push({ n: seq, event, at: Date.now() });
  }
  seqCounters.set(runId, seq);
  evtBuffers.set(runId, buffer);
  if (evtFlushTimer === null) {
    evtFlushTimer = window.setTimeout(() => {
      evtFlushTimer = null;
      void flushRunEvents();
    }, 1500);
  }
}

/** The raw flush body -- MUST run inside a queue task (settleRun calls
    it directly; awaiting the enqueuing wrapper from within a task would
    deadlock the queue on itself).  ONE multi-row INSERT statement per
    batch: atomic (a crashed tab either has the batch or not), and the
    live subscription never sees a half batch. */
export async function flushRunEventsBody(runId: string | undefined, client?: QueryClient): Promise<void> {
  const batches = runId ? [runId] : [...evtBuffers.keys()];
  for (const id of batches) {
    const buffer = evtBuffers.get(id);
    if (!buffer || buffer.length === 0) {
      continue;
    }
    evtBuffers.delete(id);
    const threadId = threadIdOf(id);
    const values: unknown[] = [];
    const rows = buffer.map((entry, index) => {
      values.push(id, entry.n, threadId, entry.at, JSON.stringify(entry.event));
      const base = index * 5;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb)`;
    });
    try {
      await pgQuery(
        `INSERT INTO run_event (run_id, n, thread_id, occurred_at, data)
         VALUES ${rows.join(",")} ON CONFLICT DO NOTHING`,
        values,
        client,
      );
    } catch (error) {
      // the batch returns to the buffer: a FAILED flush must not destroy
      // the events -- "a crashed tab loses at most one batch" is a crash
      // contract, not a broken-database one (a rolled-back settle
      // transaction used to eat the batch permanently)
      const existing = evtBuffers.get(id) ?? [];
      const merged = [...buffer, ...existing];
      merged.sort((a, b) => a.n - b.n);
      evtBuffers.set(id, merged);
      throw error;
    }
  }
}

function flushRunEvents(runId?: string): Promise<void> {
  return enqueue(() => flushRunEventsBody(runId));
}

/** One run's full event log (the replay source), ordered by wire seq. */
export async function loadRunEvents(runId: string): Promise<Array<{ n: number; event: unknown; at: number }>> {
  const rows = await pgQuery<{ n: number; data: unknown; occurred_at: number }>(
    "SELECT n, data, occurred_at FROM run_event WHERE run_id = $1 ORDER BY n",
    [runId],
  );
  return (rows ?? []).map(decodeEventRow);
}

/** Re-seed one run's wire-sequence counter from a KNOWN stored max (the
    replay path -- the loaded evt rows carry their n).  The counters are
    memory-only, and a fresh tab continuing a run whose rows already
    exist would renumber from 1 -- every resumed event colliding with the
    stored PK (run_id, n) and silently dropped by ON CONFLICT DO NOTHING
    (the resumed research streamed fine and replayed as nothing). */
export function seedSeqCounter(runId: string, storedMax: number): void {
  if (storedMax > (seqCounters.get(runId) ?? 0)) {
    seqCounters.set(runId, storedMax);
  }
}

/** The same reseed from the STORE itself (the continue path -- the tab
    holds no evt rows to read the max from). */
export async function seedSeqCounterFromStore(runId: string): Promise<void> {
  const rows = await pgQuery<{ maxn: number | null }>("SELECT max(n) AS maxn FROM run_event WHERE run_id = $1", [
    runId,
  ]);
  seedSeqCounter(runId, Number(rows?.[0]?.maxn ?? 0));
}

/** A whole thread's event log, runs in chronological order (events carry
    their arrival clock; the wire seq orders within a run). */
export async function loadThreadEvents(
  threadId: string,
): Promise<Array<{ runId: string; n: number; event: unknown; at: number }>> {
  const rows = await pgQuery<{ run_id: string; n: number; data: unknown; occurred_at: number }>(
    "SELECT run_id, n, data, occurred_at FROM run_event WHERE thread_id = $1 ORDER BY occurred_at, run_id, n",
    [threadId],
  );
  return (rows ?? []).map((row) => ({ ...decodeEventRow(row), runId: row.run_id }));
}

function decodeEventRow(row: { n: number; data: unknown; occurred_at: number }): {
  n: number;
  event: unknown;
  at: number;
} {
  // PGlite hands jsonb columns back as ALREADY-PARSED objects -- the
  // string path only fires for a legacy/text transport (parsing an
  // object would stringify it into "[object Object]" and lose the event)
  const raw: unknown = typeof row.data === "string" ? safeParse(row.data) : row.data;
  const event: unknown = raw && typeof raw === "object" ? raw : {};
  return { n: Number(row.n) || 0, event, at: Number(row.occurred_at) || 0 };
}

/** Every run id of a thread, in run order. */
export async function loadThreadRunIds(threadId: string): Promise<string[]> {
  const rows = await pgQuery<{ run_id: string }>(
    "SELECT run_id FROM knowledge WHERE thread_id = $1 AND kind = 'run' ORDER BY n",
    [threadId],
  );
  return (rows ?? []).map((row) => row.run_id);
}

// --- the resume checkpoints (the wire's storage-only `ctx` events) -------
//
// The loop emits the researcher's EXACT message list at every round
// boundary; the stateless server keeps no conversation, so the browser's
// store IS the only copy -- a continued run replays the last checkpoint
// as its request's conversation.  OUT-OF-LOG BY DESIGN: each checkpoint
// upserts ONE knowledge row (kind "runctx") instead of appending to the
// evt log -- the full list is redundant across rounds, an append-only
// log would pay O(rounds²) storage for snapshots only the last of which
// is ever read.  thread_id rides the row, so a thread delete sweeps it.

/** Upsert one run's resume checkpoint (the latest `ctx` wins). */
export async function saveRunCtx(runId: string, threadId: string, messages: unknown[]): Promise<void> {
  const body = JSON.stringify(messages);
  await pgQuery(
    `INSERT INTO knowledge (id, kind, thread_id, run_id, title, body, bytes, created, updated, occurred_at)
     VALUES ($1, 'runctx', $2, $3, $3, $4, $5, $6, $6, $6)
     ON CONFLICT (id) DO UPDATE SET body = $4, bytes = $5, updated = $6`,
    [`runctx:${runId}`, threadId, runId, body, body.length, Date.now()],
  );
}

/** One run's stored resume checkpoint (the replayed conversation), or
    ``null`` (an old run that predates the checkpoints). */
export async function loadRunCtx(runId: string): Promise<unknown[] | null> {
  const rows = await pgQuery<{ body: string }>("SELECT body FROM knowledge WHERE id = $1 AND kind = 'runctx'", [
    `runctx:${runId}`,
  ]);
  const body = (rows ?? [])[0]?.body;
  if (!body) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Drop one run's resume checkpoint (a COMPLETED run's is dead weight --
    nothing can continue it). */
export async function clearRunCtx(runId: string): Promise<void> {
  await pgQuery("DELETE FROM knowledge WHERE id = $1 AND kind = 'runctx'", [`runctx:${runId}`]);
}
