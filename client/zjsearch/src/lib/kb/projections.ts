// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store's write paths: the queryable surfaces are
    PROJECTIONS in `knowledge` written at settle (run / answer (the AI
    Overview archive -- run answers replay from the event log) / source /
    source_ref / document / memory / call / task / clarify), and the
    thread directory is the `thread_head` projection maintained at
    settle.  All of them run behind the ordered queue (shared.ts):

    - startRun -- the run's head row lands (status "streaming") at run
      start, so a crashed tab leaves a visible, replayable run;
    - settleRun -- one run settled: ONE TRANSACTION (evt flush +
      projections + thread head), then the embed pass and the debounced
      tag normalization trail behind it;
    - saveOverview / archiveDocument / saveMemory -- standalone facts;
    - the delete/pin/reset mutations. */

import { embeddingsConfigured, embedTexts } from "@/lib/embed.ts";
import { flushRunEventsBody } from "@/lib/kb/events.ts";
import { aiTokenValue, embedModelName, enqueue, safeParse } from "@/lib/kb/shared.ts";
import { pgQuery, pgTransaction, segmentKeywords, toVectorLiteral, urlHash } from "@/lib/pg.ts";

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
  decision?: { calls: number; tokens: number };
}

export function saveOverview(input: {
  query: string;
  markdown: string;
  model?: string | null;
  usage?: OverviewUsage | null;
  sources?: Array<{ n: number; url: string; title: string; favicon?: string; domain?: string; content?: string }>;
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
      const snippet = String(source.content ?? "").slice(0, 500);
      const meta = source.favicon ? { favicon: source.favicon } : {};
      await pgQuery(
        `INSERT INTO knowledge (id, kind, url_hash, url, host, title, body, meta, refs, cited, tags, search_text, created, updated, occurred_at)
         VALUES ($1, 'source', $2, $3, $4, $5, $6, $7::jsonb, 1, 1, '{}'::jsonb, $8, $9, $9, $9)
         ON CONFLICT (id) DO UPDATE SET refs = knowledge.refs + 1, cited = knowledge.cited + 1,
           title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE knowledge.title END,
           body = CASE WHEN EXCLUDED.body <> '' THEN EXCLUDED.body ELSE knowledge.body END,
           meta = CASE WHEN EXCLUDED.meta <> '{}'::jsonb THEN EXCLUDED.meta ELSE knowledge.meta END,
           updated = EXCLUDED.updated`,
        [
          `src:${hash}`,
          hash,
          String(source.url),
          String(source.domain ?? ""),
          String(source.title ?? "").slice(0, 300),
          snippet,
          JSON.stringify(meta),
          segmentKeywords(String(source.title ?? ""), String(source.domain ?? ""), snippet).slice(0, 4000),
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
          [toVectorLiteral(vector), embedModelName() ?? "unknown", target.id],
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
  const token = aiTokenValue();
  if (!token) {
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
        tk: token,
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

// --------------------------------------------------------------- mutations

export function toggleThreadPin(threadId: string, on: boolean): void {
  void enqueue(async () => {
    await pgQuery("UPDATE knowledge SET pinned = $1 WHERE thread_id = $2 AND kind = 'run'", [on ? 1 : 0, threadId]);
    await pgQuery("UPDATE thread_head SET pinned = $1 WHERE thread_id = $2", [on ? 1 : 0, threadId]);
  });
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
    next boot).  The embedding usage totals are a knowledge row like every
    other account -- they die with the table, so a reset leaves nothing
    behind. */
export function resetAll(): void {
  void enqueue(async () => {
    const { resetDatabase } = await import("@/lib/pg.ts");
    await resetDatabase();
  });
}
