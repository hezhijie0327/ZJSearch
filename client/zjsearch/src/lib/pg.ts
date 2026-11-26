// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The real database: PGlite (WASM Postgres) persisted to the browser's
    IndexedDB through PGlite's own `idb://` filesystem, with pgvector (the
    semantic half of the search), pg_textsearch (the BM25 keyword half) and
    pg_trgm (the typo rescue).  The module is dynamically imported by its
    consumers, so the ~3MB WASM stays out of the eager graph -- the first
    knowledge operation pays the load once, the promise is cached for the
    session.  The SCHEMA (tables, indexes, the v4->v5 policy) lives in
    pgSchema.ts; this module owns the boot, the degradation and the query
    helpers. */

import { createSchema, type Pg } from "@/lib/pgSchema.ts";

let pgPromise: Promise<Pg> | null = null;
let pgDegradedMemory = false;

/** True when this session's store is the IN-MEMORY degradation (the real
    store was unwedgeable -- a dead tab holding the election lock, a
    broken worker AND main lane).  Data written there does not survive
    the page; the next full reload retries the real boot. */
export function pgIsDegraded(): boolean {
  return pgDegradedMemory;
}

/** The embedding columns' width -- set once at boot from the embedding
    capability (default 1024).  A LATER change needs the table dropped:
    pgvector columns are dimension-locked at creation.  The width is
    resolved LAZILY at boot from lib/embed's configured capability (the
    same source the embed calls use) so an early-boot payload without
    the capability cannot lock the columns at the default. */
let pgDimensions = 1024;

/** The embedding capability's model name -- the OTHER half of the vector
    space's identity (rows record it per row; the reconcile pass keys on
    the pair).  Set from the same boot payload as the dimensions. */
let pgEmbedModel = "";

export function configurePgDimensions(dims: number): void {
  if (pgPromise === null) {
    pgDimensions = dims;
  }
}

export function configurePgEmbedModel(model: string): void {
  if (pgPromise === null) {
    pgEmbedModel = model;
  }
}

/** The pgvector text literal of an embedding (`'[0.1,0.2,...]'`). */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => value.toFixed(6)).join(",")}]`;
}

/** The session's PGlite database (created on first use).  A FAILED boot
    no longer poisons the session: the memo clears and the next store
    call retries the real boot (a transient election fight heals itself;
    the caller of the failed attempt still sees the error). */
export function pg(): Promise<Pg> {
  pgPromise ??= boot().catch((err: unknown) => {
    pgPromise = null;
    throw err;
  });
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
  for (const table of [
    "knowledge",
    "knowledge_vec",
    "run_event",
    "thread_head",
    "run_summary",
    "stats",
    "attachment",
    "memory",
    "store_meta",
  ]) {
    await db.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  await createSchema(db, pgDimensions, pgEmbedModel);
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
  // rather than wedging the whole store.  A FAILED script (404, CSP) fires
  // the Worker's error event immediately -- fall back on it too, never the
  // full 10s timeout (the store's first use would stall every page).
  let failed: ((reason: Error) => void) | null = null;
  const created = PGliteWorker.create(worker, {
    dataDir: "idb://zjs-ai",
    extensions: { live },
  });
  created.catch(() => {}); // the race's loser must not escalate to unhandled
  const raced = await Promise.race([
    created,
    new Promise<never>((_, reject) => {
      failed = reject;
      worker.addEventListener("error", () => failed?.(new Error("the worker script failed to load")), {
        once: true,
      });
    }),
    new Promise((resolve) => setTimeout(() => resolve("WORKER_TIMEOUT"), 10_000)),
  ]).finally(() => {
    failed = null;
  });
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

const BOOT_BUDGET_MS = 25_000;
/** The REAL boot's total ceiling -- the worker lane's own 10s race plus
    the main lane and the schema DDL share this budget.  THE PRINT-JAM
    LESSON (2026-10-14): a dead tab's worker holds the pglite election
    Web Lock forever, and an election-wait is UNBOUNDED -- without this
    ceiling every other tab's store wedged for the life of the page. */

async function bootMemory(): Promise<Pg> {
  // the DEGRADED lane: no dataDir -- an in-memory engine.  Writes land,
  // reads serve, nothing survives the page.  Loud on purpose: a session
  // that looks normal but forgets everything is worse than an error.
  console.warn(
    "zjsearch pg: the real store is unwedgeable -- degrading to the IN-MEMORY store" +
      " (data will not persist; close this origin's other tabs and reload to retry)",
  );
  const [{ PGlite }, { vector }, { pg_textsearch }, { live }, { pg_trgm }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite-pgvector"),
    import("@electric-sql/pglite-pg_textsearch"),
    import("@electric-sql/pglite/live"),
    import("@electric-sql/pglite/contrib/pg_trgm"),
  ]);
  const db = new PGlite({ extensions: { vector, pg_textsearch, live, pg_trgm } });
  await db.query("CREATE EXTENSION IF NOT EXISTS vector");
  await db.query("CREATE EXTENSION IF NOT EXISTS pg_textsearch");
  await db.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  // the degraded store serves the SAME surfaces (the whole app reads the
  // one schema) -- without this its first query answers "no such table"
  await createSchema(db, pgDimensions, pgEmbedModel);
  return db;
}

async function boot(): Promise<Pg> {
  const real = bootReal();
  real.catch(() => {}); // the race's loser must not escalate to unhandled (the bootWorker pattern)
  let budgetFail: ((err: Error) => void) | null = null;
  const budget = new Promise<never>((_, reject) => {
    budgetFail = reject;
  });
  const timer = setTimeout(
    () => budgetFail?.(new Error(`the store boot exceeded its ${BOOT_BUDGET_MS / 1000}s budget`)),
    BOOT_BUDGET_MS,
  );
  try {
    const db = await Promise.race([real, budget]);
    pgDegradedMemory = false;
    return db;
  } catch {
    pgDegradedMemory = true;
    const db = await bootMemory();
    return db;
  } finally {
    clearTimeout(timer);
  }
}

async function bootReal(): Promise<Pg> {
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
  await createSchema(db, pgDimensions, pgEmbedModel);
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
