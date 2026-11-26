// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The tag graph's read machinery: the query-text vocabulary match,
    the graph query itself, the HIT-TAG one-hop expansion and the
    seed backfill behind the drawer's graph snapshot.  The graph is
    a query, not a table. */

import { listMemoryItems } from "@/lib/kb/memory.ts";
import { CORPUS_COLUMNS, enqueue, ITEM_COLUMNS, type KnowledgeItem, rowToItem, safeParse } from "@/lib/kb/shared.ts";
import { segmentKeywords } from "@/lib/keywords.ts";
import { pg, pgQuery } from "@/lib/pg.ts";

/** The tag vocabulary (cached one minute): the client-side tag match
    costs zero LLM calls. */
let vocabularyCache: { tags: string[]; at: number } | null = null;

export async function tagVocabulary(): Promise<string[]> {
  if (vocabularyCache && Date.now() - vocabularyCache.at < 60000) {
    return vocabularyCache.tags;
  }
  // the SAME kinds the graph view counts, and never the tag-less rows:
  // unfiltered this jsonb expansion ran over EVERY row (runctx blobs,
  // call rows, source_refs) before EVERY AI search POST
  const rows = await pgQuery<{ tag: string }>(
    `SELECT DISTINCT t AS tag FROM knowledge, jsonb_array_elements_text(CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END) AS t
     WHERE kind IN ('source', 'answer', 'document', 'run') AND tags <> '[]'::jsonb
     ORDER BY tag`,
  );
  const tags = (rows ?? []).map((row) => row.tag);
  vocabularyCache = { tags, at: Date.now() };
  return tags;
}

/** The shared tag-membership read (the GIN `?|` index answers it): rows
    sharing ANY seed tag, more shared tags first.  graphRecall's lexical
    leg and the hit-tag expansion both ride it. */
