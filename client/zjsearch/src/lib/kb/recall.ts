// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store's read paths: there is deliberately NO in-memory
    mirror -- every surface (the knowledge page, the recall, the admin
    panel) reads the same table the writes land in.  Recall fuses TWO
    dimensions: hybrid lexical+vector RRF (trigram rescue on the
    zero-signal case), and the tag graph (vocabulary match -> shared-tag
    rows), aggregated on demand -- the graph is a query, not a table. */

import { embeddingsConfigured, embedTexts } from "@/lib/embed.ts";
import { CORPUS_COLUMNS, enqueue, ITEM_COLUMNS, type KnowledgeItem, rowToItem } from "@/lib/kb/shared.ts";
import { pg, pgQuery, segmentKeywords, toVectorLiteral } from "@/lib/pg.ts";
import { rerankConfigured, rerankDocs } from "@/lib/rerank.ts";

const SEARCHABLE_KINDS = ["answer", "source", "document", "memory", "call", "task", "clarify", "run"];

// -------------------------------------------------------------- hybrid read

/** Hybrid BM25 + pgvector over the searchable kinds, trigram rescue on
    the zero-signal case.  Returns fused rows ranked by RRF.  The kind
    names are internal constants, so they inline as SQL literals. */
async function hybridRecall(
  query: string,
  kinds: string[],
  limit: number,
  fullBody = false,
): Promise<Array<{ item: KnowledgeItem; score: number }>> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  await pg();
  const kindList = kinds.map((kind) => `'${kind.replaceAll("'", "")}'`).join(",");
  const keywords = segmentKeywords(trimmed);
  const semanticReady = embeddingsConfigured();
  const scores = new Map<string, { item: KnowledgeItem; score: number }>();
  const bump = (rows: Record<string, unknown>[], weight: number) => {
    (rows ?? []).forEach((row, rank) => {
      const rrf = weight / (60 + rank + 1);
      const item = rowToItem(row);
      const entry = scores.get(item.id);
      scores.set(item.id, { item, score: (entry?.score ?? 0) + rrf });
    });
  };
  // OVER-FETCH: both index legs (bm25, hnsw) return their top-N across
  // ALL kinds and the kind filter applies after -- a narrow kind-set
  // (recallPages' documents vs thousands of call/source rows) could
  // starve its leg to zero hits on a corpus full of matches.  The wider
  // window gives the filter something to keep; the RRF's rank weights
  // make the extra depth harmless.
  const fetchN = Math.max(limit * 8, 64);
  const [keywordRows, semanticRows] = await Promise.all([
    keywords
      ? pgQuery<Record<string, unknown>>(
          `SELECT ${fullBody ? CORPUS_COLUMNS : ITEM_COLUMNS}, (search_text <@> to_bm25query($1, 'knowledge_bm25')) AS _score
           FROM knowledge
           WHERE kind IN (${kindList}) AND (search_text <@> to_bm25query($1, 'knowledge_bm25')) <> 0
           ORDER BY _score DESC LIMIT $2`,
          [keywords, fetchN],
        )
      : Promise.resolve([] as Record<string, unknown>[]),
    semanticReady
      ? (async () => {
          const vector = (await embedTexts([trimmed]))?.[0];
          if (!vector) {
            return [] as Record<string, unknown>[];
          }
          return pgQuery<Record<string, unknown>>(
            `SELECT ${fullBody ? CORPUS_COLUMNS : ITEM_COLUMNS}, 1 - (embedding <=> $1::vector) AS _score
             FROM knowledge
             WHERE kind IN (${kindList}) AND embedding IS NOT NULL
             ORDER BY embedding <=> $1::vector LIMIT $2`,
            [toVectorLiteral(vector), fetchN],
          );
        })()
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);
  bump(keywordRows, 1.0);
  bump(semanticRows, 1.0);
  if (scores.size === 0 && trimmed.length >= 2) {
    // the rescue rides the GiST trigram index as a KNN ordering
    // (title %> query + ORDER BY title <-> query) -- the old
    // word_similarity() function call could never use the index and
    // seq-scanned every searchable row computing similarities
    const rescued = await pgQuery<Record<string, unknown>>(
      `SELECT ${fullBody ? CORPUS_COLUMNS : ITEM_COLUMNS}, similarity(title, $1) AS _score
       FROM knowledge
       WHERE kind IN (${kindList}) AND title %> $1
       ORDER BY title <-> $1 LIMIT $2`,
      [trimmed, limit],
    );
    bump(rescued, 1.0);
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The tag vocabulary (cached one minute): the client-side tag match
    costs zero LLM calls. */
let vocabularyCache: { tags: string[]; at: number } | null = null;

async function tagVocabulary(): Promise<string[]> {
  if (vocabularyCache && Date.now() - vocabularyCache.at < 60000) {
    return vocabularyCache.tags;
  }
  // the SAME kinds the graph view counts, and never the tag-less rows:
  // unfiltered this jsonb expansion ran over EVERY row (runctx blobs,
  // call rows, source_refs) before EVERY AI search POST
  const rows = await pgQuery<{ tag: string }>(
    `SELECT DISTINCT t AS tag FROM knowledge, jsonb_array_elements_text(CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END) AS t
     WHERE kind IN ('source', 'answer', 'document', 'memory', 'run') AND tags <> '[]'::jsonb
     ORDER BY tag`,
  );
  const tags = (rows ?? []).map((row) => row.tag);
  vocabularyCache = { tags, at: Date.now() };
  return tags;
}

/** The knowledge-graph recall dimension: match the query against the tag
    vocabulary, pull rows sharing the seed tags (more shared tags first). */
async function graphRecall(query: string, kinds: string[], limit: number, fullBody = false): Promise<KnowledgeItem[]> {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return [];
  }
  const vocabulary = await tagVocabulary();
  const seeds = vocabulary
    .filter((tag) => trimmed.includes(tag.toLowerCase()) || tag.toLowerCase().includes(trimmed))
    .slice(0, 4);
  if (seeds.length === 0) {
    return [];
  }
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
  return (rows ?? []).map((row) => rowToItem(row));
}

// -------------------------------------------------------------- public read

export interface ThreadSummary {
  id: string;
  title: string;
  runs: number;
  sources: number;
  /** the thread's REPORT-mode runs (run.meta.report settles it) -- the
      directory's 报告 badge + filter read it */
  reports: number;
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
export async function listThreads(limit = 30, offset = 0): Promise<ThreadSummary[]> {
  await pg();
  sweepStaleRuns();
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT thread_id AS id, title, preview, runs, sources, reports, updated, pinned
     FROM thread_head ORDER BY pinned DESC, updated DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return (rows ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ""),
    runs: Number(row.runs) || 0,
    sources: Number(row.sources) || 0,
    reports: Number(row.reports) || 0,
    updated: Number(row.updated) || 0,
    pinned: Number(row.pinned) === 1,
    preview: String(row.preview ?? ""),
  }));
}

