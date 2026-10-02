// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store (知识库): the browser's local research memory --
    the server owns nothing.  Schema v4 (pg.ts): the wire log lives in its
    OWN table (`run_event`, storage-only -- excluded from every retrieval
    index), the queryable surfaces are PROJECTIONS in `knowledge` written
    at settle (run / answer (the AI Overview archive -- run answers replay
    from the event log) / source / source_ref / document / memory / call /
    task / clarify), and the thread directory is the `thread_head`
    projection maintained at settle.  The tag graph is not a table: tags
    are a jsonb column with a GIN index (membership via `?`/`?|`),
    co-occurrence within a row is an edge, aggregated on demand.

    Write paths (all behind the ordered queue):
    - appendRunEvents -- the live stream buffers events, flushed in
      debounced single-statement batches (crash window <= the debounce);
    - settleRun -- one run settled: ONE TRANSACTION (flush + projections +
      thread head), then the embed pass and the debounced tag
      normalization;
    - archiveDocument / saveMemory -- standalone facts.

    Read paths are SQL + live subscriptions -- there is deliberately NO
    in-memory mirror anymore: every surface (the knowledge page, the
    recall, the admin panel) reads the same table the writes land in.
    Recall fuses TWO dimensions: hybrid lexical+vector RRF, and the tag
    graph (vocabulary match -> shared-tag rows -> one-hop expansion).

    Database failure = the call site degrades (empty list / no-op); there
    is deliberately no fallback storage. */

import { embeddingsConfigured, embedTexts } from "@/lib/embed.ts";
import {
  configurePgDimensions,
  type Pg,
  pg,
  pgQuery,
  pgTransaction,
  type QueryClient,
  segmentKeywords,
  toVectorLiteral,
  urlHash,
} from "@/lib/pg.ts";

export { segmentKeywords, urlHash };

// ------------------------------------------------------------- capability

let aiToken: string | null = null;
let embedModel: string | null = null;

/** The AI Search capability token (tag normalization is an AI route) and
    the embedding model name (recorded on every embedded row).  Called
    wherever the embedding capability is configured (boot + landing). */
export function configureKnowledge(tokens: { aiToken?: string; embedModel?: string }): void {
  if (tokens.aiToken !== undefined) {
    aiToken = tokens.aiToken;
  }
  if (tokens.embedModel !== undefined) {
    embedModel = tokens.embedModel;
  }
}

// ------------------------------------------------------------------- rows

/** The thread's shareable address (browser-local: another device or
    browser gets the empty state, never someone else's conversation). */
export function threadUrl(id: string): string {
  return `/zjsearch/ai/thread/${id}`;
}

export type KnowledgeKind =
  | "run"
  | "answer"
  | "source"
  | "source_ref"
  | "document"
  | "memory"
  | "call"
  | "task"
  | "clarify";

const SEARCHABLE_KINDS = ["answer", "source", "document", "memory", "call", "task", "clarify", "run"];

/** One knowledge row as the UI consumes it (evt rows never surface). */
export interface KnowledgeItem {
  id: string;
  kind: KnowledgeKind;
  threadId: string | null;
  runId: string | null;
  url: string | null;
  urlHash: string | null;
  host: string | null;
  title: string;
  body: string;
  tags: string[];
  status: string;
  n: number | null;
  pinned: boolean;
  refs: number;
  cited: number;
  updated: number;
  /** the row's raw meta (PGlite hands jsonb back already-parsed) */
  meta: Record<string, unknown>;
}

function rowToItem(row: Record<string, unknown>): KnowledgeItem {
  let tags: string[] = [];
  try {
    const parsed = typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags;
    if (Array.isArray(parsed)) {
      tags = parsed.map(String);
    }
  } catch {
    /* malformed jsonb stays empty */
  }
  return {
    meta: (row.meta ?? {}) as Record<string, unknown>,
    id: String(row.id),
    kind: String(row.kind) as KnowledgeKind,
    threadId: row.thread_id ? String(row.thread_id) : null,
    runId: row.run_id ? String(row.run_id) : null,
    url: row.url ? String(row.url) : null,
    urlHash: row.url_hash ? String(row.url_hash) : null,
    host: row.host ? String(row.host) : null,
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    tags,
    status: String(row.status ?? "done"),
    n: row.n === null || row.n === undefined ? null : Number(row.n),
    pinned: Number(row.pinned) === 1,
    refs: Number(row.refs) || 0,
    cited: Number(row.cited) || 0,
    updated: Number(row.updated) || 0,
  };
}

const ITEM_COLUMNS =
  "id, kind, thread_id, run_id, url, url_hash, host, title, body, tags, meta, status, n, pinned, refs, cited, updated";

// ------------------------------------------------------------ ordered queue

let queue: Promise<void> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  // the queue is the store's write path: a failed task must surface in
  // the console (the fire-and-forget callers would otherwise swallow it
  // and the data loss would read as "the feature is broken")
  queue = run.then(
    () => undefined,
    (err: unknown) => {
      console.warn("zjsearch knowledge store: write failed", err);
    },
  );
  return run;
}

// ------------------------------------------------------- run event stream

/** Per-run wire-sequence counters and the unflushed event buffer. */
const seqCounters = new Map<string, number>();
const evtBuffers = new Map<string, Array<{ n: number; event: unknown; at: number }>>();
let evtFlushTimer: number | null = null;

function threadIdOf(runId: string): string {
  const cut = runId.lastIndexOf(":");
  return cut > 0 ? runId.slice(0, cut) : runId;
}

/** Buffer one wire event (or client event) of a live run.  The store owns
    the sequence: callers hand the event in arrival order, the store
    numbers it.  Flushes in debounced batches -- a crashed tab loses at
    most one batch. */
export function appendRunEvents(runId: string, events: unknown[]): void {
  if (events.length === 0) {
    return;
  }
  let seq = seqCounters.get(runId) ?? 0;
  const buffer = evtBuffers.get(runId) ?? [];
  for (const event of events) {
    seq += 1;
    buffer.push({ n: seq, event, at: Date.now() });
  }
  seqCounters.set(runId, seq);
  evtBuffers.set(runId, buffer);
  if (evtFlushTimer === null) {
    evtFlushTimer = window.setTimeout(() => {
      evtFlushTimer = null;
      void flushRunEvents();
    }, 1500);
  }
}

/** The raw flush body -- MUST run inside a queue task (settleRun calls
    it directly; awaiting the enqueuing wrapper from within a task would
    deadlock the queue on itself).  ONE multi-row INSERT statement per
    batch: atomic (a crashed tab either has the batch or not), and the
    live subscription never sees a half batch. */
