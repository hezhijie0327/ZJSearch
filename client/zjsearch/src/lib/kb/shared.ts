// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store's shared foundation (知识库): the pieces every kb
    module builds on -- the ordered write queue, the capability tokens,
    the knowledge-row shape and its SQL mapping, the JSON decode helper
    and the thread url.  The store's full picture lives across the kb/
    modules: events (the run-event stream), projections (the write
    paths), recall (the read paths), stats, inspector, live (the
    subscriptions).  Database failure = the call site degrades (empty
    list / no-op); there is deliberately no fallback storage. */

import { configurePgDimensions } from "@/lib/pg.ts";

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

/** The capability tokens for the write-path trailers (the embed pass and
    the tag normalization in projections.ts) -- module-private state, so
    the siblings read them through these accessors. */
export function aiTokenValue(): string | null {
  return aiToken;
}

export function embedModelName(): string | null {
  return embedModel;
}

/** Called once at boot with the embedding capability's width -- the
    pgvector column is created at this dimension. */
export function configureEmbeddingDimensions(dims: number): void {
  configurePgDimensions(dims);
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

export function rowToItem(row: Record<string, unknown>): KnowledgeItem {
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

export const ITEM_COLUMNS =
  "id, kind, thread_id, run_id, url, url_hash, host, title, body, tags, meta, status, n, pinned, refs, cited, updated";

// ---------------------------------------------------------- ordered queue

let queue: Promise<void> = Promise.resolve();

/** The store's ordered write path: every mutation runs through here, in
    submission order.  A failed task must surface in the console (the
    fire-and-forget callers would otherwise swallow it and the data loss
    would read as "the feature is broken"). */
export function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.then(
    () => undefined,
    (err: unknown) => {
      console.warn("zjsearch knowledge store: write failed", err);
    },
  );
  return run;
}

// ------------------------------------------------------------------ decode

export function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
