// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store's shared foundation (the knowledge base): the pieces every kb
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
  return `/zjsearch/ask/thread/${id}`;
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

/** The display columns: ``head AS body`` -- every listing/search row
    carries the 600-char write-time excerpt and NEVER detoasts the full
    text (the old shape dragged 40 full documents through the WASM just
    to render 90-char previews).  Full text is the inspector's business:
    loadItemBody / the corpus columns below. */
export const ITEM_COLUMNS =
  "id, kind, thread_id, run_id, url, url_hash, host, title, head AS body, tags, meta, status, n, pinned, refs, cited, updated";

/** The corpus columns: the REAL body -- the AI-context paths (the writer
    corpus, the recall_history index) feed ~1500-char heads to the model
    and need the whole text, bounded by their own LIMIT. */
export const CORPUS_COLUMNS =
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

// ------------------------------------------------------------------ tags

// the english function-word class (the IR-standard stopword list -- every
// search engine ships one): the first of TWO genericity signals.  The
// second is the corpus-frequency gate at the graph/vocabulary queries (a
// tag whose row share exceeds 60% is a function word in ANY language, the
// BM25 IDF principle applied to the tag namespace) -- the list catches the
// universal class, the share gate adapts to every corpus and language.
const GENERIC_TAGS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "in",
  "on",
  "to",
  "for",
  "from",
  "with",
  "by",
  "at",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "not",
  "no",
  "but",
  "if",
  "then",
  "than",
  "so",
  "we",
  "you",
  "they",
  "he",
  "she",
  "his",
  "her",
  "their",
  "our",
  "your",
  "my",
  "me",
  "us",
  "them",
  "what",
  "which",
  "who",
  "how",
  "why",
  "when",
  "where",
  "will",
  "can",
  "could",
  "should",
  "would",
  "may",
  "might",
  "do",
  "does",
  "did",
  "done",
  "have",
  "has",
  "had",
  "get",
  "got",
  "use",
  "used",
  "using",
  "new",
  "com",
  "www",
  "http",
  "https",
]);

/** The GENERIC-TAG GATE: a tag must carry meaning on its own -- the
    english function-word class and bare digits/one-glyph tokens are
    refused at every tag doorway (the seed layer, the graph snapshot, the
    recall vocabulary); the corpus-frequency gate at the two corpus-level
    queries adds the adaptive second signal. */
export function isGenericTag(tag: string): boolean {
  const clean = (tag || "").trim().toLowerCase();
  if (clean.length < 2) {
    return true;
  }
  if (/^\d+([.,]\d+)*$/.test(clean)) {
    return true;
  }
  return GENERIC_TAGS.has(clean);
}
