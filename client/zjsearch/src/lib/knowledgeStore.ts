// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store (知识库): the browser's local RAG + memory layer
    over PGlite -- the server owns nothing.  An AI session is identified
    by the uuid in its url (`/zjsearch/ai/thread/<id>`) and survives a
    reload; storage is browser-local by design (never syncs across
    devices).

    The store is the facade over pg.ts's tables: threads (the
    directory), runs (one row per question, its `data` jsonb the replay
    blob the UI rehydrates from), sources (the GLOBAL url-identity
    research corpus with ref/cited counters), run_sources (the links),
    reader_cache (archived web_reader full-texts), memories (durable
    user facts) and searches (the classic search history).  The AI
    Search run recalls from this corpus before every POST
    (history_sources / past_research / user_memories); the knowledge
    drawer displays it.
    Every write updates the in-memory mirror first and persists the
    dirty threads through SQL on an ordered queue; reads stay
    SYNCHRONOUS on purpose -- the call sites render from the mirror
    directly.  Only the searches are async (real SQL).

    Search columns: the thread aggregates its runs' Q&A text (the
    history drawer ranks by it); every run row and every source row
    carries its own search_text (BM25 usable today); embeddings ride the
    server's /zjsearch/ai/embed route -- thread aggregates at settle,
    sources batched per sync (a NULL embedding keeps the row, just out
    of the semantic search until its text changes).

    The research corpus has ONE design red line: recalled sources may
    reach the WRITER phase or the UI only, never the researcher's
    ready-made feed -- reference material handed to the researcher kills
    the live-search incentive (verified early in the AI Search design).
    Database failure = the memory stays in RAM for the session; there is
    deliberately no fallback storage. */

import { citedSourceNumbers } from "@/lib/citations.ts";
import { embeddingsConfigured, embedTexts } from "@/lib/embed.ts";
import { configurePgDimensions, linkSource, pg, pgQuery, segmentKeywords, toVectorLiteral, urlHash } from "@/lib/pg.ts";

export { segmentKeywords, urlHash };

export interface AiThreadMeta {
  id: string;
  /** first question of the thread -- the history list's label */
  title: string;
  created: number;
  updated: number;
}

/** One semantic-search hit: the thread meta plus its cosine similarity
    (1 = identical, 0 = unrelated -- pgvector's `<=>` is cosine DISTANCE). */
export interface AiThreadHit extends AiThreadMeta {
  score: number;
}

/** One recalled source of the research corpus (the writer-phase history
    injection ranks by these). */
export interface RecallHit {
  url: string;
  title: string;
  host: string;
  /** how many runs referenced the source / how many settled answers
      cited it -- the verification signal the recall weights by */
  refCount: number;
  citedCount: number;
  score: number;
}

/** The structural view of one stored run (the feature owns the typed
    shape -- AiSearchRun satisfies it; the store reads only these
    fields). */
export interface StoredRun {
  runNo?: number;
  q?: string;
  status?: string;
  mode?: string;
  error?: string | null;
  answer?: string;
  startedAt?: number;
  endedAt?: number | null;
  usage?: unknown;
  sources?: unknown[];
}

// ---------------------------------------------------------------- mirror

let index: AiThreadMeta[] = [];
/** threadId -> the run replay blobs, in thread order (loadThread
    reassembles the payload from these). */
const runBlobs = new Map<string, StoredRun[]>();
/** threadId -> the text the thread's search index and embedding are
    computed from (every question + answer prose). */
const searchTexts = new Map<string, string>();
const embedded = new Map<string, { text: string; vector: number[] | null }>();
/** url_hash -> the indexed text (re-embedding keys off its change). */
const sourceTexts = new Map<string, string>();
const sourceVectors = new Map<string, number[] | null>();
/** url_hash -> the indexed text of the reader cache (the semantic
    recall's embedding pass mirrors the sources one). */
const readerTexts = new Map<string, string>();
const readerVectors = new Map<string, number[] | null>();
/** url_hash -> ref_count (the cross-session badge's synchronous
    lookup); refreshed at hydrate and after each sync. */
const sourceRefs = new Map<string, number>();
/** the registry's distinct-source count (threadStats, synchronous). */
let sourceTotal = 0;
/** the threads whose mirror state the next sync must persist. */
const dirty = new Set<string>();

