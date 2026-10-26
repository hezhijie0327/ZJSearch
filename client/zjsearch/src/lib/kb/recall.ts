// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store's read paths: there is deliberately NO in-memory
    mirror -- every surface (the knowledge page, the recall, the admin
    panel) reads the same table the writes land in.  Recall fuses THREE
    dimensions by RRF: hybrid lexical+vector (trigram rescue on the
    zero-signal case), the tag graph queried from the QUERY text
    (vocabulary match), and the HIT-TAG one-hop expansion (the hybrid
    hits' own tags pull their neighbours -- related tags the query never
    named still recall); the rerank stage then re-scores the fused head.
    The graph is a query, not a table. */

import { embeddingsConfigured, embedTexts } from "@/lib/embed.ts";
import { hybridMemoryHits, listMemoryItems } from "@/lib/kb/memory.ts";
import { CORPUS_COLUMNS, enqueue, ITEM_COLUMNS, type KnowledgeItem, rowToItem, safeParse } from "@/lib/kb/shared.ts";
import { pg, pgQuery, segmentKeywords, toVectorLiteral } from "@/lib/pg.ts";
import { rerankConfigured, rerankDocs } from "@/lib/rerank.ts";

// memory lives in its OWN table (lib/kb/memory.ts) -- fuseRecall adds its
// hybrid leg when the caller's kind set names it
const SEARCHABLE_KINDS = ["source", "document", "call", "task", "clarify", "run"];

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
async function rowsByTags(kinds: string[], seeds: string[], limit: number, fullBody = false): Promise<KnowledgeItem[]> {
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
async function graphRecall(query: string, kinds: string[], limit: number, fullBody = false): Promise<KnowledgeItem[]> {
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
async function expandByHitTags(
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
    `SELECT h.thread_id AS id, h.title, h.preview, h.runs, h.sources, h.reports, h.updated, h.pinned,
       (SELECT json_agg(DISTINCT m.mode) FROM (SELECT kr.meta->>'mode' AS mode FROM knowledge kr
        WHERE kr.thread_id = h.thread_id AND kr.kind = 'run' AND kr.meta->>'mode' IS NOT NULL) m) AS modes
     FROM thread_head h ORDER BY h.pinned DESC, h.updated DESC LIMIT $1 OFFSET $2`,
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
    `SELECT ${ITEM_COLUMNS} FROM knowledge WHERE kind = $1 ORDER BY pinned DESC, updated DESC LIMIT $2`,
    [kind, limit],
  );
  return (rows ?? []).map(rowToItem);
}

/** Cross-kind hybrid search (the knowledge page's search box) -- the
    same three-leg fusion the research recall rides (no rerank stage:
    the drawer's debounce budget stays model-free). */
export async function searchKnowledge(
  query: string,
  opts: { kinds?: string[]; pinned?: boolean; since?: number } = {},
  limit = 24,
): Promise<KnowledgeItem[]> {
  const hits = await fuseRecall(query, opts.kinds?.length ? opts.kinds : SEARCHABLE_KINDS, limit, {
    rerank: false,
  });
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

/** The THREE-LEG fusion every recall rides: hybrid (BM25+vector) 1.0,
    the query-lexical tag graph 0.6, and the HIT-TAG one-hop expansion
    0.4 -- RRF dedups across legs; the rerank stage re-scores the fused
    head (the expansion widens recall, the cross-encoder restores
    precision).  The expansion rides ONE extra GIN query after the
    hybrid leg resolves; the light-fusion doctrine keeps the graph a
    recall SIGNAL, never the engine. */
async function fuseRecall(
  query: string,
  kinds: string[],
  limit: number,
  opts: { fullBody?: boolean; rerank?: boolean; citedBonus?: boolean } = {},
): Promise<Array<{ item: KnowledgeItem; score: number }>> {
  const fullBody = opts.fullBody ?? false;
  const wantMemory = kinds.includes("memory");
  const [hybrid, graph, memory] = await Promise.all([
    hybridRecall(query, kinds, limit, fullBody),
    graphRecall(query, kinds, limit, fullBody),
    wantMemory ? hybridMemoryHits(query, limit) : Promise.resolve([] as KnowledgeItem[]),
  ]);
  const expanded = await expandByHitTags(kinds, hybrid, limit, fullBody);
  const scores = new Map<string, { item: KnowledgeItem; score: number }>();
  const bump = (items: KnowledgeItem[], weight: number) => {
    items.forEach((item, rank) => {
      const rrf = weight / (60 + rank + 1);
      const entry = scores.get(item.id);
      scores.set(item.id, {
        item,
        score: (entry?.score ?? 0) + rrf + (opts.citedBonus ? item.cited * 0.01 : 0),
      });
    });
  };
  bump(
    hybrid.map((hit) => hit.item),
    1.0,
  );
  bump(graph, 0.6);
  bump(memory, 1.0);
  bump(expanded, 0.4);
  let ranked = [...scores.values()].sort((a, b) => b.score - a.score);
  if (opts.rerank !== false) {
    ranked = await rerankStage(query, ranked);
  }
  return ranked;
}

/** The RESEARCH recall: the writer-phase corpus (sources + past answers).
    THE RED LINE: these rows reach the writer phase or the UI only --
    never the researcher's feed (ready-made material kills the search
    incentive).  Fuses the hybrid, tag-graph and hit-tag-expansion
    dimensions, then the rerank tier re-scores the fused head.
    ``opts.fullBody: false`` keeps the rows identity-only (url/title/host)
    -- the metadata lanes (history_sources/history_topics) never detoast
    the bodies they don't read. */
export async function recallCorpus(
  query: string,
  limit = 6,
  opts: { fullBody?: boolean } = {},
): Promise<KnowledgeItem[]> {
  const ranked = await fuseRecall(query, ["source"], limit, {
    fullBody: opts.fullBody ?? true,
    citedBonus: true,
  });
  return ranked.slice(0, limit).map((entry) => entry.item);
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

/** The recall_history index: archived full texts ranked by the query
    (the tool's feed then points at a live re-read).
    ``opts.rerank: false`` skips the rerank tier -- the classic page's
    eager prewarm path spends nothing beyond the fusion. */
export async function recallPages(
  query: string,
  limit = 4,
  opts: { rerank?: boolean } = {},
): Promise<Array<{ url: string; title: string; chars: number; text: string }>> {
  const ranked = await fuseRecall(query, ["document"], limit, {
    fullBody: true,
    rerank: opts.rerank !== false,
  });
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

let seededBackfill = false;

/** One sweep per session (at the first graph view): the rows that
    predate the seed layer -- sources archived with EMPTY tags, memories
    without tags, crawled documents wearing their (graph-invisible) host
    tag -- get the mechanical seed from their title/content and join the
    debounced normalize pass like every newer row.  Fire-and-forget: the
    first snapshot may miss the tail, the next view shows it. */
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
           AND (tags = '[]'::jsonb
                OR (kind = 'document' AND jsonb_array_length(tags) = 1 AND tags->>0 = host AND host <> ''))
         LIMIT 200`,
      );
      if (!rows || rows.length === 0) {
        return;
      }
      for (const row of rows) {
        const text = row.title;
        const tokens = segmentKeywords(text)
          .split(" ")
          .filter((token) => token.length >= 2)
          .slice(0, 12);
        await pgQuery(`UPDATE knowledge SET tags = $1::jsonb WHERE id = $2`, [JSON.stringify(tokens), row.id]);
      }
      if (rows.length < 200) {
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
