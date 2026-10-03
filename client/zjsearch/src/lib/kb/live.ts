// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store's LIVE subscriptions (PGlite's live plugin): the
    two listings that must re-render on writes -- the thread directory
    (re-fires on thread_head writes -- settle/pin/delete -- not on every
    evt flush) and the memories.  Every other surface polls on demand;
    these two ride the subscription because they are the always-open
    views. */

import type { MemoryRow } from "@/lib/kb/projections.ts";
import { sweepStaleRuns, type ThreadSummary } from "@/lib/kb/recall.ts";
import { type Pg, pg } from "@/lib/pg.ts";

/** A live query's unsubscribe handle. */
export interface StoreSubscription {
  unsubscribe(): void;
}

type LiveNamespace = import("@electric-sql/pglite/live").LiveNamespace;

async function liveQuery<T>(sql: string, params: unknown[], onUpdate: (rows: T[]) => void): Promise<StoreSubscription> {
  const db = (await pg()) as Pg & { live: LiveNamespace };
  const handle = await db.live.query<T>(sql, params, (results) => onUpdate((results.rows ?? []) as T[]));
  return {
    unsubscribe: () => {
      handle.unsubscribe().catch(() => {
        /* the session may already be gone */
      });
    },
  };
}

/** The thread directory as a live listing (re-fires on thread_head
    writes -- settle/pin/delete -- not on every evt flush). */
export function subscribeThreads(onUpdate: (threads: ThreadSummary[]) => void): Promise<StoreSubscription> {
  void pg().then(() => sweepStaleRuns());
  return liveQuery<Record<string, unknown>>(
    `SELECT thread_id AS id, title, preview, runs, sources, updated, pinned
     FROM thread_head ORDER BY pinned DESC, updated DESC LIMIT 40`,
    [],
    (rows) =>
      onUpdate(
        (rows ?? []).map((row) => ({
          id: String(row.id),
          title: String(row.title ?? ""),
          runs: Number(row.runs) || 0,
          sources: Number(row.sources) || 0,
          updated: Number(row.updated) || 0,
          pinned: Number(row.pinned) === 1,
          preview: String(row.preview ?? ""),
        })),
      ),
  );
}

/** The memories as a live listing. */
export function subscribeMemories(onUpdate: (memories: MemoryRow[]) => void): Promise<StoreSubscription> {
  return liveQuery<{ id: string; body: string; updated: number }>(
    "SELECT id, body, updated FROM knowledge WHERE kind = 'memory' ORDER BY created",
    [],
    (rows) =>
      onUpdate(
        (rows ?? []).map((row) => ({ id: row.id, content: String(row.body ?? ""), updated: Number(row.updated) || 0 })),
      ),
  );
}