function mirrorSort(): void {
  index.sort((a, b) => b.updated - a.updated);
}

function runIdOf(threadId: string, run: StoredRun, seq: number): string {
  return `${threadId}:${run.runNo ?? seq}`;
}

// ------------------------------------------------------------ hydration

const ready: Promise<void> = hydrate();

async function hydrate(): Promise<void> {
  const threads = await pgQuery<{ id: string; title: string; created: number; updated: number; search_text: string }>(
    "SELECT id, title, created, updated, search_text FROM threads ORDER BY updated DESC",
  );
  for (const row of threads) {
    if (row.search_text) {
      searchTexts.set(row.id, row.search_text);
    }
    index.push({ id: row.id, title: row.title, created: Number(row.created), updated: Number(row.updated) });
  }
  const runs = await pgQuery<{ thread_id: string; data: unknown }>(
    "SELECT thread_id, data FROM runs ORDER BY thread_id, seq",
  );
  for (const row of runs) {
    const list = runBlobs.get(row.thread_id) ?? [];
    list.push(row.data as StoredRun);
    runBlobs.set(row.thread_id, list);
  }
  const sources = await pgQuery<{ url_hash: string; search_text: string }>("SELECT url_hash, search_text FROM sources");
  for (const row of sources) {
    sourceTexts.set(row.url_hash, row.search_text);
  }
  sourceTotal = sources.length;
  const refs = await pgQuery<{ url_hash: string; ref_count: number }>("SELECT url_hash, ref_count FROM sources");
  for (const row of refs) {
    sourceRefs.set(row.url_hash, Number(row.ref_count) || 0);
  }
  const readers = await pgQuery<{ url_hash: string; search_text: string }>(
    "SELECT url_hash, search_text FROM reader_cache",
  );
  for (const row of readers) {
    readerTexts.set(row.url_hash, row.search_text);
  }
  const stored = await pgQuery<{ id: string; content: string; updated: number }>(
    "SELECT id, content, updated FROM memories ORDER BY created",
  );
  for (const row of stored) {
    memories.push({ id: row.id, content: row.content, updated: Number(row.updated) });
  }
  mirrorSort();
}

// ---------------------------------------------------- ordered persistence

let queue: Promise<void> = Promise.resolve();

/** The embedding batches: one /zjsearch/ai/embed call per chunk (the
    route caps at 16 texts). */
async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const vectors = await embedTexts(texts.slice(i, i + 16));
    if (!vectors) {
      out.push(...texts.slice(i, i + 16).map(() => null));
    } else {
      out.push(...vectors);
    }
  }
  return out;
}

/** Persist the dirty threads behind the queue: the thread row (with its
    re-embedded aggregate), its run rows (the replay blobs + BM25 text),
    the source links (upserting the global registry and its counters)
    and one batched source embedding pass.  A NULL vector result
    persists the row unembedded -- it joins the semantic search when its
    text changes again.  Best-effort: a failed pass is logged and the
    mirror stays authoritative (the next save retries the thread). */
