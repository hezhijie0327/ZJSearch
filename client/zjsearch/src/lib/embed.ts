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
    recordEmbedUsage(result.model ?? "", result.usage);
    return embeddings;
  } catch {
    return null;
  }
}

// ── the embedding usage totals (localStorage: the calls never land in the
// knowledge table, so there is nothing to aggregate from the store) ──
export interface EmbedUsageTotals {
  model: string;
  input: number;
  chars: number;
  calls: number;
}

const EMBED_USAGE_KEY = "zjs-embed-usage";

function recordEmbedUsage(model: string, usage: { input?: number; chars?: number } | null | undefined): void {
  if (!usage || (!usage.input && !usage.chars)) {
    return;
  }
  try {
    const prev = readEmbedUsage();
    const next: EmbedUsageTotals = {
      model: model || prev.model,
      input: prev.input + (usage.input ?? 0),
      chars: prev.chars + (usage.chars ?? 0),
      calls: prev.calls + 1,
    };
    localStorage.setItem(EMBED_USAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable -- the stats are best-effort */
  }
}

export function readEmbedUsage(): EmbedUsageTotals {
  try {
    const raw = localStorage.getItem(EMBED_USAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<EmbedUsageTotals>;
      return {
        model: String(parsed.model ?? ""),
        input: Number(parsed.input) || 0,
        chars: Number(parsed.chars) || 0,
        calls: Number(parsed.calls) || 0,
      };
    }
  } catch {
    /* fall through to the zero totals */
  }
  return { model: "", input: 0, chars: 0, calls: 0 };
}