/** One kind's rows, newest first -- the filter chips' non-search listing
    (answers / sources / documents as their own directories). */
export async function listKind(kind: string, limit = 40): Promise<KnowledgeItem[]> {
  await pg();
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT ${ITEM_COLUMNS} FROM knowledge WHERE kind = $1 ORDER BY pinned DESC, updated DESC LIMIT $2`,
    [kind, limit],
  );
  return (rows ?? []).map(rowToItem);
}

/** The items carrying one tag (the graph's locate-to-content panel) --
    the GIN index answers the membership. */
export async function itemsByTag(tag: string, limit = 20): Promise<KnowledgeItem[]> {
  await pg();
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT ${ITEM_COLUMNS} FROM knowledge
     WHERE kind IN ('run', 'answer', 'source', 'document', 'memory') AND tags ? $1
     ORDER BY updated DESC LIMIT $2`,
    [tag, limit],
  );
  return (rows ?? []).map(rowToItem);
}

/** Cross-kind hybrid search (the knowledge page's search box). */
export async function searchKnowledge(
  query: string,
  opts: { kinds?: string[]; pinned?: boolean; since?: number } = {},
  limit = 24,
): Promise<KnowledgeItem[]> {
  const hits = await hybridRecall(query, opts.kinds?.length ? opts.kinds : SEARCHABLE_KINDS, limit);
  return hits
    .map((hit) => hit.item)
    .filter((item) => (opts.pinned ? item.pinned : true))
    .filter((item) => (opts.since ? item.updated >= opts.since : true));
}

/** The model funnel's middle tier, browser-side: ONE cross-encoder pass
    over the fused head re-orders it by query-conditioned relevance -- the
    signal the BM25+vector RRF only approximates.  Fail-open everywhere:
    fewer than 4 candidates, rerank unconfigured, or any upstream failure
    keeps the fused order (the rows carry the full body, so the document
    text is the recall's own shape -- title + body head). */
async function rerankStage(
  query: string,
  rows: Array<{ item: KnowledgeItem; score: number }>,
  head = 16,
): Promise<Array<{ item: KnowledgeItem; score: number }>> {
  if (rows.length < 4 || !rerankConfigured()) {
    return rows;
  }
  const headRows = rows.slice(0, head);
  try {
    const order = await rerankDocs(
      query,
      headRows.map((row) => `${row.item.title} — ${row.item.body.slice(0, 400)}`),
    );
    if (!order || order.length !== headRows.length) {
      return rows;
    }
    const reranked = order.map((index) => headRows[index]).filter((row) => row !== undefined);
    if (reranked.length !== headRows.length) {
      return rows;
    }
    return [...reranked, ...rows.slice(head)];
  } catch {
    return rows;
  }
}