function scheduleSync(): void {
  if (dirty.size === 0) {
    return;
  }
  const batch = [...dirty];
  dirty.clear();
  queue = queue
    .then(async () => {
      await ready;
      const db = await pg();
      for (const id of batch) {
        const meta = index.find((item) => item.id === id);
        if (!meta) {
          continue; // deleted while queued
        }
        // the thread aggregate: the caller's Q&A prose when provided,
        // else the title -- never a payload's JSON form
        const aggregate = (searchTexts.get(id) ?? meta.title).slice(0, 8000);
        const cached = embedded.get(id);
        if (!cached || cached.text !== aggregate) {
          const vectors = await embedBatch([`${meta.title}\n${aggregate}`]);
          embedded.set(id, { text: aggregate, vector: vectors[0] ?? null });
        }
        const vector = embedded.get(id)?.vector ?? null;
        await pgQuery(
          `INSERT INTO threads (id, title, created, updated, search_text, embedding)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, created = EXCLUDED.created,
             updated = EXCLUDED.updated, search_text = EXCLUDED.search_text, embedding = EXCLUDED.embedding`,
          [
            id,
            meta.title,
            meta.created,
            meta.updated,
            segmentKeywords(aggregate).slice(0, 8000),
            vector === null ? null : toVectorLiteral(vector),
          ],
        );
        // the runs: the replay blob plus the query columns; the cited
        // [n] set is parsed from the settled answer here -- the single
        // place the (run, source, cited) fact is bookkept
        const runs = runBlobs.get(id) ?? [];
        for (const [seq, run] of runs.entries()) {
          const rid = runIdOf(id, run, seq + 1);
          const cited = new Set(citedSourceNumbers(String(run.answer ?? "")));
          await pgQuery(
            `INSERT INTO runs (id, thread_id, seq, q, mode, status, error, created, settled, usage, data, search_text)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
             ON CONFLICT (id) DO UPDATE SET q = EXCLUDED.q, mode = EXCLUDED.mode, status = EXCLUDED.status,
               error = EXCLUDED.error, created = EXCLUDED.created, settled = EXCLUDED.settled,
               usage = EXCLUDED.usage, data = EXCLUDED.data, search_text = EXCLUDED.search_text`,
            [
              rid,
              id,
              seq + 1,
              String(run.q ?? ""),
              String(run.mode ?? ""),
              String(run.status ?? "done"),
              run.error ?? null,
              Number(run.startedAt ?? meta.created) || meta.updated,
              Number(run.endedAt ?? 0) || null,
              JSON.stringify(run.usage ?? null),
              JSON.stringify(run),
              segmentKeywords(String(run.q ?? ""), String(run.answer ?? "")).slice(0, 8000),
            ],
          );
          const seenAt = Number(run.endedAt ?? 0) || meta.updated;
          for (const source of Array.isArray(run.sources) ? (run.sources as Array<Record<string, unknown>>) : []) {
            if (!source?.url) {
              continue;
            }
            await linkSource(db, rid, source, seenAt, cited.has(Number(source.n ?? 0)));
          }
        }
      }
      // the embedding passes: sources AND reader pages whose indexed
      // text is new get vectors (the semantic half of both recalls)
      if (embeddingsConfigured()) {
        const freshSources = [...sourceTexts.keys()].filter((hash) => !sourceVectors.has(hash));
        if (freshSources.length > 0) {
          const vectors = await embedBatch(freshSources.map((hash) => sourceTexts.get(hash) ?? ""));
          freshSources.forEach((hash, i) => {
            const vector = vectors[i] ?? null;
            sourceVectors.set(hash, vector);
            if (vector) {
              void pgQuery("UPDATE sources SET embedding = $1::vector WHERE url_hash = $2", [
                toVectorLiteral(vector),
                hash,
              ]);
            }
          });
        }
        const freshReaders = [...readerTexts.keys()].filter((hash) => !readerVectors.has(hash));
        if (freshReaders.length > 0) {
          const vectors = await embedBatch(freshReaders.map((hash) => readerTexts.get(hash) ?? ""));
          freshReaders.forEach((hash, i) => {
            const vector = vectors[i] ?? null;
            readerVectors.set(hash, vector);
            if (vector) {
              void pgQuery("UPDATE reader_cache SET embedding = $1::vector WHERE url_hash = $2", [
                toVectorLiteral(vector),
                hash,
              ]);
            }
          });
        }
      }
      sourceTotal = Number((await pgQuery<{ n: string }>("SELECT count(*) AS n FROM sources"))[0]?.n ?? sourceTotal);
      for (const row of await pgQuery<{ url_hash: string; ref_count: number }>(
        "SELECT url_hash, ref_count FROM sources",
      )) {
        sourceRefs.set(row.url_hash, Number(row.ref_count) || 0);
      }
    })
    .catch((err: unknown) => {
      console.warn("zjsearch thread store: sync failed", err);
    });
}

// ------------------------------------------------------------ public API

