// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge base's portable snapshot (the cross-device path): a
    JSON file of the store's CONTENT -- knowledge rows, the run-event
    log, the thread directory, the per-run rollups and the memories.

    Vectors are DELIBERATELY excluded: an embedding is derivable, the
    importing device re-embeds through its OWN capability (the pending
    pass picks every imported row up -- content arrives, vectors follow),
    and an exported vector would be a cross-space hazard the moment the
    two devices disagree on the embedding model.  Attachments' raw
    bytes (data URLs) are skipped too -- the snapshot carries their
    CONVERTED text rows; the original files live with the user.  The
    ``usage`` bookkeeping rows and the trigger-maintained ``stats``
    ledger stay out for the same reason (an import re-fires both).

    Import MERGES: newer-updated wins per row, the local curation
    survives (pins, manual thread titles), immutable logs dedupe
    (run_event / run_summary), and every imported row lands unembedded
    -- the backfill pass segments and embeds it.  The whole import is
    one transaction: a rejected snapshot leaves the store untouched. */

import { enqueue, safeParse } from "@/lib/kb/shared.ts";
import { pg, pgTransaction, type QueryClient } from "@/lib/pg.ts";

export const SNAPSHOT_VERSION = 1;
/** The snapshot schema version -- a file whose version differs is
    refused (no best-effort import of an unreadable shape). */

type SnapshotRow = Record<string, unknown>;

export interface SnapshotMeta {
  version: number;
  exportedAt: number;
  counts: { knowledge: number; events: number; threads: number; runs: number; memories: number };
}

/** The exported columns, table by table -- the trigger-computed
    (head/bytes) and embedding columns never ride. */
const KNOWLEDGE_COLUMNS =
  "id, kind, thread_id, run_id, url_hash, url, host, title, body, meta, status, n, pinned, refs, cited, tags, search_text, created, updated, occurred_at";
const EVENT_COLUMNS = "run_id, n, thread_id, occurred_at, data";
const THREAD_COLUMNS = "thread_id, title, preview, runs, sources, reports, updated, pinned, title_manual";
const RUN_SUMMARY_COLUMNS =
  "run_id, thread_id, q, mode, model, status, events, sources, answer, usage, phases, started_at, settled_at";
const MEMORY_COLUMNS =
  "id, kind, body, origin, state, strength, last_seen, pinned, host, search_text, created, updated";

/** The jsonb columns that need an explicit cast in the VALUES lists. */
const JSONB_COLUMNS = new Set(["meta", "tags", "data", "usage", "phases"]);

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += size) {
    out.push(list.slice(at, at + size));
  }
  return out;
}

async function selectAll(client: QueryClient, columns: string, from: string, where = ""): Promise<SnapshotRow[]> {
  const rows = await client.query<SnapshotRow>(`SELECT ${columns} FROM ${from}${where}`);
  return (rows.rows ?? []) as SnapshotRow[];
}

/** One batched multi-row INSERT ... ON CONFLICT statement (a row a
    statement's param count stays far under PG's 65535 ceiling at the
    40-row chunk).  ``updateSet`` (the ``SET`` clause for the conflict
    branch) turns the insert into an upsert; ``updateWhere`` gates it. */
