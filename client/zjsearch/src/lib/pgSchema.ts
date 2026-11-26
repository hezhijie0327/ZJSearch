// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**

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

/** The store's schema: the one createSchema pass (DDL, the v4->v5
    wholesale rebuild, the carried-data decisions) plus the embedding
    identity reconcile.  Dimensions and the embed model arrive as
    parameters -- the boot side owns the configured values, the schema
    only shapes the columns. */

export type Pg = import("@electric-sql/pglite").PGlite;

export async function createSchema(db: Pg, dims: number, embedModel: string): Promise<void> {
  const hadV5 = await db.query<{ present: boolean }>("SELECT to_regclass('run_summary') IS NOT NULL AS present");
  const carried = !(hadV5.rows ?? [])[0]?.present;
  if (carried) {
    // a v4 database (or a fresh one -- the drops no-op): v4 dies wholesale.
    // LOUD on purpose: a store that silently empties reads as a data-loss
    // bug -- the console line is the only witness the user ever gets.
    console.warn(
      "zjsearch pg: pre-v5 store detected (no run_summary marker) -- dropping" +
        " knowledge/run_event/thread_head WHOLESALE and rebuilding the schema." +
        " This is the schema-bump policy (the v2 precedent), not a crash.",
    );
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
  // v5.1: the thread directory carries its report count (the Reports badge +
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
  // THE MEMORY TABLE (the tripartite refactor): durable user facts
  // (kind='fact') and learned procedures (kind='procedure') leave the
  // knowledge table -- they never were knowledge-row material (no url, no
  // thread, no tags graph) and their own shape (strength/last_seen/state)
  // kept bending the shared columns.  The near-dup gate's client copy
  // rides the SAME embedding column the recall uses.
  await db.query(`CREATE TABLE IF NOT EXISTS memory (
    id          text PRIMARY KEY,
    kind        text NOT NULL DEFAULT 'fact',
    body        text NOT NULL,
    origin      text NOT NULL DEFAULT 'model',
    state       text NOT NULL DEFAULT 'active',
    strength    integer NOT NULL DEFAULT 1,
    last_seen   double precision NOT NULL,
    pinned      integer NOT NULL DEFAULT 0,
    search_text text NOT NULL DEFAULT '',
    embedding   vector(${dims}),
    embed_model text,
    created     double precision NOT NULL,
    updated     double precision NOT NULL
  )`);
  // v2: the SITE recipes are procedures bound to one website's host --
  // the browse lane answers to them by host match, not query relevance
  await db.query("ALTER TABLE memory ADD COLUMN IF NOT EXISTS host text");
  await db.query(
    "CREATE INDEX IF NOT EXISTS memory_bm25 ON memory USING bm25 (search_text) WITH (text_config = 'english')",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS memory_hnsw ON memory USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL",
  );
  await db.query("CREATE INDEX IF NOT EXISTS memory_listing ON memory (pinned DESC, last_seen DESC, strength DESC)");
  await db.query("CREATE INDEX IF NOT EXISTS memory_pending ON memory (state) WHERE state <> 'active'");
  // the one-time courtesy import: the old kind='memory' knowledge rows
  // become active facts, then leave the knowledge table (the stats ledger
  // follows through its own trigger).  Naturally idempotent -- the second
  // boot finds no rows either way.
  await db.query(`INSERT INTO memory (id, kind, body, origin, state, strength, last_seen, pinned, search_text, embedding, embed_model, created, updated)
    SELECT id, 'fact', body, 'model', 'active', 1, updated, pinned, search_text, embedding, embed_model, created, updated
    FROM knowledge WHERE kind = 'memory' ON CONFLICT (id) DO NOTHING`);
  await db.query("DELETE FROM knowledge WHERE kind = 'memory'");
  await db.query(
    "CREATE INDEX IF NOT EXISTS knowledge_bm25 ON knowledge USING bm25 (search_text) WITH (text_config = 'english')",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS knowledge_hnsw ON knowledge USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL",
  );
  // THE SEGMENT VECTORS (the long-read recall): the two full-text kinds
  // (source = the reader's archived pages, document = the uploaded
  // attachments) embed as ~1200-char line-boundary SEGMENTS instead of a
  // single 4000-char head -- content past the head becomes findable by
  // the semantic leg.  One row per (row_id, seg_ix); the row's own
  // knowledge.embedding column stays NULL for segmented rows (their
  // embed_model marks them done so the pending queue moves on).
  await db.query(`CREATE TABLE IF NOT EXISTS knowledge_vec (
    row_id      text NOT NULL,
    seg_ix      integer NOT NULL,
    embedding   vector(${dims}),
    embed_model text NOT NULL,
    PRIMARY KEY (row_id, seg_ix)
  )`);
  await db.query(
    "CREATE INDEX IF NOT EXISTS knowledge_vec_hnsw ON knowledge_vec USING hnsw (embedding vector_cosine_ops)",
  );
  // the tiny kv the schema-level passes key on (the embedding identity
  // reconcile, the segment-migration marker) -- infrastructure, not
  // knowledge: the reset drops it and the fresh boot re-seeds it.
  await db.query("CREATE TABLE IF NOT EXISTS store_meta (key text PRIMARY KEY, value text NOT NULL)");
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
  await reconcileEmbeddingIdentity(db, dims, embedModel);
}

/** THE EMBEDDING IDENTITY RECONCILE (boot, every lane): the vector space
    is identified by the capability PAIR (model, dimensions) -- a change
    in either invalidates EVERY stored vector (old-model vectors sit in a
    different space; an old-width column rejects the new vectors outright
    and would throw the whole semantic leg).  The pass compares the
    boot capability against the stored markers and, on any change, wipes
    every embedding back to the pending queue (the backfill pass
    re-embeds) and re-widths the columns.  Without it a model swap
    polluted the recall SILENTLY -- cross-space cosine rankings read as
    plausible garbage.  One-time markers double as migration triggers:
    ``doc_segments`` folds the pre-segmentation databases in (their
    full-text rows re-embed as segments).  Capability absent = nothing
    compares vectors this session: the pass stands down and the stored
    identity survives. */
async function reconcileEmbeddingIdentity(db: Pg, dims: number, embedModel: string): Promise<void> {
  const model = embedModel.trim();
  if (!model) {
    return;
  }
  const stored = new Map(
    (
      (
        await db.query<{ key: string; value: string }>(
          "SELECT key, value FROM store_meta WHERE key = ANY($1::text[])",
          [["embed_dims", "embed_model", "doc_segments"]],
        )
      ).rows ?? []
    ).map((row) => [String(row.key), String(row.value)] as [string, string]),
  );
  const storedDims = stored.get("embed_dims");
  const storedModel = stored.get("embed_model");
  const identityChanged =
    (storedDims !== undefined && storedDims !== String(dims)) || (storedModel !== undefined && storedModel !== model);
  const needsSegmentMigration = stored.get("doc_segments") !== "1";
  if (!identityChanged && !needsSegmentMigration) {
    return;
  }
  const changed: string[] = [];
  if (identityChanged) {
    changed.push(`${storedModel ?? "?"}/${storedDims ?? "?"} -> ${model}/${dims}`);
    try {
      await db.query(
        "UPDATE knowledge SET embedding = NULL, embed_model = NULL WHERE embedding IS NOT NULL OR embed_model IS NOT NULL",
      );
      await db.query("DELETE FROM knowledge_vec");
      await db.query(
        "UPDATE memory SET embedding = NULL, embed_model = NULL WHERE embedding IS NOT NULL OR embed_model IS NOT NULL",
      );
    } catch (err) {
      console.warn("zjsearch pg: the embedding reset failed (vectors may be stale)", err);
    }
    if (storedDims !== undefined && storedDims !== String(dims)) {
      for (const table of ["knowledge", "knowledge_vec", "memory"]) {
        try {
          await db.query(`ALTER TABLE ${table} ALTER COLUMN embedding TYPE vector(${dims})`);
        } catch (err) {
          console.warn(`zjsearch pg: the ${table} vector column re-width failed (retried next boot)`, err);
        }
      }
    }
  }
  if (needsSegmentMigration) {
    // the pre-segmentation databases: their long-read rows were
    // head-embedded -- back to the pending queue, the backfill segments
    // them (documents and crawled sources alike)
    try {
      await db.query(
        "UPDATE knowledge SET embedding = NULL, embed_model = NULL WHERE kind IN ('source', 'document') AND embed_model IS NOT NULL",
      );
    } catch (err) {
      console.warn("zjsearch pg: the segment migration reset failed (retried next boot)", err);
    }
  }
  for (const [key, value] of [
    ["embed_dims", String(dims)],
    ["embed_model", model],
    ["doc_segments", "1"],
  ] as const) {
    await db.query(
      "INSERT INTO store_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, value],
    );
  }
  console.info(`zjsearch pg: embedding space reconciled (${changed.join("; ") || "segment migration"})`);
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
