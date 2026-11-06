// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The memory store (the tripartite refactor's semantic + procedural
    layers): dedicated ``memory`` table, full CRUD, and its own hybrid
    read.  The wire `memory` events land here through the run fold; the
    extractor's procedures arrive as ``provisional`` rows that only reach
    the prompts after the panel's one-click confirm.  Episodic memory is
    NOT stored here -- episodes are the thread archive itself, queried
    through recall.ts's listEpisodes.

    Every write funnels through the ordered queue (shared.ts); failure =
    console warn + the call site degrades.  The rows carry strength /
    last_seen so the pre-send selection can decay softly (unseen facts
    sink, nothing auto-deletes). */

import { embeddingsConfigured, embedTexts } from "@/lib/embed.ts";
import type { KnowledgeItem } from "@/lib/kb/shared.ts";
import { embedModelName, enqueue } from "@/lib/kb/shared.ts";
import { pg, pgQuery, segmentKeywords, toVectorLiteral } from "@/lib/pg.ts";
import { rerankConfigured, rerankDocs } from "@/lib/rerank.ts";

export type MemoryKind = "fact" | "procedure" | "lesson" | "gap";
export type MemoryOrigin = "user" | "model" | "teach";
export type MemoryState = "active" | "provisional";

export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  content: string;
  origin: MemoryOrigin;
  state: MemoryState;
  /** site-bound row (a SITE recipe: the login path, the on-site search
      pattern) -- null for the global facts/preferences */
  host: string | null;
  strength: number;
  lastSeen: number;
  pinned: boolean;
  created: number;
  updated: number;
}

export const MEMORY_BODY_CAP = 300;

/** The panel/prompts row shape from a SQL row (the live subscription
    shares it). */
export function rowToMemory(row: Record<string, unknown>): MemoryRow {
  const kind = row.kind as MemoryKind;
  return {
    id: String(row.id),
    kind: kind === "procedure" || kind === "lesson" || kind === "gap" ? kind : "fact",
    content: String(row.body ?? ""),
    origin: row.origin === "user" || row.origin === "teach" ? row.origin : "model",
    state: row.state === "provisional" ? "provisional" : "active",
    host: row.host ? String(row.host) : null,
    strength: Number(row.strength) || 1,
    lastSeen: Number(row.last_seen) || 0,
    pinned: Number(row.pinned) === 1,
    created: Number(row.created) || 0,
    updated: Number(row.updated) || 0,
  };
}

const MEMORY_COLUMNS = "id, kind, body, origin, state, host, strength, last_seen, pinned, created, updated";

/** The search-results shape (the panel's cross-kind search rides the
    shared KnowledgeItem rendering): memory rows are title-less. */
function memoryToItem(row: Record<string, unknown>): KnowledgeItem {
  const memory = rowToMemory(row);
  return {
    id: memory.id,
    kind: "memory",
    threadId: null,
    runId: null,
    url: null,
    urlHash: null,
    host: null,
    title: "",
    body: memory.content,
    tags: [],
    status: memory.state,
    n: null,
    pinned: memory.pinned,
    refs: 0,
    cited: 0,
    updated: memory.updated,
    meta: { mkind: memory.kind, origin: memory.origin, state: memory.state, strength: memory.strength },
  };
}

function newMemoryId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ------------------------------------------------------------------- CRUD

export function saveMemory(
  content: string,
  init: { kind?: MemoryKind; origin?: MemoryOrigin; state?: MemoryState; host?: string | null } = {},
): void {
  const text = content.trim().slice(0, MEMORY_BODY_CAP);
  if (!text) {
    return;
  }
  void enqueue(async () => {
    const now = Date.now();
    await pgQuery(
      `INSERT INTO memory (id, kind, body, origin, state, host, strength, last_seen, search_text, created, updated)
       SELECT $1, $2, $3, $4, $5, $6, 1, $7, $8, $7, $7
       WHERE NOT EXISTS (SELECT 1 FROM memory WHERE body = $3)`,
      [
        `mem:${newMemoryId()}`,
        init.kind ?? "fact",
        text,
        init.origin ?? "model",
        init.state ?? "active",
        init.host ?? null,
        now,
        segmentKeywords(text).slice(0, 300),
      ],
    );
    void embedPendingMemories();
  });
}

