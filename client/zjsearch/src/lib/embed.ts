// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The thread embeddings' source: the server's ``POST /zjsearch/ai/embed`` route --
    an HMAC-gated proxy to the deployment's OpenAI-compatible embeddings
    API (the key never leaves the server).  The capability rides the
    page-data globals (`embedding`, configured via ``zjsearch.embedding``)
    and is handed in once at boot by `configureEmbeddings`.

    Every call returns ``null`` when the feature is unavailable or the
    upstream failed -- the thread store treats null as "no embedding":
    the row persists, it just drops out of the semantic search. */

import { fetchJson } from "@/lib/http.ts";
import { pgQuery } from "@/lib/pg.ts";

export interface EmbeddingConfig {
  /** the page-data HMAC token of the embedding capability */
  token: string;
  /** the vector width the server produces (the pg column's dimension) */
  dimensions?: number;
}

let config: EmbeddingConfig | null = null;

/** Called once at boot with the page-data capability (null = absent). */
export function configureEmbeddings(cfg: EmbeddingConfig | null): void {
  config = cfg;
}

export function embeddingsConfigured(): boolean {
  return config !== null;
}

/** The configured vector width (the pg columns must be created at THIS
    dimension -- the pg module reads it lazily at boot so the width comes
    from the same capability that feeds the embed calls, wherever the
    boot-data payload carried it).  null = unconfigured. */
export function embeddingDimensions(): number | null {
  return config?.dimensions ?? null;
}

/** Embed a batch of texts (≤16, each ≤8000 chars server-side).  Resolves
    null when the feature is off/unconfigured or the upstream failed --
    the caller skips the vectors then. */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (!config || texts.length === 0) {
    return null;
  }
  try {
    const result = await fetchJson<{
      embeddings?: number[][];
      model?: string;
      usage?: { input?: number; chars?: number } | null;
    }>("/zjsearch/ai/embed", {
      body: JSON.stringify({ tk: config.token, texts }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const embeddings = result.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      return null;
    }
    void recordEmbedUsage(result.model ?? "", result.usage);
    return embeddings;
  } catch {
    return null;
  }
}

// ── the embedding usage totals: ONE knowledge row (kind "usage") the
// recorder upserts -- the account lives in the SAME store the resets
// wipe, and the model-stats card reads it back ──
export interface EmbedUsageTotals {
  model: string;
  input: number;
  chars: number;
  calls: number;
}

async function recordEmbedUsage(
  model: string,
  usage: { input?: number; chars?: number } | null | undefined,
): Promise<void> {
  if (!usage || (!usage.input && !usage.chars)) {
    return;
  }
  try {
    // the knowledge table's timestamps are epoch millis (double precision)
    // -- SQL now() would collide with the column type
    const now = Date.now();
    await pgQuery(
      `INSERT INTO knowledge (id, kind, title, body, status, meta, tags, search_text, created, updated, occurred_at)
       VALUES ('usage:embed', 'usage', 'embedding usage', '', 'done',
               jsonb_build_object('model', $1::text, 'input', $2::bigint, 'chars', $3::bigint, 'calls', 1),
               '[]'::jsonb, '', $4, $4, $4)
       ON CONFLICT (id) DO UPDATE SET
         meta = jsonb_build_object(
           'model', EXCLUDED.meta->'model',
           'input', (COALESCE(knowledge.meta->>'input', '0')::bigint + $2::bigint),
           'chars', (COALESCE(knowledge.meta->>'chars', '0')::bigint + $3::bigint),
           'calls', (COALESCE(knowledge.meta->>'calls', '0')::bigint + 1)),
         updated = $4`,
      [model, usage.input ?? 0, usage.chars ?? 0, now],
    );
  } catch (err) {
    // the stats are best-effort -- but a silent failure reads as a broken
    // feature; the console carries the reason
    console.warn("zjs-embed-usage: recording failed", err);
  }
}

export async function readEmbedUsage(): Promise<EmbedUsageTotals> {
  try {
    const rows = await pgQuery<{ meta: { model?: string; input?: number; chars?: number; calls?: number } }>(
      `SELECT meta FROM knowledge WHERE id = 'usage:embed' AND kind = 'usage'`,
      [],
    );
    const meta = rows?.[0]?.meta;
    if (meta) {
      return {
        model: String(meta.model ?? ""),
        input: Number(meta.input) || 0,
        chars: Number(meta.chars) || 0,
        calls: Number(meta.calls) || 0,
      };
    }
  } catch (err) {
    console.warn("zjs-embed-usage: read failed", err);
    /* fall through to the zero totals */
  }
  return { model: "", input: 0, chars: 0, calls: 0 };
}
