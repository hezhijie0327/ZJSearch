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
    await pgQuery(
      `INSERT INTO run_event (run_id, n, thread_id, occurred_at, data)
       VALUES ${rows.join(",")} ON CONFLICT DO NOTHING`,
      values,
      client,
    );
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
