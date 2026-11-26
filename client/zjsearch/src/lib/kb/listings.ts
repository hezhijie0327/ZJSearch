// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge directory's flat listing reads: the thread
    directory (with the stale-run sweep), the reading pane, the
    per-kind and per-tag lists and the episode rollup.  Every
    surface reads the same tables the writes land in -- no
    in-memory mirror. */

import { listMemoryItems } from "@/lib/kb/memory.ts";
import { enqueue, ITEM_COLUMNS, type KnowledgeItem, rowToItem, safeParse } from "@/lib/kb/shared.ts";
import { pg, pgQuery } from "@/lib/pg.ts";
import { rerankConfigured, rerankDocs } from "@/lib/rerank.ts";

export interface ThreadSummary {
  id: string;
  title: string;
  runs: number;
  sources: number;
  /** the thread's REPORT-mode runs (run.meta.report settles it) -- the
      directory's Reports badge + filter read it */
  reports: number;
  /** the DISTINCT run modes across the thread's runs (overview / speed /
      balanced / deep) -- the directory's mode tags read it */
  modes?: string[];
  updated: number;
  pinned: boolean;
  /** the latest run's answer head -- the row shows the result, the
      thread page is the detail */
  preview: string;
}

const STALE_RUN_MS = 2 * 60 * 60 * 1000;
/** A run streaming for longer than this died with its tab: the settle
    checkpoint lives in the page, a closed browser takes it with it. */

let staleSwept = false;

/** One sweep per session (at the first directory read): runs whose row
    still says "streaming" but that have been silent for two hours settle
    as errors -- the row, its events and its replay stay intact, only the
    forever-"streaming" lie is corrected.  A resumed thread heals the
    rest (the replay's own settle re-runs the projections). */
export function sweepStaleRuns(): void {
  if (staleSwept) {
    return;
  }
  staleSwept = true;
  void enqueue(async () => {
    await pgQuery(
      `UPDATE knowledge SET status = 'error',
         meta = jsonb_set(meta, '{halted}', '"the run was interrupted -- the browser closed mid-research"')
       WHERE kind = 'run' AND status = 'streaming' AND updated < $1`,
      [Date.now() - STALE_RUN_MS],
    );
  });
}

/** The thread directory: the thread_head projection (maintained at
    settle -- the old GROUP BY aggregate re-fired on every evt flush). */
/** The thread_head modes aggregate (a json array column, possibly null)
    as a clean string list. */
export function modesOf(value: unknown): string[] {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
}

/** Every thread's DISTINCT run modes (the directory's mode tags), one
    shot -- the LIVE thread subscription must stay a plain thread_head
    select (pglite's liveQuery re-execution chokes on the modes
    subquery), so the tags refresh out-of-band and merge in the page. */
export async function listThreadModes(): Promise<Record<string, string[]>> {
  await pg();
  const rows = await pgQuery<{ thread_id: string; modes: unknown }>(
    "SELECT thread_id, json_agg(DISTINCT mode) AS modes FROM (SELECT thread_id, meta->>'mode' AS mode FROM knowledge WHERE kind = 'run' AND meta->>'mode' IS NOT NULL) GROUP BY thread_id",
  );
  const out: Record<string, string[]> = {};
  for (const row of rows ?? []) {
    const modes = typeof row.modes === "string" ? safeParse(row.modes) : row.modes;
    if (Array.isArray(modes)) {
      out[String(row.thread_id)] = modes.map(String).filter(Boolean);
    }
  }
  return out;
}

/** The reading materials: the sources the research cited + the full
    texts archived from the reader -- one directory, newest first. */
export async function listReading(limit = 40): Promise<KnowledgeItem[]> {
  const [sources, documents] = await Promise.all([listKind("source", limit), listKind("document", limit)]);
  return [...sources, ...documents].sort((a, b) => b.updated - a.updated).slice(0, limit);
}

export async function listThreads(limit = 30, offset = 0): Promise<ThreadSummary[]> {
  await pg();
  sweepStaleRuns();
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT h.thread_id AS id, h.title, h.preview, h.runs, h.sources, h.reports, h.updated,
       (SELECT json_agg(DISTINCT m.mode) FROM (SELECT kr.meta->>'mode' AS mode FROM knowledge kr
        WHERE kr.thread_id = h.thread_id AND kr.kind = 'run' AND kr.meta->>'mode' IS NOT NULL) m) AS modes
     FROM thread_head h ORDER BY h.updated DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return (rows ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ""),
    runs: Number(row.runs) || 0,
    sources: Number(row.sources) || 0,
    reports: Number(row.reports) || 0,
    modes: modesOf(row.modes),
    updated: Number(row.updated) || 0,
    pinned: Number(row.pinned) === 1,
    preview: String(row.preview ?? ""),
  }));
}

/** The items carrying one tag (the graph's locate-to-content panel) --
    the GIN index answers the membership. */
export async function itemsByTag(tag: string, limit = 20): Promise<KnowledgeItem[]> {
  await pg();
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT ${ITEM_COLUMNS} FROM knowledge
     WHERE kind IN ('run', 'source', 'document') AND tags ? $1
     ORDER BY updated DESC LIMIT $2`,
    [tag, limit],
  );
  return (rows ?? []).map(rowToItem);
}

/** One kind's rows, newest first -- the filter chips' non-search listing
    (answers / sources / documents as their own directories).  The memory
    kind reads its own table. */
export async function listKind(kind: string, limit = 40): Promise<KnowledgeItem[]> {
  if (kind === "memory") {
    return listMemoryItems(limit);
  }
  await pg();
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT ${ITEM_COLUMNS} FROM knowledge WHERE kind = $1 ORDER BY updated DESC LIMIT $2`,
    [kind, limit],
  );
  return (rows ?? []).map(rowToItem);
}

/** The EPISODIC lane (the tripartite refactor's third layer): recent
    research episodes from the thread directory -- what the user studied
    lately, so a returning question can continue instead of restart.
    Candidates come from thread_head's recency window; the rerank stage
    (when configured, within the caller's budget) re-orders them by
    query relevance; the fallback is pure recency.  Same-thread
    continuity rides the thread ledger/history instead -- episodes are
    the CROSS-thread view. */
export interface EpisodeSummary {
  id: string;
  title: string;
  updated: number;
  preview: string;
}

const EPISODE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export async function listEpisodes(query: string, limit = 6): Promise<EpisodeSummary[]> {
  await pg();
  const cutoff = Date.now() - EPISODE_WINDOW_MS;
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT thread_id AS id, title, preview, updated FROM thread_head
     WHERE updated > $1 ORDER BY updated DESC LIMIT 24`,
    [cutoff],
  );
  const candidates: EpisodeSummary[] = (rows ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ""),
    updated: Number(row.updated) || 0,
    preview: String(row.preview ?? ""),
  }));
  if (candidates.length === 0) {
    return [];
  }
  if (candidates.length >= 4 && rerankConfigured()) {
    try {
      const order = await rerankDocs(
        query,
        candidates.map((episode) => `${episode.title} — ${episode.preview.slice(0, 200)}`),
      );
      if (order && order.length === candidates.length) {
        return order
          .map((index) => candidates[index])
          .filter((episode) => episode !== undefined)
          .slice(0, limit);
      }
    } catch {
      /* fail-open: the recency order stands */
    }
  }
  return candidates.slice(0, limit);
}
