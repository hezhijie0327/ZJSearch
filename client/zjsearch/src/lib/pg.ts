// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The real database: PGlite (WASM Postgres) persisted to the browser's
    IndexedDB through PGlite's own `idb://` filesystem, with pgvector (the
    semantic half of the search), pg_textsearch (the BM25 keyword half) and
    pg_trgm (the typo rescue).  The module is dynamically imported by its
    consumers, so the ~3MB WASM stays out of the eager graph -- the first
    knowledge operation pays the load once, the promise is cached for the
    session.

    Schema v4 -- the event log moves to its OWN table (`run_event`), so
    every projection scan, aggregate and work queue costs O(projections),
    never O(projections + events); the projections stay one `knowledge`
    table (kinds are few, identities are id-keyed):

    - run_event   the wire log, one row per event (data = the whole event,
                  PK (run_id, n)) -- replay's source, excluded from every
                  retrieval index
    - knowledge   the projections, one row per knowledge object:
                  run / answer (the AI Overview archive) / source /
                  source_ref / document / memory / call / task / clarify
    - thread_head the thread directory, maintained at settle (the old
                  GROUP BY + correlated-subqueries aggregate re-fired on
                  every evt flush; this is a 40-row indexed listing)

    Relational furniture v4 puts to work: a GIN index on tags (the tag
    queries ride `?` / `?|`), partial indexes for the two work queues
    (embed-pending, tag-normalize -- the old shape full-scanned to find
    nothing, twice per settle), and a GiST trgm index serving the rescue
    as a KNN ordering.  Boot: open (with the four extensions registered),
    CREATE EXTENSION / CREATE TABLE (idempotent); a database carrying ANY
    legacy v2 table (threads/runs/sources/...) is dropped wholesale -- no
    migration, the v1/v2 data never left dev browsers.  The v3 -> v4
    upgrade is IN PLACE: the evt rows copy into run_event (one idempotent
    INSERT..SELECT, safe to resume after a crash) and leave `knowledge`. */

export type Pg = import("@electric-sql/pglite").PGlite;

import { embeddingDimensions } from "@/lib/embed.ts";

let pgPromise: Promise<Pg> | null = null;

/** The embedding columns' width -- set once at boot from the embedding
    capability (default 1024).  A LATER change needs the table dropped:
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

/** The FULL reset (the knowledge page's nuclear option): drop the tables
    and re-run the schema DDL ON THE SAME LIVE CONNECTION -- the old
    close-and-reopen dance raced PGlite's IndexedDB flush (a re-opened
    database could serve the pre-drop state back, reads as "the reset did
    nothing"), and a closed shared handle wedged every live subscription.
    CASCADE for the pg_textsearch/hnsw internals (the legacy-drop lesson).
    The physical IndexedDB file stays (PGlite owns it); only the schema's
    contents are destroyed. */
export async function resetDatabase(): Promise<void> {
  const db = await pg();
  await db.query("DROP TABLE IF EXISTS knowledge CASCADE");
  await db.query("DROP TABLE IF EXISTS run_event CASCADE");
  await db.query("DROP TABLE IF EXISTS thread_head CASCADE");
  await createSchema(db);
}

const LEGACY_TABLES = ["run_sources", "runs", "threads", "sources", "reader_cache", "memories", "searches"] as const;

async function bootWorker(): Promise<Pg> {
  // the engine lives in a WEB WORKER (pg.worker.ts holds the WASM and the
  // data extensions): a boot or a heavy query cannot eat the main thread's
  // render budget -- the AI surfaces' performance floors paid for exactly
  // that.  The relay speaks the full surface (query / transaction / live);
  // only the LIVE plugin passes main-side (its polling wraps the relayed
  // queries), the DATA extensions ride inside the worker.
  const [{ PGliteWorker }, { live }] = await Promise.all([
    import("@electric-sql/pglite/worker"),
    import("@electric-sql/pglite/live"),
  ]);
  const worker = new Worker(new URL("./pg.worker.ts", import.meta.url), { type: "module" });
  // a hang is a REAL outcome in restricted webviews (module workers are a
  // compatibility gap in some of them): race the readiness and fall back
  // rather than wedging the whole store
  const created = PGliteWorker.create(worker, {
    dataDir: "idb://zjs-ai",
    extensions: { live },
  });
  const raced = await Promise.race([
    created,
    new Promise((resolve) => setTimeout(() => resolve("WORKER_TIMEOUT"), 10_000)),
  ]);
  if (raced === "WORKER_TIMEOUT") {
    worker.terminate();
    throw new Error("the worker engine did not become ready in 10s");
  }
  return raced as unknown as Pg;
}

