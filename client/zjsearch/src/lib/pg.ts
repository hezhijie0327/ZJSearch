// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The real database: PGlite (WASM Postgres) persisted to the browser's
    IndexedDB through PGlite's own `idb://` filesystem, with pgvector (the
    semantic half of the search), pg_textsearch (the BM25 keyword half) and
    pg_trgm (the typo rescue).  The module is dynamically imported by its
    consumers, so the ~3MB WASM stays out of the eager graph -- the first
    knowledge operation pays the load once, the promise is cached for the
    session.

    Schema v5 -- the aggregates move OFF the hot read paths: the per-kind
    counts/bytes live in a trigger-maintained ``stats`` table, every
    settled run carries a ``run_summary`` row (full answer + usage), and
    ``knowledge`` gains write-time ``bytes``/``head`` columns -- every
    scan, aggregate and work queue costs O(projections), never
    O(projections + events), and no read ever detoasts a full text:

    - run_event   the wire log, one row per event (data = the whole event,
                  PK (run_id, n)) -- replay's source, excluded from every
                  retrieval index
    - knowledge   the projections, one row per knowledge object:
                  run / answer (the AI Overview archive) / source /
                  source_ref / document / memory / call / task / clarify
    - thread_head the thread directory, maintained at settle (a 40-row
                  indexed listing)
    - run_summary the per-run rollup the directory/inspector/stats read
    - stats       the per-kind counter/byte ledger (trigger-maintained)

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
  for (const table of ["knowledge", "run_event", "thread_head", "run_summary", "stats", "attachment"]) {
    await db.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
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
  scheduleVacuum(db);
  return db;
}

/** A throttled `VACUUM ANALYZE` (one shot per 24h, 30s after boot so it
    never competes with the first queries): the visibility map an index-only
    scan needs is only built by VACUUM, and a database that never gets one
    degrades every `GROUP BY`/count onto full heap scans -- the stats page's
    old sluggishness had this as a cofactor.  Fire-and-forget: a failure
    (or a webview without localStorage) costs nothing. */
function scheduleVacuum(db: Pg): void {
  setTimeout(() => {
    void (async () => {
      try {
        const at = Number(localStorage.getItem("zjs-pg-vacuum-at") ?? 0);
        if (Date.now() - at < 24 * 3600 * 1000) {
          return;
        }
        localStorage.setItem("zjs-pg-vacuum-at", String(Date.now()));
        await db.query("VACUUM ANALYZE knowledge");
        await db.query("VACUUM ANALYZE run_event");
        await db.query("VACUUM ANALYZE run_summary");
        await db.query("VACUUM ANALYZE thread_head");
      } catch (err) {
        console.warn("zjsearch pg: vacuum pass failed (harmless)", err);
      }
    })();
  }, 30_000);
}

/** The schema DDL (idempotent): boot runs it once, the full reset re-runs
    it on the spot.  v5's marker is the ``run_summary`` table: a database
    WITHOUT it is a v4 store -- compatibility is explicitly waived, so it
    dies WHOLESALE (the v2 precedent) and the fresh schema rises in its
    place.  The relational furniture:

    - ``knowledge.bytes`` / ``knowledge.head`` -- computed ONCE per write by
      a BEFORE trigger (``octet_length`` forces a TOAST detoast; doing it at
      read time was the stats page's ``sum(octet_length(body))`` full-scan
      tax).  ``head`` is the listing excerpt: directory queries select
      ``head AS body`` and never touch the full text.
    - ``stats`` -- per-kind row counts + bytes, maintained by an AFTER
      trigger (inserts/upserts/deletes all land correctly, deletes included
      -- no write-site bookkeeping to forget, no drift).
    - ``run_summary`` -- one row per settled run (full answer text, usage,
      phases): the directory/inspector/stats reads that used to reassemble
      from the event log become one-row (or one-small-table) reads. */