/** Rewrite one memory's text (the panel's inline edit): the row re-joins
    the embed pass (embedding dropped, the pass re-embeds it). */
export function updateMemory(id: string, content: string): void {
  const text = content.trim().slice(0, MEMORY_BODY_CAP);
  if (!text) {
    return;
  }
  void enqueue(async () => {
    await pgQuery(
      "UPDATE memory SET body = $1, search_text = $2, embedding = NULL, embed_model = NULL, updated = $3 WHERE id = $4",
      [text, segmentKeywords(text).slice(0, 300), Date.now(), id],
    );
    void embedPendingMemories();
  });
}

export function forgetMemory(id: string): void {
  void enqueue(async () => {
    await pgQuery("DELETE FROM memory WHERE id = $1", [id]);
  });
}

/** One re-observation (the extractor/tool recognized an existing fact):
    the reinforcement beat -- strength grows, the decay clock resets. */
export function reinforceMemory(id: string): void {
  void enqueue(async () => {
    await pgQuery("UPDATE memory SET strength = strength + 1, last_seen = $1, updated = $1 WHERE id = $2", [
      Date.now(),
      id,
    ]);
  });
}

/** A mined procedure passes the user's confirm: it joins the prompts. */
export function confirmProcedure(id: string): void {
  void enqueue(async () => {
    await pgQuery("UPDATE memory SET state = 'active', last_seen = $1, updated = $1 WHERE id = $2", [Date.now(), id]);
  });
}

/** The user declines a mined procedure -- gone (a re-mined candidate can
    come back fresh). */
export function dismissProcedure(id: string): void {
  forgetMemory(id);
}

export function toggleMemoryPin(id: string): void {
  void enqueue(async () => {
    await pgQuery("UPDATE memory SET pinned = 1 - pinned, updated = $1 WHERE id = $2", [Date.now(), id]);
  });
}

/** The prompt-injection snapshot AND the panel's listing.  Without a
    query: every row in the soft-decay order (pinned > last_seen >
    strength).  With one (the run's pre-send): a store past the cap is
    SELECTED, not truncated -- pinned rows always ride, the vector leg
    pulls the query-relevant head, recency backfills, and the rerank
    stage (when configured, within the caller's budget) orders the
    final cut; every failure degrades to the soft-decay order. */
export async function loadMemories(query?: string, limit = 50): Promise<MemoryRow[]> {
  await pg();
  const rows = await pgQuery<Record<string, unknown>>(`SELECT ${MEMORY_COLUMNS} FROM memory`);
  const all = (rows ?? []).map(rowToMemory);
  if (all.length <= limit || !query?.trim()) {
    return softDecayOrder(all);
  }
  const chosen = new Map<string, MemoryRow>(all.filter((row) => row.pinned).map((row) => [row.id, row]));
  try {
    const vector = embeddingsConfigured() ? (await embedTexts([query.trim()]))?.[0] : undefined;
    if (vector) {
      const near = await pgQuery<Record<string, unknown>>(
        `SELECT ${MEMORY_COLUMNS} FROM memory
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector LIMIT $2`,
        [toVectorLiteral(vector), limit],
      );
      for (const row of near ?? []) {
        const memory = rowToMemory(row);
        chosen.set(memory.id, memory);
      }
    }
  } catch {
    /* the vector leg is a lens, not a dependency */
  }
  for (const row of softDecayOrder(all)) {
    if (chosen.size >= limit * 2) {
      break;
    }
    chosen.set(row.id, row);
  }
  let cut = [...chosen.values()].slice(0, limit);
  if (rerankConfigured() && chosen.size > limit) {
    try {
      const docs = [...chosen.values()];
      const order = await rerankDocs(
        query,
        docs.map((row) => row.content),
      );
      if (order && order.length === docs.length) {
        cut = order
          .map((index) => docs[index])
          .filter((row) => row !== undefined)
          .slice(0, limit);
      }
    } catch {
      /* fail-open: the soft-decay cut stands */
    }
  }
  return cut;
}