async function bootMain(): Promise<Pg> {
  const [{ PGlite }, { vector }, { pg_textsearch }, { live }, { pg_trgm }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite-pgvector"),
    import("@electric-sql/pglite-pg_textsearch"),
    import("@electric-sql/pglite/live"),
    import("@electric-sql/pglite/contrib/pg_trgm"),
  ]);
  const db = new PGlite({
    dataDir: "idb://zjs-ai",
    extensions: { vector, pg_textsearch, live, pg_trgm },
  });
  await db.query("CREATE EXTENSION IF NOT EXISTS vector");
  await db.query("CREATE EXTENSION IF NOT EXISTS pg_textsearch");
  await db.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  return db;
}

async function boot(): Promise<Pg> {
  let db: Pg;
  try {
    db = await bootWorker();
  } catch (err) {
    // a hostile environment for module workers (CSP, ancient webview):
    // fall back to the main-thread engine -- the render-budget win is
    // lost, the DATA survives
    console.warn("zjsearch pg: the worker engine failed -- falling back to the main thread", err);
    db = await bootMain();
  }
  // the v2-and-older databases die wholesale (the v1 drop was the
  // precedent): detect ANY legacy table before the new schema exists.
  // CASCADE because the old live-query views / bm25 internals can hold
  // dependencies a plain drop trips over, and one stubborn table must
  // never wedge the whole store boot (observed: "cannot drop table
  // searches because other objects depend on it" -> every store call
  // failed silently for the session).
  const legacy = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_name = ANY($1::text[])`,
    [[...LEGACY_TABLES]],
  );
  for (const name of new Set((legacy.rows ?? []).map((row) => row.table_name))) {
    try {
      await db.query(`DROP TABLE IF EXISTS ${String(name)} CASCADE`);
    } catch (err) {
      console.warn(`zjsearch pg: legacy table ${String(name)} could not be dropped`, err);
    }
  }
  await createSchema(db);
  return db;
}

/** The schema DDL + the idempotent data repairs: boot runs it once, the
    full reset re-runs it on the spot (the re-runnable migration/backfill
    guards make a fresh drop + recreate exact). */
async function createSchema(db: Pg): Promise<void> {
  // the width comes from the SAME capability the embed calls use --
  // whatever the boot payload carried, the column matches the vectors
  const dims = embeddingDimensions() ?? pgDimensions;
  // the event log's own table (v4): its existence is the schema marker --
  // a database without it carries v3 evt rows to copy over
  const hadRunEvent = await db.query<{ present: boolean }>("SELECT to_regclass('run_event') IS NOT NULL AS present");
  const fresh = !(hadRunEvent.rows ?? [])[0]?.present;
  await db.query(`CREATE TABLE IF NOT EXISTS knowledge (
    id          text PRIMARY KEY,
    kind        text NOT NULL,
    thread_id   text,
    run_id      text,
    url_hash    text,
    url         text,
    host        text,
    title       text NOT NULL DEFAULT '',
    body        text NOT NULL DEFAULT '',
    meta        jsonb NOT NULL DEFAULT '{}',
    status      text NOT NULL DEFAULT 'done',
    n           integer,
    pinned      integer NOT NULL DEFAULT 0,
    refs        integer NOT NULL DEFAULT 0,
    cited       integer NOT NULL DEFAULT 0,
    tags        jsonb NOT NULL DEFAULT '[]',
    search_text text NOT NULL DEFAULT '',
    embedding   vector(${dims}),
    embed_model text,
    created     double precision NOT NULL,
    updated     double precision NOT NULL,
    occurred_at double precision
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS run_event (
    run_id      text NOT NULL,
    n           integer NOT NULL,
    thread_id   text,
    occurred_at double precision NOT NULL,
    data        jsonb NOT NULL,
    PRIMARY KEY (run_id, n)
  )`);
  await db.query("CREATE INDEX IF NOT EXISTS run_event_thread ON run_event (thread_id, occurred_at)");
  await db.query(`CREATE TABLE IF NOT EXISTS thread_head (
    thread_id text PRIMARY KEY,
    title     text NOT NULL DEFAULT '',
    preview   text NOT NULL DEFAULT '',
    runs      integer NOT NULL DEFAULT 0,
    sources   integer NOT NULL DEFAULT 0,
    updated   double precision NOT NULL DEFAULT 0,
    pinned    integer NOT NULL DEFAULT 0
  )`);
  if (fresh) {
    // the v3 -> v4 upgrade, IN PLACE: the evt rows move to their own
    // table (DO NOTHING keeps a crash-resumed re-run idempotent), the
    // projections table loses them and v3's dead column; nothing replays,
    // nothing drops.  Failure-safe: a thrown copy leaves the data in
    // place and the next boot resumes (the DELETE only runs after a
    // clean copy).
    try {
      await db.query(
        `INSERT INTO run_event (run_id, n, thread_id, occurred_at, data)
         SELECT run_id, n, thread_id, occurred_at, meta FROM knowledge
         WHERE kind = 'evt' AND run_id IS NOT NULL AND n IS NOT NULL
         ON CONFLICT DO NOTHING`,
      );
      await db.query("DELETE FROM knowledge WHERE kind = 'evt'");
      await db.query("ALTER TABLE knowledge DROP COLUMN IF EXISTS parent_id");
    } catch (err) {
      console.warn("zjsearch pg: v3->v4 event-log migration failed -- will retry next boot", err);
    }
  }
  // the thread directory backfill -- EVERY boot, idempotent: threads that
  // predate thread_head (the v3 era, or a run row written by anything
  // other than settleRun) join the directory here.  settleRun stays the
  // owner of live counters (DO NOTHING never clobbers them).
  try {
    await db.query(
      `INSERT INTO thread_head (thread_id, title, preview, runs, sources, updated, pinned)
       SELECT k.thread_id,
              (SELECT k2.title FROM knowledge k2 WHERE k2.thread_id = k.thread_id AND k2.kind = 'run' ORDER BY k2.n LIMIT 1),
              COALESCE((SELECT substring(k3.meta->>'answer' FROM 1 FOR 400) FROM knowledge k3
                        WHERE k3.thread_id = k.thread_id AND k3.kind = 'run' ORDER BY k3.n DESC LIMIT 1), ''),
              count(*),
              COALESCE(sum((k.meta->>'sources')::int), 0),
              max(k.updated),
              max(k.pinned)
       FROM knowledge k WHERE k.kind = 'run' AND k.thread_id IS NOT NULL
       GROUP BY k.thread_id
       ON CONFLICT (thread_id) DO NOTHING`,
    );
  } catch (err) {
    console.warn("zjsearch pg: thread_head backfill failed", err);
  }
  await db.query(
    "CREATE INDEX IF NOT EXISTS knowledge_bm25 ON knowledge USING bm25 (search_text) WITH (text_config = 'english')",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS knowledge_hnsw ON knowledge USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL",
  );
  // the tag dimension, relational at last: the `?`/`?|` membership
  // queries (graphRecall, itemsByTag) ride this GIN instead of expanding
  // every row's jsonb
  await db.query("CREATE INDEX IF NOT EXISTS knowledge_tags ON knowledge USING gin (tags jsonb_ops)");
  // the two work queues ran a full scan per settle to select NOTHING when
  // idle -- the partial indexes make the idle probe an index check
  await db.query(
    "CREATE INDEX IF NOT EXISTS knowledge_embed_pending ON knowledge (updated) WHERE embed_model IS NULL AND search_text <> ''",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS knowledge_tnormed ON knowledge (updated) WHERE (meta->>'tnormed') IS DISTINCT FROM '1' AND tags <> '[]'::jsonb",
  );
  // the trigram rescue as a KNN ordering (title <-> query): GiST serves
  // it, the old GIN served no query shape we ever issued -- replaced
  await db.query("DROP INDEX IF EXISTS knowledge_trgm");
  try {
    await db.query("CREATE INDEX IF NOT EXISTS knowledge_trgm_gist ON knowledge USING gist (title gist_trgm_ops)");
  } catch (err) {
    // a pglite build without gist_trgm_ops: the rescue stays a (rare,
    // zero-signal-only) seq scan
    console.warn("zjsearch pg: gist_trgm_ops unavailable -- the trigram rescue stays a seq scan", err);
  }
  await db.query("CREATE INDEX IF NOT EXISTS knowledge_kind ON knowledge (kind, updated DESC)");
  await db.query("CREATE INDEX IF NOT EXISTS knowledge_thread ON knowledge (thread_id, kind)");
  await db.query("CREATE INDEX IF NOT EXISTS knowledge_run ON knowledge (run_id, n)");
  await db.query("CREATE INDEX IF NOT EXISTS knowledge_url ON knowledge (url_hash)");
  // the answer kind changed semantics (run answers -> the AI Overview
  // archive): the old per-run projections were pure duplicates of the evt
  // replay -- sweep them once per boot, idempotent and cheap
  await db.query("DELETE FROM knowledge WHERE kind = 'answer' AND id LIKE 'ans:%'");
  // overviews saved before the meta-sentinel strip carry the raw
  // `<<<zjs-meta:{...}>>>` tail -- truncate at the marker (data fix, not
  // DDL: the pg_textsearch tuples stay intact)
  await db.query(
    "UPDATE knowledge SET body = substring(body FROM 1 FOR position('<<<zjs-meta:' IN body) - 1) WHERE kind = 'answer' AND position('<<<zjs-meta:' IN body) > 0",
  );
}

/** The keyword text behind a BM25 index: the CJK-aware pre-segmentation
    (each han character its own token, latin/digit runs stay words) --
    shared by every searchable row.  Latin accents fold FIRST (café →
    cafe) on both the write and the query side -- they pass through this
    one function, so the two sides can never drift.  The fold lives here
    and NOT in the SQL unaccent dictionary on purpose: pg_textsearch's
    bm25 only accepts its built-in text search configurations (a custom
    unaccent config fails CREATE INDEX with "text search configuration
    does not exist", probed against pglite 0.5.8), and the segmentation
    is JS anyway -- an SQL fold could never sit in front of it. */
const SEGMENT_RE = /[a-z0-9_]+|[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f]/g;

/** NFD-decomposable accents strip with the combining marks; the map
    catches what NFD leaves alone (compatibility forms and letters
    without a canonical decomposition). */
const FOLD_MAP: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ł: "l",
  ð: "d",
  þ: "th",
};
const FOLD_MARKS = /[\u0300-\u036f]/g;

function foldAccents(text: string): string {
  return text
    .replace(/[ßæœøđłðþ]/g, (ch) => FOLD_MAP[ch] ?? ch)
    .normalize("NFD")
    .replace(FOLD_MARKS, "");
}

export function segmentKeywords(...parts: string[]): string {
  return (foldAccents(parts.filter(Boolean).join(" ").toLowerCase()).match(SEGMENT_RE) ?? []).join(" ");
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

/** The one member a statement needs of a database handle -- the live
    connection OR a transaction's tx both satisfy it. */
export type QueryClient = Pick<Pg, "query">;

/** One typed query helper (single statement -- PGlite's query is a
    prepared statement and rejects multi-command strings).  An explicit
    ``client`` (a transaction's tx) routes the statement onto it. */
export async function pgQuery<T>(sql: string, params: unknown[] = [], client?: QueryClient): Promise<T[]> {
  const db = client ?? (await pg());
  const result = await db.query(sql, params);
  return (result.rows ?? []) as T[];
}

/** One transaction: the body's statements commit together or not at all.
    PGlite is a single connection, so this buys ATOMICITY for a
    multi-statement write like settleRun -- never concurrency (the store's
    ordered queue serializes everything anyway). */
export async function pgTransaction<T>(body: (client: QueryClient) => Promise<T>): Promise<T> {
  const db = await pg();
  return db.transaction((tx) => body(tx));
}
