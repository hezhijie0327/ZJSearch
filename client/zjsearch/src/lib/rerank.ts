// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The recall rerank's source: the server's ``POST /zjsearch/ai/rerank``
    route -- an HMAC-gated proxy to the deployment's Cohere-shaped rerank
    API (the key never leaves the server).  The capability rides the
    page-data globals (`rerank`, configured via ``zjsearch.rerank``) and
    is handed in once at boot by `configureRerank`.

    Every call returns ``null`` when the feature is unavailable or the
    upstream failed -- the recall treats null as "keep the fused order":
    the same fail-open contract the ranking cascade's rerank leg keeps. */

import { fetchJson } from "@/lib/http.ts";
import { pgQuery } from "@/lib/pg.ts";

export interface RerankConfig {
  /** the page-data HMAC token of the rerank capability */
  token: string;
}

let config: RerankConfig | null = null;

/** Called once at boot with the page-data capability (null = absent). */
export function configureRerank(cfg: RerankConfig | null): void {
  config = cfg;
}

export function rerankConfigured(): boolean {
  return config !== null;
}

/** Re-score documents against the query: the model's order out (rank
    position -> document index), null when the feature is
    off/unconfigured or the upstream failed -- the caller keeps its
    previous order then.  ≤32 documents, each ≤2000 chars server-side. */
export async function rerankDocs(query: string, documents: string[]): Promise<number[] | null> {
  if (!config || documents.length < 2) {
    return null;
  }
  try {
    const result = await fetchJson<{ order?: number[]; tokens?: number }>("/zjsearch/ai/rerank", {
      body: JSON.stringify({ tk: config.token, query, documents }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const order = result.order;
    if (!Array.isArray(order) || order.length === 0) {
      return null;
    }
    if (result.tokens) {
      void recordRerankUsage(result.tokens);
    }
    return order;
  } catch {
    return null;
  }
}

// ── the rerank usage totals: ONE knowledge row (kind "usage"), the same
// shape as the embedding account -- the model-stats card reads it back ──

async function recordRerankUsage(tokens: number): Promise<void> {
  try {
    const now = Date.now();
    await pgQuery(
      `INSERT INTO knowledge (id, kind, title, body, status, meta, tags, search_text, created, updated, occurred_at)
       VALUES ('usage:rerank', 'usage', 'rerank usage', '', 'done',
               jsonb_build_object('input', $1::bigint, 'calls', 1),
               '[]'::jsonb, '', $2, $2, $2)
       ON CONFLICT (id) DO UPDATE SET
         meta = jsonb_build_object(
           'input', (COALESCE(knowledge.meta->>'input', '0')::bigint + $1::bigint),
           'calls', (COALESCE(knowledge.meta->>'calls', '0')::bigint + 1)),
         updated = $2`,
      [tokens, now],
    );
  } catch (err) {
    // best-effort accounting, same doctrine as the embedding totals
    console.warn("zjs-rerank-usage: recording failed", err);
  }
}

export interface RerankUsageTotals {
  input: number;
  calls: number;
}

export async function readRerankUsage(): Promise<RerankUsageTotals> {
  try {
    const rows = await pgQuery<{ meta: { input?: number; calls?: number } }>(
      `SELECT meta FROM knowledge WHERE id = 'usage:rerank' AND kind = 'usage'`,
      [],
    );
    const meta = rows?.[0]?.meta;
    if (meta) {
      return { input: Number(meta.input) || 0, calls: Number(meta.calls) || 0 };
    }
  } catch (err) {
    console.warn("zjs-rerank-usage: read failed", err);
    /* fall through to the zero totals */
  }
  return { input: 0, calls: 0 };
}
