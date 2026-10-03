// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store's admin aggregates (the stats panel's numbers):
    per-kind counts, the approximate table size and the token-usage
    totals summed over the runs' + overviews' meta.  Isolated here
    because a later milestone rewrites these to read rollup tables --
    the aggregate shape stays the module's whole surface. */

import { pg, pgQuery } from "@/lib/pg.ts";

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
    decision?: { calls: number; tokens: number };
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
  decision?: { calls: number; tokens: number };
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
    decision_calls: string;
    decision_tokens: string;
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
       COALESCE(sum(COALESCE((meta->'usage'->'decision'->>'calls')::bigint, 0)), 0) AS decision_calls,
       COALESCE(sum(COALESCE((meta->'usage'->'decision'->>'tokens')::bigint, 0)), 0) AS decision_tokens,
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
    decision:
      Number(row.decision_calls) > 0
        ? { calls: Number(row.decision_calls) || 0, tokens: Number(row.decision_tokens) || 0 }
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
