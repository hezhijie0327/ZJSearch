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
    const result = await fetchJson<{ embeddings?: number[][] }>("/zjsearch/ai/embed", {
      body: JSON.stringify({ tk: config.token, texts }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const embeddings = result.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      return null;
    }
    return embeddings;
  } catch {
    return null;
  }
}