/** A fresh conversation identity (the url's uuid). */
export function newThreadId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-4${Math.random().toString(16).slice(2, 11)}`;
}

/** The thread's shareable address (browser-local: another device or browser
    gets the empty state, never someone else's conversation). */
export function threadUrl(id: string): string {
  return `/zjsearch/ai/thread/${id}`;
}

export function listThreads(): AiThreadMeta[] {
  return index;
}

/** The thread's stored run replay blobs (useAiSearch resumes from
    them); null when the id is unknown. */
export async function loadThread(id: string): Promise<StoredRun[] | null> {
  // the in-memory mirror first (same-tab writes are here immediately);
  // a MISS falls back to PGlite -- a thread saved by ANOTHER TAB (or by a
  // page instance whose sync landed after this tab's boot hydration) is
  // still openable
  const mirrored = runBlobs.get(id);
  if (mirrored && mirrored.length > 0) {
    return mirrored;
  }
  await ready;
  const rows = await pgQuery<{ data: unknown }>("SELECT data FROM runs WHERE thread_id = $1 ORDER BY seq", [id]);
  if (rows.length === 0) {
    return null;
  }
  const list = rows.map((row) => row.data as StoredRun);
  runBlobs.set(id, list);
  // hydrate the drawer's index meta so the thread also lists locally
  if (!index.some((item) => item.id === id)) {
    const metas = await pgQuery<{ title: string; created: number; updated: number; search_text: string }>(
      "SELECT title, created, updated, search_text FROM threads WHERE id = $1",
      [id],
    );
    const row = metas[0];
    if (row) {
      index.unshift({ id, title: row.title, created: Number(row.created), updated: Number(row.updated) });
      if (row.search_text) {
        searchTexts.set(id, row.search_text);
      }
      mirrorSort();
    }
  }
  return list;
}

/** Persist one thread: the runs array is split into run rows (the replay
    blobs), the sources into the global registry.  The mirror updates
    synchronously (call sites see the write immediately), the SQL sync
    is queued behind hydration.  `searchText` is the text the thread's
    embedding is computed from -- callers pass their question + answer
    prose; without it only the title is embedded. */
export function saveThread(id: string, title: string, runs: StoredRun[], searchText?: string): void {
  const now = Date.now();
  const created = Number(runs[0]?.startedAt ?? now);
  index = index.filter((item) => item.id !== id);
  index.unshift({ id, title: title.slice(0, 200), created, updated: now });
  mirrorSort();
  runBlobs.set(id, runs);
  if (searchText !== undefined) {
    searchTexts.set(id, searchText.slice(0, 8000));
  }
  dirty.add(id);
  scheduleSync();
}

/** The search mode of the history drawer: `keyword` = BM25 over the
    pre-segmented text (free, offline, the DEFAULT), `semantic` =
    pgvector cosine over the embedding-model vectors (paraphrase recall,
    needs zjsearch.embedding). */
export type ThreadSearchMode = "keyword" | "semantic" | "hybrid";

/** Search the threads.  `keyword` runs a BM25 query (pg_textsearch,
    `search_text <@> to_bm25query(...)`, zero-matching rows score 0 and
    drop out); `semantic` ranks by pgvector cosine against the thread's
    embedding (one /zjsearch/ai/embed call for the query).  Async (real
    SQL); resolves empty while the store is empty. */
export async function searchThreads(
  query: string,
  mode: ThreadSearchMode = "keyword",
  limit = 8,
): Promise<AiThreadHit[]> {
  const trimmed = query.trim();
  if (!trimmed || index.length === 0) {
    return [];
  }
  await ready;
  if (mode === "hybrid") {
    // both rankings, then weighted RRF (equal footing): BM25 covers the
    // exact terms, the vectors cover the paraphrases
    const [keywordHits, semanticHits] = await Promise.all([
      searchThreads(query, "keyword", limit),
      searchThreads(query, "semantic", limit),
    ]);
    const scores = new Map<string, { hit: AiThreadHit; score: number }>();
    for (const [ranking, weight] of [
      [keywordHits, 1.0],
      [semanticHits, 1.0],
    ] as const) {
      ranking.forEach((hit, rank) => {
        const score = weight / (60 + rank + 1);
        const entry = scores.get(hit.id);
        scores.set(hit.id, { hit: { ...hit, score }, score: (entry?.score ?? 0) + score });
      });
    }
    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.hit)
      .slice(0, limit);
  }
  if (mode === "semantic") {
    if (!embeddingsConfigured()) {
      return [];
    }
    const queryVector = (await embedTexts([trimmed]))?.[0];
    if (!queryVector) {
      return [];
    }
    const rows = await pgQuery<{ id: string; title: string; created: number; updated: number; score: number }>(
      `SELECT id, title, created, updated, 1 - (embedding <=> $1::vector) AS score
       FROM threads WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT $2`,
      [toVectorLiteral(queryVector), limit],
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      created: Number(row.created),
      updated: Number(row.updated),
      score: Number(row.score),
    }));
  }
  // keyword: the BM25 index over the pre-segmented text -- a zero score
  // means "no term matches" and drops the row
  const keywords = segmentKeywords(trimmed);
  if (!keywords) {
    return [];
  }
  const rows = await pgQuery<{ id: string; title: string; created: number; updated: number; score: number }>(
    `SELECT id, title, created, updated, (search_text <@> to_bm25query($1, 'threads_bm25')) AS score
     FROM threads WHERE (search_text <@> to_bm25query($1, 'threads_bm25')) <> 0
     ORDER BY score DESC LIMIT $2`,
    [keywords, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    created: Number(row.created),
    updated: Number(row.updated),
    score: Number(row.score),
  }));
}

/** Recall from the research corpus: the global sources registry ranked
    by the query (hybrid -- BM25 over title+host, pgvector cosine over
    the embedded titles, weighted RRF plus a cited-count bump).  This
    feeds the WRITER-phase history injection ONLY (the red line: never
    the researcher's feed).  Async; resolves empty while the corpus is
    empty. */

/** Archive ONE web_reader page's extracted markdown into the browser's
    reader cache (the url-identity full-text store the memory tools
    recall from).  Fire-and-forget: a failed archive never blocks the
    run (the reading pane already showed the text). */
export function archiveReaderPage(url: string, title: string, markdown: string): void {
  if (!url || !markdown) {
    return;
  }
  queue = queue
    .then(async () => {
      await ready;
      const hash = urlHash(url);
      readerTexts.set(hash, segmentKeywords(title, markdown.slice(0, 8000)).slice(0, 8000));
      readerVectors.delete(hash);
      await pgQuery(
        `INSERT INTO reader_cache (url_hash, url, title, markdown, chars, fetched_at, search_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (url_hash) DO UPDATE SET title = EXCLUDED.title,
           markdown = EXCLUDED.markdown, chars = EXCLUDED.chars,
           fetched_at = EXCLUDED.fetched_at, search_text = EXCLUDED.search_text`,
        [
          hash,
          url,
          title.slice(0, 300),
          markdown.slice(0, 60000),
          markdown.length,
          Date.now(),
          segmentKeywords(title, markdown.slice(0, 8000)).slice(0, 8000),
        ],
      );
    })
    .catch(() => {
      /* best-effort */
    });
}

/** One archived page's full markdown (the corpus tab's reading
    pane); ``null`` when the url was never archived.  Async (real SQL). */
export async function getReaderPage(
  url: string,
): Promise<{ url: string; title: string; markdown: string; chars: number } | null> {
  await ready;
  const rows = await pgQuery<{ url: string; title: string; markdown: string; chars: number }>(
    "SELECT url, title, markdown, chars FROM reader_cache WHERE url_hash = $1",
    [urlHash(url)],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { url: row.url, title: row.title, markdown: row.markdown, chars: Number(row.chars) || 0 };
}

/** The reader cache's recent pages (url/title/when) -- the memory
    surface's listing reads this; async (real SQL). */
export async function listReaderPages(
  limit = 50,
): Promise<Array<{ url: string; title: string; chars: number; fetchedAt: number }>> {
  await ready;
  const rows = await pgQuery<{ url: string; title: string; chars: number; fetched_at: number }>(
    "SELECT url, title, chars, fetched_at FROM reader_cache ORDER BY fetched_at DESC LIMIT $1",
    [limit],
  );
  return rows.map((row) => ({
    url: row.url,
    title: row.title,
    chars: Number(row.chars) || 0,
    fetchedAt: Number(row.fetched_at),
  }));
}

export async function recallSources(query: string, limit = 6): Promise<RecallHit[]> {
  const trimmed = query.trim();
  if (!trimmed || sourceTotal === 0) {
    return [];
  }
  await ready;
  const keywords = segmentKeywords(trimmed);
  const semanticReady = embeddingsConfigured();
  if (!keywords && !semanticReady) {
    return [];
  }
  interface SourceRow {
    url: string;
    title: string;
    host: string;
    ref_count: number;
    cited_count: number;
    score: number;
  }
  const [keywordHits, semanticHits] = await Promise.all([
    keywords
      ? pgQuery<SourceRow>(
          `SELECT url, title, host, ref_count, cited_count,
                  (search_text <@> to_bm25query($1, 'sources_bm25')) AS score
           FROM sources WHERE (search_text <@> to_bm25query($1, 'sources_bm25')) <> 0
           ORDER BY score DESC LIMIT $2`,
          [keywords, limit * 2],
        )
      : Promise.resolve([] as SourceRow[]),
    semanticReady
      ? (async () => {
          const queryVector = (await embedTexts([trimmed]))?.[0];
          if (!queryVector) {
            return [] as SourceRow[];
          }
          return pgQuery<SourceRow>(
            `SELECT url, title, host, ref_count, cited_count,
                    1 - (embedding <=> $1::vector) AS score
             FROM sources WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT $2`,
            [toVectorLiteral(queryVector), limit * 2],
          );
        })()
      : Promise.resolve([] as SourceRow[]),
  ]);
  // weighted RRF with a verification bump: the fusion ranks, then a
  // source cited by past answers rises above a merely-referenced one
  const scores = new Map<string, { hit: RecallHit; score: number }>();
  const bump = (rows: SourceRow[], weight: number) => {
    rows.forEach((row, rank) => {
      const rrf = weight / (60 + rank + 1);
      const hit: RecallHit = {
        url: row.url,
        title: row.title,
        host: row.host,
        refCount: Number(row.ref_count) || 0,
        citedCount: Number(row.cited_count) || 0,
        score: rrf,
      };
      const entry = scores.get(row.url);
      scores.set(row.url, { hit, score: (entry?.score ?? 0) + rrf + hit.citedCount * 0.01 });
    });
  };
  bump(keywordHits, 1.0);
  bump(semanticHits, 1.0);
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.hit);
}

/** Browser-local usage stats for the preferences surface: thread count,
    total runs, the distinct-source count and the approximate storage
    footprint (JSON text sizes + embeddings -- the honest client-side
    estimate; PGlite's on-disk size also carries its own WAL/overhead). */
export function threadStats(): {
  runs: number;
  threads: number;
  sources: number;
  memories: number;
  approxBytes: number;
} {
  let runs = 0;
  let approxBytes = 0;
  for (const [id, blobs] of runBlobs) {
    runs += blobs.length;
    for (const blob of blobs) {
      approxBytes += JSON.stringify(blob ?? null).length;
    }
    approxBytes += searchTexts.get(id)?.length ?? 0;
  }
  for (const vector of embedded.values()) {
    approxBytes += (vector.vector?.length ?? 0) * 8;
  }
  for (const vector of sourceVectors.values()) {
    approxBytes += (vector?.length ?? 0) * 8;
  }
  let memoryBytes = 0;
  for (const memory of memories) {
    memoryBytes += memory.content.length;
  }
  return {
    approxBytes: approxBytes + memoryBytes,
    runs,
    threads: index.length,
    sources: sourceTotal,
    memories: memories.length,
  };
}

/** The FULL database reset: the mirrors empty AND the database itself
    drops (every table, schema recreated on the next boot) -- the
    preferences surface's nuclear option. */
export function resetAll(): void {
  clearAllThreads();
  queue = queue
    .then(async () => {
      await ready;
      const { resetDatabase } = await import("@/lib/pg.ts");
      await resetDatabase();
    })
    .catch(() => {
      /* best-effort */
    });
}

/** Remove EVERY stored thread (the preferences surface's reset).  The
    in-memory mirror empties immediately and the SQL sync clears the
    tables behind the queue (the source registry too -- it exists only
    for the threads' sake). */
export function clearAllThreads(): void {
  index = [];
  runBlobs.clear();
  searchTexts.clear();
  embedded.clear();
  sourceTexts.clear();
  sourceVectors.clear();
  sourceTotal = 0;
  memories.length = 0;
  dirty.clear();
  queue = queue
    .then(async () => {
      await ready;
      await pgQuery("DELETE FROM run_sources");
      await pgQuery("DELETE FROM runs");
      await pgQuery("DELETE FROM threads");
      await pgQuery("DELETE FROM sources");
      await pgQuery("DELETE FROM reader_cache");
      await pgQuery("DELETE FROM memories");
      await pgQuery("DELETE FROM searches");
    })
    .catch(() => {
      /* best-effort */
    });
}

export function deleteThread(id: string): void {
  index = index.filter((item) => item.id !== id);
  runBlobs.delete(id);
  searchTexts.delete(id);
  embedded.delete(id);
  dirty.delete(id);
  queue = queue
    .then(async () => {
      await ready;
      await pgQuery("DELETE FROM run_sources WHERE run_id IN (SELECT id FROM runs WHERE thread_id = $1)", [id]);
      await pgQuery("DELETE FROM runs WHERE thread_id = $1", [id]);
      await pgQuery("DELETE FROM threads WHERE id = $1", [id]);
    })
    .catch(() => {
      /* best-effort */
    });
}

/** Called once at boot with the embedding capability's width -- the
    pgvector columns are created at this dimension. */
export function configureEmbeddingDimensions(dims: number): void {
  configurePgDimensions(dims);
}

// ------------------------------------------------------------ user memory

/** The stored durable facts about the user (single flat layer -- our
    scenario needs location/preference/standing facts, not LobeHub's
    five-layer taxonomy).  Small by design (the run pre-sends them all);
    the mirror is hydrated once and read synchronously. */
let memories: Array<{ id: string; content: string; updated: number }> = [];

function newMemoryId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Persist one fact (the user_memory tool's save path -- the wire event
    lands here).  An EXACT duplicate content is a no-op; a near-duplicate
    is the model's business (the tool description tells it to search
    first).  Fire-and-forget through the ordered queue. */
export function saveMemory(content: string): void {
  const text = content.trim().slice(0, 300);
  if (!text || memories.some((memory) => memory.content === text)) {
    return;
  }
  const now = Date.now();
  const id = newMemoryId();
  memories.push({ id, content: text, updated: now });
  queue = queue
    .then(async () => {
      await ready;
      await pgQuery(
        `INSERT INTO memories (id, content, created, updated, search_text)
         VALUES ($1, $2, $3, $3, $4)`,
        [id, text, now, segmentKeywords(text).slice(0, 300)],
      );
    })
    .catch(() => {
      /* best-effort */
    });
}

export function deleteMemory(id: string): void {
  memories = memories.filter((memory) => memory.id !== id);
  queue = queue
    .then(async () => {
      await ready;
      await pgQuery("DELETE FROM memories WHERE id = $1", [id]);
    })
    .catch(() => {
      /* best-effort */
    });
}

export function listMemories(): Array<{ id: string; content: string; updated: number }> {
  return memories;
}

/** The corpus' recent sources (the 来源 tab's default listing). */
export async function listRecentSources(limit = 40): Promise<RecallHit[]> {
  await ready;
  const rows = await pgQuery<{
    url: string;
    title: string;
    host: string;
    ref_count: number;
    cited_count: number;
    last_seen: number;
  }>("SELECT url, title, host, ref_count, cited_count, last_seen FROM sources ORDER BY last_seen DESC LIMIT $1", [
    limit,
  ]);
  return rows.map((row) => ({
    url: row.url,
    title: row.title,
    host: row.host,
    refCount: Number(row.ref_count) || 0,
    citedCount: Number(row.cited_count) || 0,
    score: Number(row.last_seen) || 0,
  }));
}

/** Hybrid (BM25 + pgvector, weighted RRF) search over the reader cache
    -- the semantic upgrade of the past_research index picking. */
export async function searchReaderPages(
  query: string,
  limit = 4,
): Promise<Array<{ url: string; title: string; chars: number; text: string }>> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  await ready;
  const keywords = segmentKeywords(trimmed);
  const semanticReady = embeddingsConfigured();
  if (!keywords && !semanticReady) {
    return [];
  }
  interface Row {
    url: string;
    title: string;
    chars: number;
    text: string;
  }
  const [keywordRows, semanticRows] = await Promise.all([
    keywords
      ? pgQuery<Row>(
          `SELECT url, title, chars, substr(markdown, 1, 1500) AS text
           FROM reader_cache
           WHERE (search_text <@> to_bm25query($1, 'reader_bm25')) <> 0
           ORDER BY (search_text <@> to_bm25query($1, 'reader_bm25')) DESC
           LIMIT $2`,
          [keywords, limit * 2],
        )
      : Promise.resolve([] as Row[]),
    semanticReady
      ? (async () => {
          const queryVector = (await embedTexts([trimmed]))?.[0];
          if (!queryVector) {
            return [] as Row[];
          }
          return pgQuery<Row>(
            `SELECT url, title, chars, substr(markdown, 1, 1500) AS text
             FROM reader_cache WHERE embedding IS NOT NULL
             ORDER BY embedding <=> $1::vector LIMIT $2`,
            [toVectorLiteral(queryVector), limit * 2],
          );
        })()
      : Promise.resolve([] as Row[]),
  ]);
  const scores = new Map<string, { row: Row; score: number }>();
  const bump = (rows: Row[], weight: number) => {
    rows.forEach((row, rank) => {
      const rrf = weight / (60 + rank + 1);
      const entry = scores.get(row.url);
      scores.set(row.url, { row, score: (entry?.score ?? 0) + rrf });
    });
  };
  bump(keywordRows, 1.0);
  bump(semanticRows, 1.0);
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.row);
}

/** Forget one corpus source: its run links go first (run_sources keys
    on url_hash -- the pre-fix statement selected a column that never
    existed and silently removed nothing), then the row itself.  The
    reader cache is a DIFFERENT table -- an archived full-text survives
    a source forget (delete it explicitly from the 已读全文 list). */
export function deleteSource(url: string): void {
  const hash = urlHash(url);
  queue = queue
    .then(async () => {
      await ready;
      await pgQuery("DELETE FROM run_sources WHERE url_hash = $1", [hash]);
      await pgQuery("DELETE FROM sources WHERE url_hash = $1", [hash]);
      sourceTexts.delete(hash);
      readerTexts.delete(hash);
    })
    .catch(() => {
      /* best-effort */
    });
}

export function deleteSearch(q: string, category: string): void {
  const id = `s${urlHash(`${q.trim().slice(0, 200)}|${category || "general"}`)}`;
  queue = queue
    .then(async () => {
      await ready;
      await pgQuery("DELETE FROM searches WHERE id = $1", [id]);
    })
    .catch(() => {
      /* best-effort */
    });
}

export function recordClassicResults(
  q: string,
  results: Array<{ url?: string; title?: string; netloc?: string }>,
): void {
  const query = q.trim().slice(0, 200);
  if (!query || results.length === 0) {
    return;
  }
  const rid = `classic:${urlHash(`${query}`)}`;
  const now = Date.now();
  queue = queue
    .then(async () => {
      await ready;
      const db = await pg();
      for (const [idx, result] of results.entries()) {
        if (!result?.url) {
          continue;
        }
        await linkSource(db, rid, { ...result, n: idx + 1 }, now, false);
      }
    })
    .catch(() => {
      /* best-effort: the corpus is a mirror, never the search's blocker */
    });
}

export function recordSearch(q: string, category: string, results: number): void {
  const query = q.trim().slice(0, 200);
  if (!query) {
    return;
  }
  const cat = category || "general";
  const id = `s${urlHash(`${query}|${cat}`)}`;
  const now = Date.now();
  queue = queue
    .then(async () => {
      await ready;
      await pgQuery(
        `INSERT INTO searches (id, q, category, results, times, created, last_ran)
         VALUES ($1, $2, $3, $4, 1, $5, $5)
         ON CONFLICT (id) DO UPDATE SET results = EXCLUDED.results,
           times = searches.times + 1, last_ran = EXCLUDED.last_ran`,
        [id, query, cat, results, now],
      );
    })
    .catch(() => {
      /* best-effort */
    });
}

export interface SearchHistoryEntry {
  q: string;
  category: string;
  results: number;
  times: number;
  lastRan: number;
}

/** The search history (keyword-filtered, newest first).  Async (SQL). */
export async function listSearchHistory(query: string, limit = 30): Promise<SearchHistoryEntry[]> {
  await ready;
  const trimmed = query.trim();
  const keywords = segmentKeywords(trimmed);
  const rows = keywords
    ? await pgQuery<SearchHistoryEntry>(
        `SELECT q, category, results, times, last_ran AS lastRan
         FROM searches WHERE (q <@> to_bm25query($1, 'searches_bm25')) <> 0
         ORDER BY last_ran DESC LIMIT $2`,
        [keywords, limit],
      )
    : await pgQuery<SearchHistoryEntry>(
        "SELECT q, category, results, times, last_ran AS lastRan FROM searches ORDER BY last_ran DESC LIMIT $1",
        [limit],
      );
  return rows.map((row) => ({
    q: row.q,
    category: row.category,
    results: Number(row.results) || 0,
    times: Number(row.times) || 1,
    lastRan: Number(row.lastRan),
  }));
}