/** The listing order: pinned first, then the freshest reinforcements,
    then the strongest. */
function softDecayOrder(rows: MemoryRow[]): MemoryRow[] {
  return [...rows].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.lastSeen - a.lastSeen || b.strength - a.strength,
  );
}

// ------------------------------------------------------------ hybrid read

/** The SITE notes (the host-bound layer: site recipes AND source
    notes -- both kinds bind to one website): active rows with a host,
    in the soft-decay order -- the run's pre-send carries them
    separately from the global snapshot (the browse/search lanes answer
    to them by host, not query relevance). */
export async function loadSiteNotes(limit = 8): Promise<MemoryRow[]> {
  await pg();
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT ${MEMORY_COLUMNS} FROM memory
     WHERE host IS NOT NULL AND state = 'active'
     ORDER BY pinned DESC, last_seen DESC, strength DESC LIMIT $1`,
    [limit],
  );
  return (rows ?? []).map(rowToMemory);
}

/** The memory table's own two-leg hybrid (bm25 + pgvector, RRF) for the
    panel's cross-kind search -- the same over-fetch + fusion shape as
    recall.ts's hybridRecall, minus the tag legs (memory rows carry no
    tags) and the trigram rescue (title-less rows). */
export async function hybridMemoryHits(query: string, limit = 12): Promise<KnowledgeItem[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  await pg();
  const keywords = segmentKeywords(trimmed);
  const scores = new Map<string, { item: KnowledgeItem; score: number }>();
  const bump = (rows: Record<string, unknown>[], weight: number) => {
    (rows ?? []).forEach((row, rank) => {
      const item = memoryToItem(row);
      const entry = scores.get(item.id);
      scores.set(item.id, { item, score: (entry?.score ?? 0) + weight / (60 + rank + 1) });
    });
  };
  const fetchN = Math.max(limit * 4, 24);
  const [keywordRows, semanticRows] = await Promise.all([
    keywords
      ? pgQuery<Record<string, unknown>>(
          `SELECT ${MEMORY_COLUMNS}, (search_text <@> to_bm25query($1, 'memory_bm25')) AS _score
           FROM memory
           WHERE (search_text <@> to_bm25query($1, 'memory_bm25')) <> 0
           ORDER BY _score DESC LIMIT $2`,
          [keywords, fetchN],
        )
      : Promise.resolve([] as Record<string, unknown>[]),
    embeddingsConfigured()
      ? (async () => {
          const vector = (await embedTexts([trimmed]))?.[0];
          if (!vector) {
            return [] as Record<string, unknown>[];
          }
          return pgQuery<Record<string, unknown>>(
            `SELECT ${MEMORY_COLUMNS}, 1 - (embedding <=> $1::vector) AS _score
             FROM memory
             WHERE embedding IS NOT NULL
             ORDER BY embedding <=> $1::vector LIMIT $2`,
            [toVectorLiteral(vector), fetchN],
          );
        })()
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);
  bump(keywordRows, 1.0);
  bump(semanticRows, 1.0);
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** The search view's kind listing (listKind('memory')). */
export async function listMemoryItems(limit = 40): Promise<KnowledgeItem[]> {
  await pg();
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT ${MEMORY_COLUMNS} FROM memory ORDER BY pinned DESC, last_seen DESC, strength DESC LIMIT $1`,
    [limit],
  );
  return (rows ?? []).map(memoryToItem);
}

// ------------------------------------------------------------- embed pass

let embedRunning = false;

/** The memory table's slice of the embed pipeline (the knowledge twin
    lives in projections.ts): rows land unembedded and join the vector
    leg (panel search + the future selection lanes) the next time this
    pass runs with the capability on. */
async function embedPendingMemories(): Promise<void> {
  if (embedRunning || !embeddingsConfigured()) {
    return;
  }
  embedRunning = true;
  try {
    const rows = await pgQuery<{ id: string; search_text: string }>(
      "SELECT id, search_text FROM memory WHERE embed_model IS NULL AND search_text <> '' LIMIT 16",
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
          "UPDATE memory SET embedding = $1::vector, embed_model = $2 WHERE id = $3 AND embed_model IS NULL",
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