/** The RESEARCH recall: the writer-phase corpus (sources + past answers).
    THE RED LINE: these rows reach the writer phase or the UI only --
    never the researcher's feed (ready-made material kills the search
    incentive).  Fuses the hybrid dimension with the tag-graph dimension,
    then the rerank tier re-scores the fused head. */
export async function recallCorpus(query: string, limit = 6): Promise<KnowledgeItem[]> {
  const [hybrid, graph] = await Promise.all([
    hybridRecall(query, ["source", "answer"], limit, true),
    graphRecall(query, ["source", "answer"], limit, true),
  ]);
  const scores = new Map<string, { item: KnowledgeItem; score: number }>();
  const bump = (items: KnowledgeItem[], weight: number) => {
    items.forEach((item, rank) => {
      const rrf = weight / (60 + rank + 1);
      const entry = scores.get(item.id);
      scores.set(item.id, { item, score: (entry?.score ?? 0) + rrf + item.cited * 0.01 });
    });
  };
  bump(
    hybrid.map((hit) => hit.item),
    1.0,
  );
  bump(graph, 0.6);
  let ranked = [...scores.values()].sort((a, b) => b.score - a.score);
  ranked = await rerankStage(query, ranked);
  return ranked.slice(0, limit).map((entry) => entry.item);
}

/** The past_research index: archived full texts ranked by the query
    (the tool's feed then points at web_reader for a live re-read).
    ``opts.rerank: false`` skips the rerank tier -- the classic page's
    eager prewarm path spends nothing beyond the fusion. */
export async function recallPages(
  query: string,
  limit = 4,
  opts: { rerank?: boolean } = {},
): Promise<Array<{ url: string; title: string; chars: number; text: string }>> {
  const [hybrid, graph] = await Promise.all([
    hybridRecall(query, ["document"], limit, true),
    graphRecall(query, ["document"], limit, true),
  ]);
  const scores = new Map<string, { item: KnowledgeItem; score: number }>();
  const bump = (items: KnowledgeItem[], weight: number) => {
    items.forEach((item, rank) => {
      const rrf = weight / (60 + rank + 1);
      const entry = scores.get(item.id);
      scores.set(item.id, { item, score: (entry?.score ?? 0) + rrf });
    });
  };
  bump(
    hybrid.map((hit) => hit.item),
    1.0,
  );
  bump(graph, 0.6);
  let ranked = [...scores.values()].sort((a, b) => b.score - a.score);
  if (opts.rerank !== false) {
    ranked = await rerankStage(query, ranked);
  }
  return ranked.slice(0, limit).map((entry) => ({
    url: entry.item.url ?? "",
    title: entry.item.title,
    chars: entry.item.body.length,
    text: entry.item.body.slice(0, 1500),
  }));
}

// -------------------------------------------------------------- graph view

export interface TagGraph {
  nodes: Array<{ tag: string; uses: number }>;
  edges: Array<{ a: string; b: string; w: number }>;
}

/** The tag graph snapshot: nodes = tags by use count, edges = tag
    co-occurrence within a row (weighted).  Computed on demand -- the
    graph is a query, not a table. */
export async function graphSnapshot(limit = 40): Promise<TagGraph> {
  await pg();
  const nodeRows = await pgQuery<{ tag: string; uses: number }>(
    `SELECT t AS tag, count(*) AS uses FROM knowledge, jsonb_array_elements_text(CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END) AS t
     WHERE kind IN ('source', 'answer', 'document', 'memory', 'run') AND position('.' IN t) = 0
     GROUP BY t ORDER BY uses DESC LIMIT $1`,
    [limit],
  );
  const nodes = (nodeRows ?? []).map((row) => ({ tag: row.tag, uses: Number(row.uses) || 0 }));
  if (nodes.length < 2) {
    return { nodes, edges: [] };
  }
  const names = nodes.map((node) => node.tag);
  const edgeRows = await pgQuery<{ a: string; b: string; w: number }>(
    `SELECT a.t AS a, b.t AS b, count(*) AS w
     FROM knowledge k, jsonb_array_elements_text(CASE WHEN jsonb_typeof(k.tags) = 'array' THEN k.tags ELSE '[]'::jsonb END) AS a(t), jsonb_array_elements_text(CASE WHEN jsonb_typeof(k.tags) = 'array' THEN k.tags ELSE '[]'::jsonb END) AS b(t)
     WHERE k.kind IN ('source', 'answer', 'document', 'memory', 'run')
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
