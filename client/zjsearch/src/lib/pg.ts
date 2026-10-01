// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The real database: PGlite (WASM Postgres) persisted to the browser's
    IndexedDB through PGlite's own `idb://` filesystem, with pgvector (the
    semantic half of the search) and pg_textsearch (the BM25 keyword
    half).  The module is dynamically imported by its consumers, so the
    ~3MB WASM stays out of the eager graph -- the first AI-thread
    operation pays the load once, the promise is cached for the session.

    Schema v2 (relational: the query dimensions are rows, the replay
    dimensions stay blobs):

    - threads -- the directory row (title, timestamps) plus the
      thread-level search columns (the AGGREGATE of its runs' Q&A text --
      the history drawer ranks by them).
    - runs -- one row per AI-search run: the query columns (question,
      mode, status, usage, timestamps) AND `data` jsonb, the run's full
      replay object (the UI rehydrates from it -- the blob half of the
      split).  Runs carry their own search columns (question + answer
      prose), so a future run-level drawer rides existing data.
    - sources -- the GLOBAL source registry keyed by normalized-url hash:
      one row per url no matter how many runs referenced it, with
      ref/cited counters and its own search columns.  This is the
      browser's research corpus (the history recall ranks by it) -- a
      design red line keeps it OUT of the researcher's path: recalled
      sources may only reach the writer phase or the UI, never the
      researcher's feed (ready-made material kills the search incentive).
    - run_sources -- the (run, source) link with the run's global [n],
      the link kind and whether the settled answer cited it.

    Boot: open (with both extensions registered), CREATE EXTENSION and
    CREATE TABLE (idempotent).  A PRE-v2 database (the old blob-shaped
    `threads.data` column) is dropped wholesale -- no migration: the
    store's identity is the browser's own research memory and the v1
    data never left the dev browsers.  Embedding columns are
    dimension-locked at creation: the width change still needs the
    tables dropped. */

export type Pg = import("@electric-sql/pglite").PGlite;

import { embeddingDimensions } from "@/lib/embed.ts";

let pgPromise: Promise<Pg> | null = null;

/** The embedding columns' width -- set once at boot from the embedding
    capability (default 1024).  A LATER change needs the tables dropped:
    pgvector columns are dimension-locked at creation.  The width is
    resolved LAZILY at boot from lib/embed's configured capability (the
    same source the embed calls use) so an early-boot payload without
    the capability cannot lock the columns at the default. */
let pgDimensions = 1024;

export function configurePgDimensions(dims: number): void {
  if (pgPromise === null) {
    pgDimensions = dims;
  }
}