async function flushRunEventsBody(runId: string | undefined, client?: QueryClient): Promise<void> {
  const batches = runId ? [runId] : [...evtBuffers.keys()];
  for (const id of batches) {
    const buffer = evtBuffers.get(id);
    if (!buffer || buffer.length === 0) {
      continue;
    }
    evtBuffers.delete(id);
    const threadId = threadIdOf(id);
    const values: unknown[] = [];
    const rows = buffer.map((entry, index) => {
      values.push(id, entry.n, threadId, entry.at, JSON.stringify(entry.event));
      const base = index * 5;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb)`;
    });
    await pgQuery(
      `INSERT INTO run_event (run_id, n, thread_id, occurred_at, data)
       VALUES ${rows.join(",")} ON CONFLICT DO NOTHING`,
      values,
      client,
    );
  }
}

function flushRunEvents(runId?: string): Promise<void> {
  return enqueue(() => flushRunEventsBody(runId));
}

// ---------------------------------------------------------- run projection

/** The structural shape the store reads off a settled run.  The feature
    owns the typed shape (AiSearchRun satisfies it); the store never
    imports the feature. */
export interface RunSnapshot {
  runNo: number;
  q: string;
  status: string;
  mode?: string;
  error?: string | null;
  answer?: string;
  startedAt?: number;
  endedAt?: number | null;
  stopped?: boolean;
  finish?: string | null;
  model?: string | null;
  usage?: unknown;
  halted?: unknown;
  sources?: Array<{
    n?: number;
    url?: string;
    title?: string;
    netloc?: string;
    host?: string;
    favicon?: string;
    img?: string;
    category?: string;
    /** the SearXNG result snippet -- an uncrawled source's searchable body */
    content?: string;
  }>;
  tasks?: Array<{ title?: string; status?: string }>;
  /** the user's answered clarify text ("" = skipped) */
  clarify?: string | null;
  tags?: string[];
  steps?: Array<{
    kind: string;
    round?: number;
    calls?: Array<{
      id?: number;
      tool?: string;
      q?: string;
      url?: string;
      status?: string;
      chars?: number;
      text?: string;
    }>;
  }>;
}

/** The mechanical tag layer: query tokens + the model's own task titles
    -- zero cost, always present; the normalization pass
    (scheduleTagNormalize) later folds these into concept tags.  Hosts
    and the mode name are deliberately NOT tags: they turned the tag
    graph into a host cloud (shipped and reverted within a day). */
function deriveTags(run: RunSnapshot): string[] {
  const raw = new Set<string>();
  for (const token of segmentKeywords(run.q).split(" ")) {
    if (token.length >= 2) {
      raw.add(token);
    }
  }
  for (const task of run.tasks ?? []) {
    const title = String(task.title ?? "").trim();
    if (title && title.length <= 30) {
      raw.add(title);
    }
  }
  return [...raw].slice(0, 12);
}

/** The classic page's AI Overview archives itself here at settle: the
    答案 kind IS this store (run answers replay from the evt log instead --
    they duplicated the thread's 研究 row).  The id is the query's hash, so
    re-asking the same query refreshes the row.  The sources the overview
    actually cites join the 来源 corpus: one source_ref per (query,
    source) + the canonical source row ref/cited-counted, exactly the
    settleRun identity pattern -- a regenerate re-runs the upserts but the
    DO NOTHING guards keep the counters honest. */
export interface OverviewUsage {
  model?: string | null;
  finish?: string | null;
  input?: number | null;
  output?: number | null;
  thoughts?: number | null;
  cached?: number | null;
  cache_write?: number | null;
  rerank?: { calls: number; tokens: number };
}

export function saveOverview(input: {
  query: string;
  markdown: string;
  model?: string | null;
  usage?: OverviewUsage | null;
  sources?: Array<{ n: number; url: string; title: string; favicon?: string; domain?: string }>;
}): void {
  const now = Date.now();
  // the streaming client synthesizes a trailing meta sentinel into its raw
  // text; saveOverview receives the already-stripped markdown, but strip
  // again here -- a truncated sentinel tail would render as garbage
  const markdown = (input.markdown.split("<<<zjs-meta:")[0] ?? "").trim();
  const raw = new Set<string>();
  for (const token of segmentKeywords(input.query).split(" ")) {
    if (token.length >= 2) {
      raw.add(token);
    }
  }
  const tags = [...raw].slice(0, 12);
  void enqueue(async () => {
    await pgQuery(
      `INSERT INTO knowledge (id, kind, title, body, status, meta, tags, search_text, created, updated, occurred_at)
       VALUES ($1, 'answer', $2, $3, 'done', $4::jsonb, $5::jsonb, $6, $7, $8, $8)
       ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, meta = EXCLUDED.meta,
         tags = EXCLUDED.tags, search_text = EXCLUDED.search_text, updated = EXCLUDED.updated`,
      [
        `ovw:${urlHash(input.query)}`,
        input.query.slice(0, 300),
        markdown.slice(0, 60000),
        JSON.stringify({
          mode: "overview",
          model: input.model ?? null,
          usage: input.usage ?? null,
          sources: input.sources ?? [],
        }),
        JSON.stringify(tags),
        segmentKeywords(input.query, input.markdown).slice(0, 8000),
        now,
        now,
      ],
    );
    const cited = citedNumbers(input.markdown);
    const queryHash = urlHash(input.query);
    for (const source of input.sources ?? []) {
      if (!source.url || !cited.has(source.n)) {
        continue;
      }
      const hash = urlHash(source.url);
      const inserted = await pgQuery<{ url_hash: string }>(
        `INSERT INTO knowledge (id, kind, url_hash, url, host, title, n, meta, status, search_text, created, updated, occurred_at)
         VALUES ($1, 'source_ref', $2, $3, $4, $5, $6, $7::jsonb, 'done', $8, $9, $9, $9)
         ON CONFLICT (id) DO NOTHING RETURNING url_hash`,
        [
          `ref:ovw:${queryHash}:${hash}`,
          hash,
          String(source.url),
          String(source.domain ?? ""),
          String(source.title ?? "").slice(0, 300),
          source.n,
          JSON.stringify({ favicon: source.favicon ?? null, overview: true }),
          segmentKeywords(String(source.title ?? ""), String(source.domain ?? "")).slice(0, 4000),
          now,
        ],
      );
      if ((inserted ?? []).length === 0) {
        continue; // this query already counted this source
      }
      const meta = source.favicon ? { favicon: source.favicon } : {};
      await pgQuery(
        `INSERT INTO knowledge (id, kind, url_hash, url, host, title, body, meta, refs, cited, tags, search_text, created, updated, occurred_at)
         VALUES ($1, 'source', $2, $3, $4, $5, '', $6::jsonb, 1, 1, '{}'::jsonb, $7, $8, $8, $8)
         ON CONFLICT (id) DO UPDATE SET refs = knowledge.refs + 1, cited = knowledge.cited + 1,
           title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE knowledge.title END,
           meta = CASE WHEN EXCLUDED.meta <> '{}'::jsonb THEN EXCLUDED.meta ELSE knowledge.meta END,
           updated = EXCLUDED.updated`,
        [
          `src:${hash}`,
          hash,
          String(source.url),
          String(source.domain ?? ""),
          String(source.title ?? "").slice(0, 300),
          JSON.stringify(meta),
          segmentKeywords(String(source.title ?? ""), String(source.domain ?? "")).slice(0, 4000),
          now,
        ],
      );
    }
    void embedPending();
  }).catch(() => {});
}

/** Run-start persistence: the run's head row lands (status "streaming")
    and the thread joins the directory THE MOMENT research begins -- a
    crashed tab or a dead network leaves a resumable event log behind a
    visible run row (the continue path's storage).  settleRun later
    UPDATES the same row and recomputes the thread-head counters from the
    projections, so the early write can never double-count. */
export function startRun(threadId: string, run: { runNo: number; q: string; mode?: string; startedAt?: number }): void {
  const runId = `${threadId}:${run.runNo}`;
  void enqueue(async () => {
    await pgTransaction(async (tx) => {
      const now = Date.now();
      await pgQuery(
        `INSERT INTO knowledge (id, kind, thread_id, run_id, n, title, status, meta, tags, search_text, created, updated, occurred_at)
         VALUES ($1, 'run', $2, $3, $4, $5, 'streaming', $6::jsonb, '[]'::jsonb, $7, $8, $8, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          `run:${runId}`,
          threadId,
          runId,
          run.runNo,
          run.q.slice(0, 300),
          JSON.stringify({ mode: run.mode ?? "", sources: 0, answer: "" }),
          segmentKeywords(run.q),
          Number(run.startedAt ?? now) || now,
        ],
        tx,
      );
      await pgQuery(
        `INSERT INTO thread_head (thread_id, title, preview, runs, sources, updated, pinned)
         VALUES ($1, $2, '',
           (SELECT count(*) FROM knowledge kr WHERE kr.thread_id = $1 AND kr.kind = 'run'),
           (SELECT count(*) FROM knowledge ks WHERE ks.thread_id = $1 AND ks.kind = 'source_ref'),
           $3, 0)
         ON CONFLICT (thread_id) DO UPDATE SET runs = EXCLUDED.runs, sources = EXCLUDED.sources,
           updated = EXCLUDED.updated`,
        [threadId, run.q.slice(0, 300), now],
        tx,
      );
    });
  });
}