export async function rowsByTags(
  kinds: string[],
  seeds: string[],
  limit: number,
  fullBody = false,
): Promise<KnowledgeItem[]> {
  if (seeds.length === 0) {
    return [];
  }
  await pg();
  const kindList = kinds.map((kind) => `'${kind.replaceAll("'", "")}'`).join(",");
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT ${fullBody ? CORPUS_COLUMNS : ITEM_COLUMNS}, (
       SELECT count(*) FROM jsonb_array_elements_text(tags) AS t
       WHERE t = ANY($1::text[])
     ) AS _hits
     FROM knowledge
     WHERE kind IN (${kindList}) AND tags ?| $1::text[]
     ORDER BY _hits DESC, updated DESC LIMIT $2`,
    [seeds, limit],
  );
  return (rows ?? []).map(rowToItem);
}

/** The knowledge-graph recall dimension: match the query against the tag
    vocabulary, pull rows sharing the seed tags (more shared tags first). */
export async function graphRecall(
  query: string,
  kinds: string[],
  limit: number,
  fullBody = false,
): Promise<KnowledgeItem[]> {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return [];
  }
  const vocabulary = await tagVocabulary();
  const seeds = vocabulary
    .filter((tag) => trimmed.includes(tag.toLowerCase()) || tag.toLowerCase().includes(trimmed))
    .slice(0, 4);
  return rowsByTags(kinds, seeds, limit, fullBody);
}

/** The HIT-TAG EXPANSION (the graph's one-hop recall, the cold→remedy
    effect): the hybrid hits' OWN tags seed one more `tags ?|` lookup --
    a tag that is semantically related but lexically absent from the
    query still pulls its neighbour rows.  The seeds cap at the top
    hits' first 12 distinct tags; one GIN-indexed query, skipped when
    the hybrid leg found nothing (the lexical graphRecall leg already
    covers the no-hits case from the query side). */
export async function expandByHitTags(
  kinds: string[],
  hits: Array<{ item: KnowledgeItem; score: number }>,
  limit: number,
  fullBody = false,
): Promise<KnowledgeItem[]> {
  const seeds: string[] = [];
  for (const hit of hits.slice(0, 8)) {
    for (const tag of hit.item.tags ?? []) {
      if (!seeds.includes(tag)) {
        seeds.push(tag);
      }
      if (seeds.length >= 12) {
        break;
      }
    }
    if (seeds.length >= 12) {
      break;
    }
  }
  if (seeds.length === 0) {
    return [];
  }
  return rowsByTags(kinds, seeds, Math.max(limit * 4, 24), fullBody);
}

// -------------------------------------------------------------- public read

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

// -------------------------------------------------------------- graph view

export interface TagGraph {
  nodes: Array<{ tag: string; uses: number }>;
  edges: Array<{ a: string; b: string; w: number }>;
}

let seededBackfill = false;

/** One sweep per session (at the first graph view): the rows that
    predate the seed layer -- sources archived with EMPTY tags, crawled
    documents wearing their (graph-invisible) host tag -- get the
    mechanical seed from their title/content and join the debounced
    normalize pass like every newer row.  Fire-and-forget: the first
    snapshot may miss the tail, the next view shows it.  A row whose
    title yields no tokens is MARKED (empty tags stand) rather than
    re-selected -- an unmarked empty seed would re-match forever and
    wedge the write queue. */
export function backfillSeedTags(): void {
  if (seededBackfill) {
    return;
  }
  seededBackfill = true;
  void enqueue(async () => {
    for (;;) {
      const rows = await pgQuery<{ id: string; kind: string; host: string; title: string; body: string }>(
        `SELECT id, kind, host, title, body FROM knowledge
         WHERE kind IN ('source', 'document')
           AND (meta->>'seeded') IS NULL
           AND (tags = '[]'::jsonb
                OR (kind = 'document' AND jsonb_array_length(tags) = 1 AND tags->>0 = host AND host <> ''))
         LIMIT 200`,
      );
      if (!rows || rows.length === 0) {
        return;
      }
      let seededCount = 0;
      for (const row of rows) {
        const text = row.title;
        const tokens = segmentKeywords(text)
          .split(" ")
          .filter((token) => token.length >= 2)
          .slice(0, 12);
        if (tokens.length === 0) {
          // nothing to seed from: mark the row so it leaves the candidate
          // set (an unmarked empty seed would re-match forever and wedge
          // the write queue); the normalize pass may still tag it
          await pgQuery(`UPDATE knowledge SET meta = jsonb_set(knowledge.meta, '{seeded}', 'true') WHERE id = $1`, [
            row.id,
          ]);
          continue;
        }
        await pgQuery(`UPDATE knowledge SET tags = $1::jsonb WHERE id = $2`, [JSON.stringify(tokens), row.id]);
        seededCount += 1;
      }
      if (rows.length < 200 || seededCount === 0) {
        return;
      }
    }
  });
}

/** The tag graph snapshot: nodes = tags by use count, edges = tag
    co-occurrence within a row (weighted).  Computed on demand -- the
    graph is a query, not a table. */
export async function graphSnapshot(limit = 40): Promise<TagGraph> {
  backfillSeedTags();
  await pg();
  const nodeRows = await pgQuery<{ tag: string; uses: number }>(
    `SELECT t AS tag, count(*) AS uses FROM knowledge, jsonb_array_elements_text(CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END) AS t
     WHERE kind IN ('source', 'answer', 'document', 'run') AND position('.' IN t) = 0
     GROUP BY t ORDER BY uses DESC LIMIT $1 * 3`,
    [limit],
  );
  // the GENERIC-TAG GATE at the view's door: over-fetch x3 then drop the
  // function words -- the existing rows keep their raw seeds, the graph
  // just refuses to draw the hairball they would make
  const nodes = (nodeRows ?? []).map((row) => ({ tag: row.tag, uses: Number(row.uses) || 0 })).slice(0, limit);
  if (nodes.length < 2) {
    return { nodes, edges: [] };
  }
  const names = nodes.map((node) => node.tag);
  const edgeRows = await pgQuery<{ a: string; b: string; w: number }>(
    `SELECT a.t AS a, b.t AS b, count(*) AS w
     FROM knowledge k, jsonb_array_elements_text(CASE WHEN jsonb_typeof(k.tags) = 'array' THEN k.tags ELSE '[]'::jsonb END) AS a(t), jsonb_array_elements_text(CASE WHEN jsonb_typeof(k.tags) = 'array' THEN k.tags ELSE '[]'::jsonb END) AS b(t)
     WHERE k.kind IN ('source', 'answer', 'document', 'run')
       AND position('.' IN a.t) = 0 AND position('.' IN b.t) = 0
       AND a.t < b.t AND a.t = ANY($1::text[]) AND b.t = ANY($1::text[])
     GROUP BY a.t, b.t ORDER BY w DESC LIMIT 160`,
    [names],
  );
  return {
    nodes,
    edges: (edgeRows ?? []).map((row) => ({ a: row.a, b: row.b, w: Number(row.w) || 0 })),
  };
}
