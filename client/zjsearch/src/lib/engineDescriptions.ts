// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { fetchJson } from "@/lib/http.ts";

/**
 * Lazy engine descriptions (same source as the simple theme):
 * GET /engine_descriptions.json -> { engine: [description, source] }
 */

let cache: Record<string, [string, string]> | null = null;
let inflight: Promise<Record<string, [string, string]>> | null = null;

export function loadEngineDescriptions(): Promise<Record<string, [string, string]>> {
  if (cache) {
    return Promise.resolve(cache);
  }
  if (!inflight) {
    // silent failure by design: descriptions are best-effort chrome
    inflight = fetchJson<Record<string, [string, string]>>("engine_descriptions.json")
      .then((payload) => {
        cache = payload;
        return cache;
      })
      .catch(() => {
        cache = {};
        return cache;
      });
  }
  return inflight;
}