async function createSchema(db: Pg): Promise<void> {
  // the width comes from the SAME capability the embed calls use --
  // whatever the boot payload carried, the column matches the vectors
  const dims = embeddingDimensions() ?? pgDimensions;
  const hadV5 = await db.query<{ present: boolean }>("SELECT to_regclass('run_summary') IS NOT NULL AS present");
  const carried = !(hadV5.rows ?? [])[0]?.present;
  if (carried) {
    // a v4 database (or a fresh one -- the drops no-op): v4 dies wholesale
    for (const table of ["knowledge", "run_event", "thread_head"]) {
      await db.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
  }
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
    head        text NOT NULL DEFAULT '',
    bytes       integer NOT NULL DEFAULT 0,
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
  // v5.1: the thread directory carries its report count (the 报告 badge +
  // the directory's report filter read it; idempotent for existing DBs)
  await db.query("ALTER TABLE thread_head ADD COLUMN IF NOT EXISTS reports integer NOT NULL DEFAULT 0");
  // the manual-rename lock: a user-renamed thread's title survives every
  // settle (the auto title only writes while the lock is 0)
  await db.query("ALTER TABLE thread_head ADD COLUMN IF NOT EXISTS title_manual integer NOT NULL DEFAULT 0");
  await db.query(`CREATE TABLE IF NOT EXISTS run_summary (
    run_id      text PRIMARY KEY,
    thread_id   text NOT NULL,
    q           text NOT NULL DEFAULT '',
    mode        text NOT NULL DEFAULT '',
    model       text,
    status      text NOT NULL DEFAULT 'done',
    events      integer NOT NULL DEFAULT 0,
    sources     integer NOT NULL DEFAULT 0,
    answer      text NOT NULL DEFAULT '',
    usage       jsonb,
    phases      jsonb NOT NULL DEFAULT '[]',
    started_at  double precision,
    settled_at  double precision
  )`);
  // v5.2: the report shape's per-section texts (the knowledge inspector
  // renders the DOCUMENT the same way the research page does -- outline
  // headings + per-section bodies -- which the glued answer string alone
  // cannot reconstruct).  Idempotent for existing databases.
  await db.query("ALTER TABLE run_summary ADD COLUMN IF NOT EXISTS sections jsonb");
  await db.query("CREATE INDEX IF NOT EXISTS run_summary_thread ON run_summary (thread_id, settled_at DESC)");
  await db.query(`CREATE TABLE IF NOT EXISTS stats (
    kind    text PRIMARY KEY,
    n       bigint NOT NULL DEFAULT 0,
    bytes   bigint NOT NULL DEFAULT 0
  )`);
  // user-uploaded attachments (AI Search's paperclip): the BYTES stay
  // browser-local (data URLs) -- the server stores and never sees them
  // again after forwarding the parts to the vision model
  await db.query(`CREATE TABLE IF NOT EXISTS attachment (
    id        text PRIMARY KEY,
    run_id    text NOT NULL,
    thread_id text NOT NULL,
    kind      text NOT NULL,
    mime      text NOT NULL,
    name      text NOT NULL DEFAULT '',
    bytes     integer NOT NULL DEFAULT 0,
    data      text NOT NULL,
    created   double precision NOT NULL DEFAULT 0
  )`);
  await db.query("CREATE INDEX IF NOT EXISTS attachment_run ON attachment (run_id)");
  await db.query("CREATE INDEX IF NOT EXISTS attachment_thread ON attachment (thread_id)");
  await db.query(
    "CREATE INDEX IF NOT EXISTS knowledge_bm25 ON knowledge USING bm25 (search_text) WITH (text_config = 'english')",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS knowledge_hnsw ON knowledge USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL",
  );
  // the write-time projection triggers: bytes/head computed once per write;
  // the per-kind ledger maintained on every insert/update/delete (the
  // UPDATE guard skips no-op updates -- the embed pass touches columns the
  // ledger does not read).  IDEMPOTENT: boot re-runs the DDL on EVERY page
  // load -- plain CREATE FUNCTION/TRIGGER would fail the second boot with
  // "already exists" and take the whole store down for the session (the
  // knowledge base read as empty; every write died with it).
  await db.query(`CREATE OR REPLACE FUNCTION knowledge_bytes_trg() RETURNS trigger AS $$
    DECLARE changed boolean := TG_OP = 'INSERT';
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        changed := NEW.body IS DISTINCT FROM OLD.body OR NEW.title IS DISTINCT FROM OLD.title
          OR NEW.search_text IS DISTINCT FROM OLD.search_text;
      END IF;
      IF changed THEN
        NEW.bytes := octet_length(NEW.body) + octet_length(NEW.title) + octet_length(COALESCE(NEW.search_text, ''));
        NEW.head := left(NEW.body, 600);
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await db.query("DROP TRIGGER IF EXISTS knowledge_bytes ON knowledge");
  await db.query(
    "CREATE TRIGGER knowledge_bytes BEFORE INSERT OR UPDATE ON knowledge FOR EACH ROW EXECUTE FUNCTION knowledge_bytes_trg()",
  );
  await db.query(`CREATE OR REPLACE FUNCTION knowledge_stats_trg() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.kind = NEW.kind AND OLD.bytes = NEW.bytes THEN
        RETURN NULL;
      END IF;
      IF TG_OP <> 'DELETE' THEN
        INSERT INTO stats (kind, n, bytes) VALUES (NEW.kind, 1, NEW.bytes)
          ON CONFLICT (kind) DO UPDATE SET n = stats.n + 1, bytes = stats.bytes + EXCLUDED.bytes;
      END IF;
      IF TG_OP <> 'INSERT' THEN
        UPDATE stats SET n = n - 1, bytes = bytes - OLD.bytes WHERE kind = OLD.kind;
      END IF;
      RETURN NULL;
    END $$ LANGUAGE plpgsql`);
  await db.query("DROP TRIGGER IF EXISTS knowledge_stats ON knowledge");
  await db.query(
    "CREATE TRIGGER knowledge_stats AFTER INSERT OR UPDATE OR DELETE ON knowledge FOR EACH ROW EXECUTE FUNCTION knowledge_stats_trg()",
  );
  // the tag dimension, relational at last: the `?`/`?|` membership
  // queries (graphRecall, itemsByTag) ride this GIN instead of expanding
  // every row's jsonb
  await db.query("CREATE INDEX IF NOT EXISTS knowledge_tags ON knowledge USING gin (tags jsonb_ops)");
  // the two work queues ran a full scan per settle to select NOTHING when
  // idle -- the partial indexes make the idle probe an index check.  The
  // embed-pending predicate EXCLUDES source_ref rows (they carry
  // search_text from title+host but are never embedded): without the kind
  // guard the partial index fills with permanent members and the probe
  // walks them all, every settle, forever (the v4 pathology one level
  // down).  DROP-first: a definition change needs it (CREATE IF NOT
  // EXISTS would keep the stale index).
  await db.query("DROP INDEX IF EXISTS knowledge_embed_pending");
  await db.query(
    "CREATE INDEX knowledge_embed_pending ON knowledge (updated) WHERE embed_model IS NULL AND search_text <> '' AND kind <> 'source_ref'",
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
  // the kind listing index serves the TWO-key sort (pinned DESC, updated
  // DESC) the directory's per-kind tabs issue on every refetch -- the old
  // (kind, updated) shape filtered on the first key and sorted the whole
  // kind partition in WASM.  DROP-first for the same reason.
  await db.query("DROP INDEX IF EXISTS knowledge_kind");
  await db.query("CREATE INDEX knowledge_kind ON knowledge (kind, pinned DESC, updated DESC)");
  await db.query("CREATE INDEX IF NOT EXISTS knowledge_thread ON knowledge (thread_id, kind)");
  await db.query("CREATE INDEX IF NOT EXISTS knowledge_run ON knowledge (run_id, n)");
  await db.query("CREATE INDEX IF NOT EXISTS knowledge_url ON knowledge (url_hash)");
  await db.query(
    "CREATE INDEX IF NOT EXISTS knowledge_embedded ON knowledge (embed_model) WHERE embed_model IS NOT NULL",
  );
  // the thread directory's listing sort (the live subscription re-fires
  // it on every settle/pin/delete)
  await db.query("CREATE INDEX IF NOT EXISTS thread_head_listing ON thread_head (pinned DESC, updated DESC)");
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