/** One settled run: flush its events, then write every projection -- ONE
    transaction, so a crashed settle never leaves half a run (the flush
    batch and the projections commit together).  The hook's settle
    checkpoint calls this (fire-and-forget); a re-settle of the same runId
    is idempotent (projection ids are deterministic, the source counters
    only move on first-insert of each ref row, and the thread-head
    counters RECOMPUTE from the projections). */
export function settleRun(threadId: string, run: RunSnapshot): void {
  const runId = `${threadId}:${run.runNo}`;
  void enqueue(async () => {
    await pgTransaction(async (tx) => {
      await flushRunEventsBody(runId, tx);
      const now = Date.now();
      const citedSet = citedNumbers(String(run.answer ?? ""));
      // the extractor's concept tags win; the mechanical layer is the fallback
      const tags = run.tags?.length ? run.tags : deriveTags(run);
      // the run's head row (startRun may have pre-inserted it as
      // "streaming" -- this upsert settles it)
      await pgQuery(
        `INSERT INTO knowledge (id, kind, thread_id, run_id, n, title, status, meta, tags, search_text, created, updated, occurred_at)
         VALUES ($1, 'run', $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $11)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, status = EXCLUDED.status,
           meta = EXCLUDED.meta, tags = EXCLUDED.tags, search_text = EXCLUDED.search_text, updated = EXCLUDED.updated`,
        [
          `run:${runId}`,
          threadId,
          runId,
          run.runNo,
          run.q.slice(0, 300),
          run.status || "done",
          JSON.stringify({
            mode: run.mode ?? "",
            model: run.model ?? null,
            finish: run.finish ?? null,
            usage: run.usage ?? null,
            halted: run.halted ?? null,
            stopped: run.stopped ?? false,
            sources: (run.sources ?? []).length,
            answer: String(run.answer ?? "").slice(0, 600),
          }),
          JSON.stringify(tags),
          segmentKeywords(run.q),
          Number(run.startedAt ?? now) || now,
          now,
        ],
        tx,
      );
      // the thread head (the directory's whole listing -- no aggregate):
      // the counters RECOMPUTE from the projections (indexed, cheap,
      // idempotent -- a re-settle or a startRun-pre-inserted row can
      // never double-count); the title stays the FIRST run's question
      await pgQuery(
        `INSERT INTO thread_head (thread_id, title, preview, runs, sources, updated, pinned)
         VALUES ($1, $2, $3,
           (SELECT count(*) FROM knowledge kr WHERE kr.thread_id = $1 AND kr.kind = 'run'),
           (SELECT count(*) FROM knowledge ks WHERE ks.thread_id = $1 AND ks.kind = 'source_ref'),
           $4, 0)
         ON CONFLICT (thread_id) DO UPDATE SET preview = EXCLUDED.preview,
           runs = EXCLUDED.runs, sources = EXCLUDED.sources, updated = EXCLUDED.updated`,
        [threadId, run.q.slice(0, 300), String(run.answer ?? "").slice(0, 400), now],
        tx,
      );
      // the task card + the clarify archive
      if ((run.tasks ?? []).length > 0) {
        await pgQuery(
          `INSERT INTO knowledge (id, kind, thread_id, run_id, title, meta, status, search_text, created, updated, occurred_at)
           VALUES ($1, 'task', $2, $3, $4, $5::jsonb, $6, $7, $8, $8, $8)
           ON CONFLICT (id) DO UPDATE SET meta = EXCLUDED.meta, status = EXCLUDED.status, updated = EXCLUDED.updated`,
          [
            `task:${runId}`,
            threadId,
            runId,
            run.q.slice(0, 300),
            JSON.stringify({ items: run.tasks ?? [] }),
            "done",
            segmentKeywords(run.q, ...(run.tasks ?? []).map((task) => String(task.title ?? ""))).slice(0, 4000),
            now,
          ],
          tx,
        );
      }
      if (run.clarify !== undefined && run.clarify !== null && run.clarify !== "") {
        await pgQuery(
          `INSERT INTO knowledge (id, kind, thread_id, run_id, body, meta, search_text, created, updated, occurred_at)
           VALUES ($1, 'clarify', $2, $3, $4, '{}'::jsonb, $5, $6, $6, $6)
           ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, updated = EXCLUDED.updated`,
          [
            `cla:${runId}`,
            threadId,
            runId,
            run.clarify.slice(0, 4000),
            segmentKeywords(run.clarify).slice(0, 4000),
            now,
          ],
          tx,
        );
      }
      // the sources: one canonical identity row + one ref row per (run, source)
      for (const source of run.sources ?? []) {
        if (!source.url) {
          continue;
        }
        const hash = urlHash(String(source.url));
        const host = String(source.netloc ?? source.host ?? "");
        const title = String(source.title ?? "");
        const n = Number(source.n ?? 0) || 0;
        const cited = citedSet.has(n);
        const inserted = await pgQuery<{ url_hash: string; meta: string }>(
          `INSERT INTO knowledge (id, kind, thread_id, run_id, url_hash, url, host, title, n, meta, status, search_text, created, updated, occurred_at)
           VALUES ($1, 'source_ref', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $12, $12)
           ON CONFLICT (id) DO NOTHING RETURNING url_hash, meta`,
          [
            `ref:${runId}:${hash}`,
            threadId,
            runId,
            hash,
            String(source.url),
            host,
            title.slice(0, 300),
            n,
            JSON.stringify({ cited, favicon: source.favicon ?? null }),
            "done",
            segmentKeywords(title, host).slice(0, 4000),
            now,
          ],
          tx,
        );
        if ((inserted ?? []).length === 0) {
          continue; // this run already counted this source
        }
        const snippet = String(source.content ?? "").slice(0, 500);
        const sourceTags = JSON.stringify([]);
        await pgQuery(
          `INSERT INTO knowledge (id, kind, url_hash, url, host, title, body, meta, refs, cited, tags, search_text, created, updated, occurred_at)
           VALUES ($1, 'source', $2, $3, $4, $5, $6, '{}'::jsonb, 1, $7, $8::jsonb, $9, $10, $10, $10)
           ON CONFLICT (id) DO UPDATE SET refs = knowledge.refs + 1, cited = knowledge.cited + $7,
             title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE knowledge.title END,
             body = CASE WHEN EXCLUDED.body <> '' THEN EXCLUDED.body ELSE knowledge.body END,
             meta = CASE WHEN EXCLUDED.meta <> '{}'::jsonb THEN EXCLUDED.meta ELSE knowledge.meta END,
             updated = EXCLUDED.updated`,
          [
            `src:${hash}`,
            hash,
            String(source.url),
            host,
            title.slice(0, 300),
            snippet,
            cited ? 1 : 0,
            sourceTags,
            segmentKeywords(title, host, snippet).slice(0, 4000),
            now,
          ],
          tx,
        );
      }
      // the retrieval-worthy tool calls (web_search queries, reader reads)
      for (const step of run.steps ?? []) {
        if (step.kind !== "calls") {
          continue;
        }
        for (const call of step.calls ?? []) {
          const tool = String(call.tool ?? "");
          if (!["web_search", "web_reader", "calculator"].includes(tool)) {
            continue;
          }
          const callId = String(call.id ?? "");
          if (!callId) {
            continue;
          }
          const query = String(call.q ?? "");
          const head = String(call.text ?? "").slice(0, 1500);
          await pgQuery(
            `INSERT INTO knowledge (id, kind, thread_id, run_id, n, url_hash, url, title, body, meta, status, search_text, created, updated, occurred_at)
             VALUES ($1, 'call', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $12, $12)
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, body = EXCLUDED.body, updated = EXCLUDED.updated`,
            [
              `call:${runId}:${callId}`,
              threadId,
              runId,
              step.round ?? null,
              call.url ? urlHash(call.url) : null,
              call.url ? String(call.url) : null,
              (query || String(call.url ?? "")).slice(0, 300),
              tool === "web_reader" ? head : String(call.text ?? "").slice(0, 2000),
              JSON.stringify({ tool, name: callId, chars: Number(call.chars ?? 0) || null }),
              String(call.status ?? "ok"),
              segmentKeywords(query || call.url || "").slice(0, 2000),
              now,
            ],
            tx,
          );
        }
      }
    });
    void embedPending();
    scheduleTagNormalize();
  });
}