/** The pgvector text literal of an embedding (`'[0.1,0.2,...]'`). */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => value.toFixed(6)).join(",")}]`;
}

/** The session's PGlite database (created on first use). */
export function pg(): Promise<Pg> {
  pgPromise ??= boot();
  return pgPromise;
}

/** The FULL reset (the preferences surface's nuclear option): drop every
    table, close the session and forget the boot promise -- the next
    ``pg()`` call re-runs the boot DDL on a fresh empty database.  The
    physical IndexedDB file stays (PGlite owns it); only the schema's
    contents are destroyed. */
export async function resetDatabase(): Promise<void> {
  const db = await pg();
  await db.query("DROP TABLE IF EXISTS run_sources");
  await db.query("DROP TABLE IF EXISTS runs");
  await db.query("DROP TABLE IF EXISTS threads");
  await db.query("DROP TABLE IF EXISTS sources");
  await db.close();
  pgPromise = null;
}

async function boot(): Promise<Pg> {
  const [{ PGlite }, { vector }, { pg_textsearch }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite-pgvector"),
    import("@electric-sql/pglite-pg_textsearch"),
  ]);
  const db = new PGlite({
    dataDir: "idb://zjs-ai",
    extensions: { vector, pg_textsearch },
  });
  await db.query("CREATE EXTENSION IF NOT EXISTS vector");
  await db.query("CREATE EXTENSION IF NOT EXISTS pg_textsearch");
  // the legacy drop runs FIRST: a pre-v2 table can predate whole columns
  // (an era-1 threads without search_text) and would break the DDL below
  // before the detection ever runs
  await dropLegacyV1(db);
  // the width comes from the SAME capability the embed calls use --
  // whatever the boot payload carried, the columns match the vectors
  const dims = embeddingDimensions() ?? pgDimensions;
  await db.query(`CREATE TABLE IF NOT EXISTS threads (
    id text PRIMARY KEY,
    title text NOT NULL,
    created double precision NOT NULL DEFAULT 0,
    updated double precision NOT NULL,
    search_text text NOT NULL DEFAULT '',
    embedding vector(${dims})
  )`);
  await db.query(
    "CREATE INDEX IF NOT EXISTS threads_bm25 ON threads USING bm25 (search_text) WITH (text_config = 'english')",
  );
  await db.query(`CREATE TABLE IF NOT EXISTS runs (
    id text PRIMARY KEY,
    thread_id text NOT NULL,
    seq integer NOT NULL,
    q text NOT NULL,
    mode text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'done',
    error text,
    created double precision NOT NULL DEFAULT 0,
    settled double precision,
    usage jsonb,
    data jsonb NOT NULL,
    search_text text NOT NULL DEFAULT '',
    embedding vector(${dims})
  )`);
  await db.query(
    "CREATE INDEX IF NOT EXISTS runs_bm25 ON runs USING bm25 (search_text) WITH (text_config = 'english')",
  );
  await db.query(`CREATE TABLE IF NOT EXISTS sources (
    url_hash text PRIMARY KEY,
    url text NOT NULL,
    host text NOT NULL DEFAULT '',
    title text NOT NULL DEFAULT '',
    img text,
    category text,
    first_seen double precision NOT NULL,
    last_seen double precision NOT NULL,
    ref_count integer NOT NULL DEFAULT 0,
    cited_count integer NOT NULL DEFAULT 0,
    search_text text NOT NULL DEFAULT '',
    embedding vector(${dims})
  )`);
  await db.query(
    "CREATE INDEX IF NOT EXISTS sources_bm25 ON sources USING bm25 (search_text) WITH (text_config = 'english')",
  );
  await db.query(`CREATE TABLE IF NOT EXISTS run_sources (
    run_id text NOT NULL,
    url_hash text NOT NULL,
    n integer NOT NULL,
    kind text NOT NULL DEFAULT 'search',
    cited boolean NOT NULL DEFAULT false,
    PRIMARY KEY (run_id, url_hash)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS reader_cache (
    url_hash text PRIMARY KEY,
    url text NOT NULL,
    title text NOT NULL DEFAULT '',
    markdown text NOT NULL,
    chars integer NOT NULL,
    fetched_at double precision NOT NULL,
    search_text text NOT NULL DEFAULT '',
    watched integer NOT NULL DEFAULT 0,
    last_checked double precision NOT NULL DEFAULT 0,
    embedding vector(${dims})
  )`);
  // pre-vector caches lack the embedding column (the semantic recall
  // landed after the table) -- add it, idempotently
  await db.query(`ALTER TABLE reader_cache ADD COLUMN IF NOT EXISTS embedding vector(${dims})`);
  // pre-index caches lack the BM25 column (the archive landed after the
  // table) -- add it and index, idempotently
  await db.query("ALTER TABLE reader_cache ADD COLUMN IF NOT EXISTS search_text text NOT NULL DEFAULT ''");
  await db.query(
    "CREATE INDEX IF NOT EXISTS reader_bm25 ON reader_cache USING bm25 (search_text) WITH (text_config = 'english')",
  );
  await db.query(`CREATE TABLE IF NOT EXISTS memories (
    id text PRIMARY KEY,
    content text NOT NULL,
    created double precision NOT NULL,
    updated double precision NOT NULL,
    search_text text NOT NULL DEFAULT '',
    embedding vector(${dims})
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS searches (
    id text PRIMARY KEY,
    q text NOT NULL,
    category text NOT NULL DEFAULT 'general',
    results integer NOT NULL DEFAULT 0,
    times integer NOT NULL DEFAULT 1,
    created double precision NOT NULL,
    last_ran double precision NOT NULL
  )`);
  await db.query("CREATE INDEX IF NOT EXISTS searches_bm25 ON searches USING bm25 (q) WITH (text_config = 'english')");
  return db;
}

/** The pre-v2 blob schema detection: a `threads.data` column means the
    old whole-thread-jsonb table -- drop it (with its BM25 index) and
    recreate the v2 shape.  Deliberately NO migration: the v1 data never
    left the dev browsers, and the relational identity starts clean. */
async function dropLegacyV1(db: Pg): Promise<void> {
  const cols = await db.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'threads'",
  );
  const names = new Set((cols.rows ?? []).map((row) => row.column_name));
  if (names.size === 0) {
    return; // no threads table at all (a fresh database)
  }
  const expected = new Set(["id", "title", "created", "updated", "search_text", "embedding"]);
  const isCurrent = [...expected].every((name) => names.has(name));
  if (isCurrent) {
    return;
  }
  await db.query("DROP TABLE threads");
  await db.query("DROP INDEX IF EXISTS threads_bm25");
  await db.query(`CREATE TABLE threads (
    id text PRIMARY KEY,
    title text NOT NULL,
    created double precision NOT NULL DEFAULT 0,
    updated double precision NOT NULL,
    search_text text NOT NULL DEFAULT '',
    embedding vector(${pgDimensions})
  )`);
  await db.query("CREATE INDEX threads_bm25 ON threads USING bm25 (search_text) WITH (text_config = 'english')");
}

/** The keyword text behind a BM25 index: the CJK-aware pre-segmentation
    (each han character its own token, latin/digit runs stay words) --
    shared by every searchable table.  Defined here (not lib/tokenize)
    because pg.ts is the single bootstrapper and the store imports this
    module anyway. */
const SEGMENT_RE = /[a-z0-9_]+|[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f]/g;

export function segmentKeywords(...parts: string[]): string {
  return (parts.filter(Boolean).join(" ").toLowerCase().match(SEGMENT_RE) ?? []).join(" ");
}

function segmentOf(...parts: string[]): string {
  return segmentKeywords(...parts).slice(0, 8000);
}

/** URL identity: strip the fragment and the common tracking params,
    lowercase the host, drop a trailing slash -- then hash.  FNV-1a over
    two lanes (16 hex chars); the full url is stored alongside, so the
    collision surface stays theoretical at browser scale. */
export function urlHash(url: string): string {
  let normalized: string;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const drop = [...parsed.searchParams.keys()].filter((key) =>
      /^(utm_|ref|referrer|fbclid|gclid|spm|scm)/i.test(key),
    );
    for (const key of drop) {
      parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    normalized = parsed.toString().replace(/\?$/, "").replace(/\/$/, "");
  } catch {
    normalized = url.trim();
  }
  let laneA = 0x811c9dc5;
  let laneB = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    laneA = (laneA ^ code) * 0x01000193;
    laneB = (laneB ^ ((code << (i & 7)) & 0xffffffff)) * 0x01000193;
    laneA >>>= 0;
    laneB >>>= 0;
  }
  return laneA.toString(16).padStart(8, "0") + laneB.toString(16).padStart(8, "0");
}

/** One typed query helper (single statement -- PGlite's query is a
    prepared statement and rejects multi-command strings). */
export async function pgQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pg();
  const result = await db.query(sql, params);
  return (result.rows ?? []) as T[];
}

/** Upsert one source into the global registry and link it to a run.
    The ref/cited counters accumulate across runs; the search text is the
    title + host (the corpus the history recall ranks by).  The store's
    sync and nothing else calls this. */
export async function linkSource(
  db: Pg,
  runId: string,
  source: {
    url?: string;
    title?: string;
    host?: string;
    netloc?: string;
    img?: string;
    category?: string;
    crawled?: boolean;
    n?: number;
  },
  seenAt: number,
  cited = false,
): Promise<void> {
  const hash = urlHash(String(source.url));
  const host = String(source.netloc ?? source.host ?? "");
  const title = String(source.title ?? "");
  const kind = source.crawled ? "reader" : "search";
  await db.query(
    `INSERT INTO sources (url_hash, url, host, title, img, category, first_seen, last_seen, ref_count, cited_count, search_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 1, $8, $9)
     ON CONFLICT (url_hash) DO UPDATE SET
       last_seen = GREATEST(sources.last_seen, EXCLUDED.last_seen),
       title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE sources.title END,
       img = COALESCE(EXCLUDED.img, sources.img),
       ref_count = sources.ref_count + 1,
       cited_count = sources.cited_count + EXCLUDED.cited_count`,
    [
      hash,
      String(source.url),
      host,
      title,
      source.img ? String(source.img) : null,
      source.category ? String(source.category) : null,
      seenAt,
      cited ? 1 : 0,
      segmentOf(title, host),
    ],
  );
  await db.query(
    `INSERT INTO run_sources (run_id, url_hash, n, kind, cited) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (run_id, url_hash) DO UPDATE SET cited = run_sources.cited OR EXCLUDED.cited`,
    [runId, hash, Number(source.n ?? 0) || 0, kind, cited],
  );
}