async function insertBatch(
  client: QueryClient,
  table: string,
  columns: string[],
  rows: SnapshotRow[],
  conflict: string,
  updateSet = "",
  updateWhere = "",
): Promise<number> {
  let total = 0;
  for (const batch of chunks(rows, 40)) {
    const placeholders: string[] = [];
    const params: unknown[] = [];
    batch.forEach((row, ix) => {
      const base = ix * columns.length;
      placeholders.push(
        `(${columns.map((column, c) => `$${base + c + 1}${JSONB_COLUMNS.has(column) ? "::jsonb" : ""}`).join(", ")})`,
      );
      for (const column of columns) {
        params.push(row[column] ?? null);
      }
    });
    const result = await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders.join(", ")}
       ON CONFLICT ${conflict}${updateSet ? ` DO UPDATE SET ${updateSet}` : " DO NOTHING"}${updateWhere ? ` WHERE ${updateWhere}` : ""}`,
      params,
    );
    total += result.affectedRows ?? result.rows.length;
  }
  return total;
}

/** Build the snapshot file's text (the admin panel's export action). */
export async function exportSnapshot(): Promise<{ json: string; meta: SnapshotMeta }> {
  const db = await pg();
  const [knowledge, events, threads, runs, memories] = await Promise.all([
    selectAll(db, KNOWLEDGE_COLUMNS, "knowledge", " WHERE kind <> 'usage'"),
    selectAll(db, EVENT_COLUMNS, "run_event"),
    selectAll(db, THREAD_COLUMNS, "thread_head"),
    selectAll(db, RUN_SUMMARY_COLUMNS, "run_summary"),
    selectAll(db, MEMORY_COLUMNS, "memory"),
  ]);
  const meta: SnapshotMeta = {
    version: SNAPSHOT_VERSION,
    exportedAt: Date.now(),
    counts: {
      knowledge: knowledge.length,
      events: events.length,
      threads: threads.length,
      runs: runs.length,
      memories: memories.length,
    },
  };
  return {
    json: JSON.stringify({ ...meta, knowledge, events, threads, runs, memories }),
    meta,
  };
}

export function totalImported(meta: SnapshotMeta): number {
  const counts = meta.counts;
  return counts.knowledge + counts.events + counts.threads + counts.runs + counts.memories;
}

interface ParsedSnapshot {
  knowledge: SnapshotRow[];
  events: SnapshotRow[];
  threads: SnapshotRow[];
  runs: SnapshotRow[];
  memories: SnapshotRow[];
}

function parseSnapshot(text: string): ParsedSnapshot {
  const parsed = safeParse(text) as Partial<ParsedSnapshot> & { version?: number };
  if (
    parsed.version !== SNAPSHOT_VERSION ||
    !Array.isArray(parsed.knowledge) ||
    !Array.isArray(parsed.events) ||
    !Array.isArray(parsed.threads) ||
    !Array.isArray(parsed.runs) ||
    !Array.isArray(parsed.memories)
  ) {
    throw new Error("not a zjsearch knowledge snapshot");
  }
  return parsed as ParsedSnapshot;
}

/** Merge a snapshot file's rows into the store (the admin panel's
    import action): one transaction, newer-updated wins per row, the
    local curation (pins / manual titles) survives, immutable logs
    dedupe.  Returns the acknowledged row count.  Throws on an invalid
    snapshot or a failed write (the caller toasts). */
export async function importSnapshot(text: string): Promise<number> {
  const parsed = parseSnapshot(text);
  return enqueue(() =>
    pgTransaction(async (tx) => {
      let imported = 0;
      imported += await insertBatch(
        tx,
        "knowledge",
        KNOWLEDGE_COLUMNS.split(", "),
        parsed.knowledge,
        "(id) DO UPDATE",
        [
          "title = EXCLUDED.title, body = EXCLUDED.body, meta = EXCLUDED.meta, status = EXCLUDED.status,",
          "tags = EXCLUDED.tags, search_text = EXCLUDED.search_text, refs = EXCLUDED.refs,",
          "cited = EXCLUDED.cited, updated = EXCLUDED.updated,",
          // the re-embed trigger: imported content lands in the pending
          // queue (its old vectors, if any, are not ours)
          "embedding = NULL, embed_model = NULL",
        ].join(" "),
        "EXCLUDED.updated > knowledge.updated",
      );
      imported += await insertBatch(tx, "run_event", EVENT_COLUMNS.split(", "), parsed.events, "(run_id, n)");
      imported += await insertBatch(
        tx,
        "thread_head",
        THREAD_COLUMNS.split(", "),
        parsed.threads,
        "(thread_id) DO UPDATE",
        [
          // the local curation survives the merge: a manual title stays
          // manual, the local pin stays
          "title = CASE WHEN thread_head.title_manual = 1 THEN thread_head.title ELSE EXCLUDED.title END,",
          "preview = EXCLUDED.preview, runs = EXCLUDED.runs, sources = EXCLUDED.sources,",
          "reports = EXCLUDED.reports, updated = EXCLUDED.updated,",
          "pinned = thread_head.pinned, title_manual = thread_head.title_manual",
        ].join(" "),
        "EXCLUDED.updated > thread_head.updated",
      );
      imported += await insertBatch(tx, "run_summary", RUN_SUMMARY_COLUMNS.split(", "), parsed.runs, "(run_id)");
      imported += await insertBatch(
        tx,
        "memory",
        MEMORY_COLUMNS.split(", "),
        parsed.memories,
        "(id) DO UPDATE",
        [
          "body = EXCLUDED.body, origin = EXCLUDED.origin, state = EXCLUDED.state,",
          "strength = EXCLUDED.strength, last_seen = EXCLUDED.last_seen, search_text = EXCLUDED.search_text,",
          "updated = EXCLUDED.updated, embedding = NULL, embed_model = NULL",
        ].join(" "),
        "EXCLUDED.updated > memory.updated",
      );
      return imported;
    }),
  );
}