/** The cited [n] set of an answer -- the (run, source, cited) fact's
    single bookkeeping point (moved from the old store's sync). */
function citedNumbers(answer: string): Set<number> {
  const cited = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+(?:\s*[,，]\s*\d+)*)\]/g)) {
    const group = match[1];
    if (!group) {
      continue;
    }
    for (const part of group.split(/\s*[,，]\s*/)) {
      cited.add(Number(part));
    }
  }
  return cited;
}

/** Archive ONE web_reader page's full text as a document row
    (fire-and-forget; the reading pane already showed the text). */
export function archiveDocument(url: string, title: string, markdown: string): void {
  if (!url || !markdown) {
    return;
  }
  void enqueue(async () => {
    const now = Date.now();
    const hash = urlHash(url);
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* non-url strings keep the empty host */
    }
    await pgQuery(
      `INSERT INTO knowledge (id, kind, url_hash, url, host, title, body, meta, status, tags, search_text, created, updated, occurred_at)
       VALUES ($1, 'document', $2, $3, $4, $5, $6, $7::jsonb, 'done', $8::jsonb, $9, $10, $10, $10)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body,
         meta = EXCLUDED.meta, search_text = EXCLUDED.search_text, updated = EXCLUDED.updated`,
      [
        `doc:${hash}`,
        hash,
        url,
        host,
        title.slice(0, 300),
        markdown.slice(0, 60000),
        JSON.stringify({ chars: markdown.length, fetchedAt: now }),
        JSON.stringify([host].filter(Boolean)),
        segmentKeywords(title, markdown.slice(0, 8000)).slice(0, 8000),
        now,
      ],
    );
    void embedPending();
  });
}

