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

import { embeddingsConfigured, embedQuery } from "@/lib/embed.ts";
import { hybridMemoryHits } from "@/lib/kb/memory.ts";
import {
  bodySegments,
  CORPUS_COLUMNS,
  embedModelName,
  ITEM_COLUMNS,
  type KnowledgeItem,
  rowToItem,
} from "@/lib/kb/shared.ts";
import { expandByHitTags, graphRecall } from "@/lib/kb/tags.ts";
import { segmentKeywords } from "@/lib/keywords.ts";
import { pg, pgQuery, toVectorLiteral } from "@/lib/pg.ts";
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
  const model = embeddingsConfigured() ? embedModelName() : null;
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
  const columns = fullBody ? CORPUS_COLUMNS : ITEM_COLUMNS;
  const prefixed = columns
    .split(", ")
    .map((column) => (column.startsWith("k.") ? column : `k.${column}`))
    .join(", ");
  const [keywordRows, rowSemantic, segSemantic] = await Promise.all([
    keywords
      ? pgQuery<Record<string, unknown>>(
          `SELECT ${columns}, (search_text <@> to_bm25query($1, 'knowledge_bm25')) AS _score
           FROM knowledge
           WHERE kind IN (${kindList}) AND (search_text <@> to_bm25query($1, 'knowledge_bm25')) <> 0
           ORDER BY _score DESC LIMIT $2`,
          [keywords, fetchN],
        )
      : Promise.resolve([] as Record<string, unknown>[]),
    model
      ? (async () => {
          // THE SPACE GUARD: only vectors of the CURRENT capability
          // model compete -- a stored vector from another model sits in
          // another space and its cosine reads as garbage (the boot
          // reconcile pass resets them; the filter is the belt to its
          // braces, covering the rows that land while a swap is in
          // flight)
          const vector = await embedQuery(trimmed);
          if (!vector) {
            return [] as Record<string, unknown>[];
          }
          return pgQuery<Record<string, unknown>>(
            `SELECT ${columns}, 1 - (embedding <=> $1::vector) AS _score
             FROM knowledge
             WHERE kind IN (${kindList}) AND embedding IS NOT NULL AND embed_model = $3
             ORDER BY embedding <=> $1::vector LIMIT $2`,
            [toVectorLiteral(vector), fetchN, model],
          );
        })()
      : Promise.resolve([] as Record<string, unknown>[]),
    model && (kinds.includes("source") || kinds.includes("document"))
      ? (async () => {
          // THE SEGMENT LEG: the long full-text rows (crawled sources,
          // attachments) embed as ~1200-char segments -- this query is
          // how their tails become findable.  A row hit through several
          // segments dedupes to its best segment before the RRF.  The
          // kind filter still applies inside the JOIN -- the leg runs
          // whenever the caller's kinds name either segmented kind
          // (source or document), which source always implies.
          const vector = await embedQuery(trimmed);
          if (!vector) {
            return [] as Record<string, unknown>[];
          }
          const rows = await pgQuery<Record<string, unknown>>(
            `SELECT ${prefixed}, 1 - (v.embedding <=> $1::vector) AS _score
             FROM knowledge_vec v JOIN knowledge k ON k.id = v.row_id
             WHERE k.kind IN (${kindList}) AND v.embed_model = $3
             ORDER BY v.embedding <=> $1::vector LIMIT $2`,
            [toVectorLiteral(vector), fetchN, model],
          );
          const best = new Map<string, Record<string, unknown>>();
          for (const row of rows ?? []) {
            const id = String(row.id);
            const prev = best.get(id);
            if (!prev || Number(row._score) > Number(prev._score)) {
              best.set(id, row);
            }
          }
          return [...best.values()];
        })()
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);
  bump(keywordRows, 1.0);
  bump(rowSemantic, 1.0);
  bump(segSemantic, 1.0);
  if (scores.size === 0 && trimmed.length >= 2) {
    // the rescue rides the GiST trigram index as a KNN ordering
    // (title %> query + ORDER BY title <-> query) -- the old
    // word_similarity() function call could never use the index and
    // seq-scanned every searchable row computing similarities
    const rescued = await pgQuery<Record<string, unknown>>(
      `SELECT ${columns}, similarity(title, $1) AS _score
       FROM knowledge
       WHERE kind IN (${kindList}) AND title %> $1
       ORDER BY title <-> $1 LIMIT $2`,
      [trimmed, limit],
    );
    bump(rescued, 1.0);
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Cross-kind hybrid search (the knowledge page's search box) -- the
    same three-leg fusion the research recall rides (no rerank stage:
    the drawer's debounce budget stays model-free). */
export async function searchKnowledge(
  query: string,
  opts: { kinds?: string[]; since?: number } = {},
  limit = 24,
): Promise<KnowledgeItem[]> {
  const hits = await fuseRecall(query, opts.kinds?.length ? opts.kinds : SEARCHABLE_KINDS, limit, {
    rerank: false,
  });
  return hits.map((hit) => hit.item).filter((item) => (opts.since ? item.updated >= opts.since : true));
}

// THE SEGMENT RERANK: a long row (the full-text lanes' whole bodies)
// reranks as its ~1200-char segments -- the cross-encoder judges the
// passage that actually matches, not the 400-char head that may not
// carry the signal (the server's writer-feed trim, mirrored).  The
// budget: 4 segments a row, 64 docs one call -- rows past the doc cap
// fall back to their single head document, exactly the old shape.
const RERANK_SEGMENT_BODY_MIN = 900;
const RERANK_SEGMENTS_PER_ROW = 4;
const RERANK_DOC_BUDGET = 64;

/** The model funnel's middle tier, browser-side: ONE cross-encoder pass
    over the fused head re-orders it by query-conditioned relevance -- the
    signal the BM25+vector RRF only approximates.  Long rows ride their
    segments; a row's rank is its BEST segment's rank.  Fail-open
    everywhere: fewer than 8 candidates, rerank unconfigured, or any
    upstream failure keeps the fused order (the rows carry the full
    body, so the document text is the recall's own shape -- title +
    body head). */
async function rerankStage(
  query: string,
  rows: Array<{ item: KnowledgeItem; score: number }>,
  head = 16,
): Promise<Array<{ item: KnowledgeItem; score: number }>> {
  if (rows.length < 8 || !rerankConfigured()) {
    return rows;
  }
  const headRows = rows.slice(0, head);
  const docs: string[] = [];
  const spans: Array<{ start: number; count: number }> = [];
  for (const row of headRows) {
    const body = row.item.body ?? "";
    let texts =
      body.length >= RERANK_SEGMENT_BODY_MIN && docs.length + RERANK_SEGMENTS_PER_ROW <= RERANK_DOC_BUDGET
        ? bodySegments(body, RERANK_SEGMENTS_PER_ROW)
        : [];
    if (docs.length + texts.length > RERANK_DOC_BUDGET) {
      texts = [];
    }
    const start = docs.length;
    if (texts.length) {
      for (const segment of texts) {
        docs.push(`${row.item.title} — ${segment}`);
      }
    } else {
      docs.push(`${row.item.title} — ${body.slice(0, 400)}`);
    }
    spans.push({ start, count: docs.length - start });
  }
  try {
    const order = await rerankDocs(query, docs);
    if (!order || order.length !== docs.length) {
      return rows;
    }
    // each document's position in the returned order -- the lower the
    // better; a row ranks by its best segment
    const position = new Array<number>(docs.length);
    order.forEach((docIx, rank) => {
      if (typeof docIx === "number" && docIx >= 0 && docIx < docs.length) {
        position[docIx] = rank;
      }
    });
    const rankedRows = headRows
      .map((row, ix) => {
        const span = spans[ix];
        let best = Number.MAX_SAFE_INTEGER;
        for (let d = 0; d < (span?.count ?? 1); d++) {
          const pos = position[(span?.start ?? 0) + d];
          if (typeof pos === "number" && pos < best) {
            best = pos;
          }
        }
        return { row, best };
      })
      .sort((a, b) => a.best - b.best)
      .map((entry) => entry.row);
    return [...rankedRows, ...rows.slice(head)];
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