// ---------------------------------------------------------------- memories

export interface MemoryRow {
  id: string;
  content: string;
  updated: number;
}

function newMemoryId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Rewrite one durable fact's text (the memory card's edit icon).  The
    live subscription re-fires and the card re-renders. */
export function updateMemory(id: string, content: string): void {
  const text = content.trim().slice(0, 300);
  if (!text) {
    return;
  }
  void enqueue(async () => {
    await pgQuery("UPDATE knowledge SET body = $1, search_text = $2, updated = $3 WHERE id = $4 AND kind = 'memory'", [
      text,
      segmentKeywords(text).slice(0, 2000),
      Date.now(),
      id,
    ]);
  });
}

/** Persist one durable fact (the wire `memory` event lands here).  An
    EXACT duplicate content is a no-op.  Fire-and-forget. */
export function saveMemory(content: string): void {
  const text = content.trim().slice(0, 300);
  if (!text) {
    return;
  }
  void enqueue(async () => {
    const now = Date.now();
    await pgQuery(
      `INSERT INTO knowledge (id, kind, body, status, tags, search_text, created, updated, occurred_at)
       SELECT $1, 'memory', $2, 'done', '[]'::jsonb, $3, $4, $4, $4
       WHERE NOT EXISTS (SELECT 1 FROM knowledge WHERE kind = 'memory' AND body = $2)`,
      [`mem:${newMemoryId()}`, text, segmentKeywords(text).slice(0, 300), now],
    );
    void embedPending();
  });
}

export async function loadMemories(): Promise<MemoryRow[]> {
  const rows = await pgQuery<{ id: string; body: string; updated: number }>(
    "SELECT id, body, updated FROM knowledge WHERE kind = 'memory' ORDER BY created",
  );
  return (rows ?? []).map((row) => ({ id: row.id, content: row.body, updated: Number(row.updated) || 0 }));
}

export function forgetMemory(id: string): void {
  void enqueue(async () => {
    await pgQuery("DELETE FROM knowledge WHERE id = $1 AND kind = 'memory'", [id]);
  });
}

// -------------------------------------------------------------- embed pass

let embedRunning = false;

/** Embed the rows whose search_text is non-empty but whose embedding is
    still missing (projections land unembedded when the capability is
    off; they join the semantic search the next time this pass runs with
    the capability on).  One /zjsearch/ai/embed call per 16 texts. */
async function embedPending(): Promise<void> {
  if (embedRunning || !embeddingsConfigured()) {
    return;
  }
  embedRunning = true;
  try {
    const rows = await pgQuery<{ id: string; search_text: string }>(
      `SELECT id, search_text FROM knowledge
       WHERE embed_model IS NULL AND search_text <> '' AND kind <> 'source_ref' LIMIT 16`,
    );
    for (let i = 0; i < (rows ?? []).length; i += 16) {
      const batch = (rows ?? []).slice(i, i + 16);
      const vectors = await embedTexts(batch.map((row) => row.search_text.slice(0, 4000)));
      if (!vectors) {
        return; // capability gone mid-pass: rows stay pending
      }
      for (let j = 0; j < batch.length; j++) {
        const vector = vectors[j];
        const target = batch[j];
        if (!vector || !target) {
          continue;
        }
        await pgQuery(
          "UPDATE knowledge SET embedding = $1::vector, embed_model = $2 WHERE id = $3 AND embed_model IS NULL",
          [toVectorLiteral(vector), embedModel ?? "unknown", target.id],
        );
      }
    }
  } catch {
    /* best-effort: rows stay pending */
  } finally {
    embedRunning = false;
  }
}

// ---------------------------------------------------------- tag normalize

let normalizeTimer: number | null = null;

/** The normalization pass: fold each row's raw tags into concept tags via
    ONE small structured completion per batch (POST /zjsearch/ai/tags).
    Debounced after settles; a row normalizes once (meta.tnormed); a
    failure keeps the raw tags. */
function scheduleTagNormalize(): void {
  if (normalizeTimer !== null) {
    return;
  }
  normalizeTimer = window.setTimeout(() => {
    normalizeTimer = null;
    void normalizeTags();
  }, 4000);
}

async function normalizeTags(): Promise<void> {
  if (!aiToken) {
    return;
  }
  try {
    const rows = await pgQuery<{ id: string; tags: string }>(
      `SELECT id, tags FROM knowledge
       WHERE (meta->>'tnormed') IS DISTINCT FROM '1' AND tags <> '[]'::jsonb AND kind <> 'evt'
       LIMIT 24`,
    );
    const batch = (rows ?? []).filter((row) => {
      const parsed = typeof row.tags === "string" ? safeParse(row.tags) : row.tags;
      return Array.isArray(parsed) && parsed.length > 0;
    });
    if (batch.length === 0) {
      return;
    }
    const response = await fetch("/zjsearch/ai/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tk: aiToken,
        items: batch.map((row) => {
          const parsed = typeof row.tags === "string" ? safeParse(row.tags) : row.tags;
          return { tags: Array.isArray(parsed) ? parsed.map(String) : [] };
        }),
      }),
    });
    if (!response.ok) {
      return;
    }
    const data = (await response.json()) as { items?: Array<{ tags?: string[] }> };
    const items = data.items ?? [];
    for (let i = 0; i < batch.length && i < items.length; i++) {
      const row = batch[i];
      const tags = (items[i]?.tags ?? []).map(String).slice(0, 12);
      if (!row || tags.length === 0) {
        continue;
      }
      await pgQuery(
        `UPDATE knowledge SET tags = $1::jsonb,
           search_text = search_text || ' ' || $2, meta = jsonb_set(meta, '{tnormed}', '1')
         WHERE id = $3`,
        [JSON.stringify(tags), segmentKeywords(...tags).slice(0, 1000), row.id],
      );
    }
  } catch {
    /* best-effort: raw tags stay */
  }
}

// -------------------------------------------------------------- hybrid read

/** Hybrid BM25 + pgvector over the searchable kinds, trigram rescue on
    the zero-signal case.  Returns fused rows ranked by RRF.  The kind
    names are internal constants, so they inline as SQL literals. */
async function hybridRecall(
  query: string,
  kinds: string[],
  limit: number,
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
  const [keywordRows, semanticRows] = await Promise.all([
    keywords
      ? pgQuery<Record<string, unknown>>(
          `SELECT ${ITEM_COLUMNS}, (search_text <@> to_bm25query($1, 'knowledge_bm25')) AS _score
           FROM knowledge
           WHERE kind IN (${kindList}) AND (search_text <@> to_bm25query($1, 'knowledge_bm25')) <> 0
           ORDER BY _score DESC LIMIT $2`,
          [keywords, limit * 2],
        )
      : Promise.resolve([] as Record<string, unknown>[]),
    semanticReady
      ? (async () => {
          const vector = (await embedTexts([trimmed]))?.[0];
          if (!vector) {
            return [] as Record<string, unknown>[];
          }
          return pgQuery<Record<string, unknown>>(
            `SELECT ${ITEM_COLUMNS}, 1 - (embedding <=> $1::vector) AS _score
             FROM knowledge
             WHERE kind IN (${kindList}) AND embedding IS NOT NULL
             ORDER BY embedding <=> $1::vector LIMIT $2`,
            [toVectorLiteral(vector), limit * 2],
          );
        })()
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);
  bump(keywordRows, 1.0);
  bump(semanticRows, 1.0);
  if (scores.size === 0 && trimmed.length >= 2) {
    const rescued = await pgQuery<Record<string, unknown>>(
      `SELECT ${ITEM_COLUMNS}, word_similarity($1, title) AS _score
       FROM knowledge
       WHERE kind IN (${kindList}) AND word_similarity($1, title) >= 0.3
       ORDER BY _score DESC LIMIT $2`,
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
  const rows = await pgQuery<{ tag: string }>(
    `SELECT DISTINCT t AS tag FROM knowledge, jsonb_array_elements_text(CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END) AS t
     ORDER BY tag`,
  );
  const tags = (rows ?? []).map((row) => row.tag);
  vocabularyCache = { tags, at: Date.now() };
  return tags;
}

/** The knowledge-graph recall dimension: match the query against the tag
    vocabulary, pull rows sharing the seed tags (more shared tags first). */
async function graphRecall(query: string, kinds: string[], limit: number): Promise<KnowledgeItem[]> {
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
    `SELECT ${ITEM_COLUMNS}, (
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
  updated: number;
  pinned: boolean;
  /** the latest run's answer head -- the row shows the result, the
      thread page is the detail */
  preview: string;
}

/** The thread directory: the thread_head projection (maintained at
    settle -- the old GROUP BY aggregate re-fired on every evt flush). */
export async function listThreads(limit = 30, offset = 0): Promise<ThreadSummary[]> {
  await pg();
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT thread_id AS id, title, preview, runs, sources, updated, pinned
     FROM thread_head ORDER BY pinned DESC, updated DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return (rows ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ""),
    runs: Number(row.runs) || 0,
    sources: Number(row.sources) || 0,
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

/** The RESEARCH recall: the writer-phase corpus (sources + past answers).
    THE RED LINE: these rows reach the writer phase or the UI only --
    never the researcher's feed (ready-made material kills the search
    incentive).  Fuses the hybrid dimension with the tag-graph dimension. */
export async function recallCorpus(query: string, limit = 6): Promise<KnowledgeItem[]> {
  const [hybrid, graph] = await Promise.all([
    hybridRecall(query, ["source", "answer"], limit),
    graphRecall(query, ["source", "answer"], limit),
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
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** The past_research index: archived full texts ranked by the query
    (the tool's feed then points at web_reader for a live re-read). */
export async function recallPages(
  query: string,
  limit = 4,
): Promise<Array<{ url: string; title: string; chars: number; text: string }>> {
  const [hybrid, graph] = await Promise.all([
    hybridRecall(query, ["document"], limit),
    graphRecall(query, ["document"], limit),
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
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      url: entry.item.url ?? "",
      title: entry.item.title,
      chars: entry.item.body.length,
      text: entry.item.body.slice(0, 1500),
    }));
}

/** One run's full event log (the replay source), ordered by wire seq. */
export async function loadRunEvents(runId: string): Promise<Array<{ n: number; event: unknown; at: number }>> {
  const rows = await pgQuery<{ n: number; data: unknown; occurred_at: number }>(
    "SELECT n, data, occurred_at FROM run_event WHERE run_id = $1 ORDER BY n",
    [runId],
  );
  return (rows ?? []).map(decodeEventRow);
}

/** A whole thread's event log, runs in chronological order (events carry
    their arrival clock; the wire seq orders within a run). */
export async function loadThreadEvents(
  threadId: string,
): Promise<Array<{ runId: string; n: number; event: unknown; at: number }>> {
  const rows = await pgQuery<{ run_id: string; n: number; data: unknown; occurred_at: number }>(
    "SELECT run_id, n, data, occurred_at FROM run_event WHERE thread_id = $1 ORDER BY occurred_at, run_id, n",
    [threadId],
  );
  return (rows ?? []).map((row) => ({ ...decodeEventRow(row), runId: row.run_id }));
}

function decodeEventRow(row: { n: number; data: unknown; occurred_at: number }): {
  n: number;
  event: unknown;
  at: number;
} {
  // PGlite hands jsonb columns back as ALREADY-PARSED objects -- the
  // string path only fires for a legacy/text transport (parsing an
  // object would stringify it into "[object Object]" and lose the event)
  const raw: unknown = typeof row.data === "string" ? safeParse(row.data) : row.data;
  const event: unknown = raw && typeof raw === "object" ? raw : {};
  return { n: Number(row.n) || 0, event, at: Number(row.occurred_at) || 0 };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Every run id of a thread, in run order. */
export async function loadThreadRunIds(threadId: string): Promise<string[]> {
  const rows = await pgQuery<{ run_id: string }>(
    "SELECT run_id FROM knowledge WHERE thread_id = $1 AND kind = 'run' ORDER BY n",
    [threadId],
  );
  return (rows ?? []).map((row) => row.run_id);
}

/** One archived document's full markdown (the inspector's reading pane). */
export async function loadDocument(url: string): Promise<{ title: string; markdown: string; chars: number } | null> {
  const rows = await pgQuery<{ title: string; body: string; n: number }>(
    "SELECT title, body, n FROM knowledge WHERE id = $1 AND kind = 'document'",
    [`doc:${urlHash(url)}`],
  );
  const row = (rows ?? [])[0];
  if (!row) {
    return null;
  }
  return { title: String(row.title ?? ""), markdown: String(row.body ?? ""), chars: Number(row.n ?? 0) || 0 };
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

// ------------------------------------------------------------------- stats

export interface KnowledgeStats {
  threads: number;
  runs: number;
  sources: number;
  documents: number;
  memories: number;
  answers: number;
  events: number;
  approxBytes: number;
  embedModel: string | null;
  /** the stored runs' + overviews' token usage, summed (null = nothing
      recorded yet); rerank is the ranking cascade's endpoint spend (its
      own bucket -- it is not LLM tokens) */
  usage: {
    input: number;
    output: number;
    thoughts: number;
    cached: number;
    cache_write: number;
    rerank?: { calls: number; tokens: number };
  } | null;
}

/** The stored runs' + overviews' token usage, summed over their meta.
    Null when nothing recorded -- the admin cards hide the section. */
async function usageTotals(): Promise<{
  input: number;
  output: number;
  thoughts: number;
  cached: number;
  cache_write: number;
  rerank?: { calls: number; tokens: number };
} | null> {
  await pg();
  const rows = await pgQuery<{
    input: string;
    output: string;
    thoughts: string;
    cached: string;
    cache_write: string;
    rerank_calls: string;
    rerank_tokens: string;
    any: string;
  }>(
    `SELECT
       COALESCE(sum((meta->'usage'->>'input')::bigint), 0) AS input,
       COALESCE(sum((meta->'usage'->>'output')::bigint), 0) AS output,
       COALESCE(sum(COALESCE((meta->'usage'->>'thoughts')::bigint, 0)), 0) AS thoughts,
       COALESCE(sum(COALESCE((meta->'usage'->>'cached')::bigint, 0)), 0) AS cached,
       COALESCE(sum(COALESCE((meta->'usage'->>'cache_write')::bigint, 0)), 0) AS cache_write,
       COALESCE(sum(COALESCE((meta->'usage'->'rerank'->>'calls')::bigint, 0)), 0) AS rerank_calls,
       COALESCE(sum(COALESCE((meta->'usage'->'rerank'->>'tokens')::bigint, 0)), 0) AS rerank_tokens,
       count(*) AS any
     FROM knowledge WHERE kind IN ('run', 'answer') AND meta->'usage' IS NOT NULL`,
  );
  const row = rows?.[0];
  if (!row || Number(row.any) === 0) {
    return null;
  }
  return {
    input: Number(row.input) || 0,
    output: Number(row.output) || 0,
    thoughts: Number(row.thoughts) || 0,
    cached: Number(row.cached) || 0,
    cache_write: Number(row.cache_write) || 0,
    rerank:
      Number(row.rerank_calls) > 0
        ? { calls: Number(row.rerank_calls) || 0, tokens: Number(row.rerank_tokens) || 0 }
        : undefined,
  };
}

export async function knowledgeStats(): Promise<KnowledgeStats> {
  await pg();
  const rows = await pgQuery<{ kind: string; n: number }>("SELECT kind, count(*) AS n FROM knowledge GROUP BY kind");
  const byKind = new Map<string, number>((rows ?? []).map((row) => [row.kind, Number(row.n) || 0]));
  const sizeRows = await pgQuery<{ bytes: number; model: string | null }>(
    `SELECT COALESCE(sum(octet_length(body) + octet_length(title) + octet_length(search_text)), 0) AS bytes,
            max(embed_model) AS model FROM knowledge`,
  );
  const threads = await pgQuery<{ n: number }>("SELECT count(*) AS n FROM thread_head");
  const events = await pgQuery<{ n: number }>("SELECT count(*) AS n FROM run_event");
  const pick = (kind: string) => byKind.get(kind) ?? 0;
  return {
    threads: Number((threads ?? [])[0]?.n ?? 0),
    runs: pick("run"),
    sources: pick("source"),
    documents: pick("document"),
    memories: pick("memory"),
    answers: pick("answer"),
    events: Number((events ?? [])[0]?.n ?? 0),
    approxBytes: Number((sizeRows ?? [])[0]?.bytes ?? 0),
    embedModel: (sizeRows ?? [])[0]?.model ?? null,
    usage: await usageTotals(),
  };
}

// ------------------------------------------------------------- mutations

export function toggleThreadPin(threadId: string, on: boolean): void {
  void enqueue(async () => {
    await pgQuery("UPDATE knowledge SET pinned = $1 WHERE thread_id = $2 AND kind = 'run'", [on ? 1 : 0, threadId]);
    await pgQuery("UPDATE thread_head SET pinned = $1 WHERE thread_id = $2", [on ? 1 : 0, threadId]);
  });
}

export interface ThreadAnswer {
  answer: string;
  /** the run's cited sources in citation order (the inspector's 引用来源) */
  sources: Array<{ n: number; url: string; title: string; host: string; favicon: string }>;
  /** the run's token usage (the run row's meta) */
  usage: OverviewUsage | null;
}

/** A thread's latest run answer, reassembled from the evt log (the run
    rows only carry a 600-char head for the directory preview), with the
    run's cited sources and token usage.  Gallery placeholders strip --
    the inspector renders plain markdown. */
export async function loadThreadAnswer(threadId: string): Promise<ThreadAnswer> {
  await pg();
  const rows = await pgQuery<{ answer: string }>(
    `SELECT COALESCE(string_agg(data->>'t', '' ORDER BY n), '') AS answer
     FROM run_event
     WHERE thread_id = $1 AND data->>'e' = 'answer'
       AND run_id = (SELECT run_id FROM knowledge WHERE thread_id = $1 AND kind = 'run' ORDER BY n DESC LIMIT 1)`,
    [threadId],
  );
  const sources = await pgQuery<{ n: number; url: string; title: string; host: string; favicon: string | null }>(
    `SELECT n, url, title, host, COALESCE(meta->>'favicon', '') AS favicon
     FROM knowledge
     WHERE kind = 'source_ref' AND thread_id = $1
       AND run_id = (SELECT run_id FROM knowledge WHERE thread_id = $1 AND kind = 'run' ORDER BY n DESC LIMIT 1)
     ORDER BY n`,
    [threadId],
  );
  const usageRows = await pgQuery<{ meta: Record<string, unknown> }>(
    "SELECT meta FROM knowledge WHERE thread_id = $1 AND kind = 'run' ORDER BY n DESC LIMIT 1",
    [threadId],
  );
  const runMeta = (usageRows?.[0]?.meta ?? {}) as {
    model?: string;
    usage?: {
      input?: number;
      output?: number;
      thoughts?: number | null;
      cached?: number;
      rerank?: { calls: number; tokens: number };
    };
  };
  const usage = runMeta.usage
    ? {
        model: runMeta.model ?? null,
        input: runMeta.usage.input ?? null,
        output: runMeta.usage.output ?? null,
        thoughts: runMeta.usage.thoughts ?? null,
        cached: runMeta.usage.cached ?? null,
        rerank: runMeta.usage.rerank,
      }
    : null;
  return {
    answer: String(rows?.[0]?.answer ?? "").replace(/\{\{zjs-gallery:\d+\}\}/g, ""),
    sources: (sources ?? []).map((row) => ({
      n: Number(row.n) || 0,
      url: String(row.url ?? ""),
      title: String(row.title ?? ""),
      host: String(row.host ?? ""),
      favicon: String(row.favicon ?? ""),
    })),
    usage,
  };
}

/** Pin/unpin ANY projection row (the row's own id -- threads pin as a
    group through toggleThreadPin, every other kind pins itself). */
export function toggleItemPin(id: string, on: boolean): void {
  void enqueue(async () => {
    await pgQuery("UPDATE knowledge SET pinned = $1 WHERE id = $2", [on ? 1 : 0, id]);
  });
}

/** Delete one projection row by id.  An overview takes its (query,
    source) ref rows with it and steps the cited sources' counters back
    down; other kinds are a single DELETE (sources go through
    deleteSource, which cascades by url_hash). */
export function deleteItem(id: string): void {
  void enqueue(async () => {
    if (id.startsWith("ovw:")) {
      const queryHash = id.slice(4);
      const refs = await pgQuery<{ url_hash: string }>(
        "SELECT url_hash FROM knowledge WHERE kind = 'source_ref' AND id LIKE 'ref:ovw:' || $1 || ':%'",
        [queryHash],
      );
      for (const row of refs ?? []) {
        await pgQuery(
          "UPDATE knowledge SET refs = GREATEST(refs - 1, 0), cited = GREATEST(cited - 1, 0) WHERE kind = 'source' AND url_hash = $1",
          [row.url_hash],
        );
      }
      await pgQuery("DELETE FROM knowledge WHERE kind = 'source_ref' AND id LIKE 'ref:ovw:' || $1 || ':%'", [
        queryHash,
      ]);
    }
    await pgQuery("DELETE FROM knowledge WHERE id = $1", [id]);
  });
}

/** A thread's everything: events, projections, provenance -- one DELETE
    per table (the thread head row goes with it). */
export function deleteThread(threadId: string): void {
  void enqueue(async () => {
    await pgQuery("DELETE FROM knowledge WHERE thread_id = $1", [threadId]);
    await pgQuery("DELETE FROM run_event WHERE thread_id = $1", [threadId]);
    await pgQuery("DELETE FROM thread_head WHERE thread_id = $1", [threadId]);
  });
}

/** Forget one corpus source: its ref rows and its archived document go
    with it (same url_hash identity). */
export function deleteSource(url: string): void {
  const hash = urlHash(url);
  void enqueue(async () => {
    await pgQuery("DELETE FROM knowledge WHERE url_hash = $1 AND kind IN ('source', 'source_ref', 'document')", [hash]);
  });
}

/** The nuclear option: drop the tables themselves (schema recreated on
    next boot).  The knowledge base's localStorage siblings die with it --
    the embedding usage totals (zjs-embed-usage) are part of the same
    account; a "reset" that leaves them behind reads as a broken reset. */
export function resetAll(): void {
  void enqueue(async () => {
    const { resetDatabase } = await import("@/lib/pg.ts");
    await resetDatabase();
    try {
      window.localStorage.removeItem("zjs-embed-usage");
    } catch {
      /* storage unavailable -- the DB reset still happened */
    }
  });
}

// ---------------------------------------------------------- live subscriptions

/** A live query's unsubscribe handle. */
export interface StoreSubscription {
  unsubscribe(): void;
}

type LiveNamespace = import("@electric-sql/pglite/live").LiveNamespace;

async function liveQuery<T>(sql: string, params: unknown[], onUpdate: (rows: T[]) => void): Promise<StoreSubscription> {
  const db = (await pg()) as Pg & { live: LiveNamespace };
  const handle = await db.live.query<T>(sql, params, (results) => onUpdate((results.rows ?? []) as T[]));
  return {
    unsubscribe: () => {
      handle.unsubscribe().catch(() => {
        /* the session may already be gone */
      });
    },
  };
}

/** The thread directory as a live listing (re-fires on thread_head
    writes -- settle/pin/delete -- not on every evt flush). */
export function subscribeThreads(onUpdate: (threads: ThreadSummary[]) => void): Promise<StoreSubscription> {
  return liveQuery<Record<string, unknown>>(
    `SELECT thread_id AS id, title, preview, runs, sources, updated, pinned
     FROM thread_head ORDER BY pinned DESC, updated DESC LIMIT 40`,
    [],
    (rows) =>
      onUpdate(
        (rows ?? []).map((row) => ({
          id: String(row.id),
          title: String(row.title ?? ""),
          runs: Number(row.runs) || 0,
          sources: Number(row.sources) || 0,
          updated: Number(row.updated) || 0,
          pinned: Number(row.pinned) === 1,
          preview: String(row.preview ?? ""),
        })),
      ),
  );
}

/** The memories as a live listing. */
export function subscribeMemories(onUpdate: (memories: MemoryRow[]) => void): Promise<StoreSubscription> {
  return liveQuery<{ id: string; body: string; updated: number }>(
    "SELECT id, body, updated FROM knowledge WHERE kind = 'memory' ORDER BY created",
    [],
    (rows) =>
      onUpdate(
        (rows ?? []).map((row) => ({ id: row.id, content: String(row.body ?? ""), updated: Number(row.updated) || 0 })),
      ),
  );
}

/** Called once at boot with the embedding capability's width -- the
    pgvector column is created at this dimension. */
export function configureEmbeddingDimensions(dims: number): void {
  configurePgDimensions(dims);
}

// Local-instance debugging handle: the store's write path is
// fire-and-forget by design, so a stuck boot or a failed INSERT reads as
// "the feature is broken" -- the console probe answers back (ask the
// page, not the eye).  Runtime hostname check: public deployments never
// carry it, and vite cannot fold the check away.
if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
  (window as unknown as Record<string, unknown>).__zjsKnowledge = {
    pgQuery,
    loadThreadEvents,
    loadRunEvents,
    knowledgeStats,
    listThreads,
    graphSnapshot,
    settleRun,
    recallCorpus,
  };
}
