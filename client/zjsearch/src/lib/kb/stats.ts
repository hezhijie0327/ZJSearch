// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store's admin aggregates (the stats panel's numbers).
    v5 shape: the per-kind counts/bytes come off the trigger-maintained
    ``stats`` ledger, the usage totals off the ``run_summary`` rollup
    (runs) plus the kind-filtered overview rows (answers) -- no query
    here touches a full text or scans the projections table, and the
    result caches for 30s (the panel re-renders on every focus). */

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

interface UsageLeg {
  input: string;
  output: string;
  thoughts: string;
  cached: string;
  cache_write: string;
  rerank_calls: string;
  rerank_tokens: string;
  decision_calls: string;
  decision_tokens: string;
}

const USAGE_SUM = `COALESCE(sum(COALESCE((usage->>'input')::bigint, 0)), 0) AS input,
   COALESCE(sum(COALESCE((usage->>'output')::bigint, 0)), 0) AS output,
   COALESCE(sum(COALESCE((usage->>'thoughts')::bigint, 0)), 0) AS thoughts,
   COALESCE(sum(COALESCE((usage->>'cached')::bigint, 0)), 0) AS cached,
   COALESCE(sum(COALESCE((usage->>'cache_write')::bigint, 0)), 0) AS cache_write,
   COALESCE(sum(COALESCE((usage->'rerank'->>'calls')::bigint, 0)), 0) AS rerank_calls,
   COALESCE(sum(COALESCE((usage->'rerank'->>'tokens')::bigint, 0)), 0) AS rerank_tokens,
   COALESCE(sum(COALESCE((usage->'decision'->>'calls')::bigint, 0)), 0) AS decision_calls,
   COALESCE(sum(COALESCE((usage->'decision'->>'tokens')::bigint, 0)), 0) AS decision_tokens`;

function foldUsage(legs: UsageLeg[]): KnowledgeStats["usage"] {
  if (legs.length === 0) {
    return null;
  }
  const pick = (leg: UsageLeg, key: keyof UsageLeg) => Number(leg[key]) || 0;
  const rerankCalls = legs.reduce((sum, leg) => sum + pick(leg, "rerank_calls"), 0);
  const decisionCalls = legs.reduce((sum, leg) => sum + pick(leg, "decision_calls"), 0);
  return {
    input: legs.reduce((sum, leg) => sum + pick(leg, "input"), 0),
    output: legs.reduce((sum, leg) => sum + pick(leg, "output"), 0),
    thoughts: legs.reduce((sum, leg) => sum + pick(leg, "thoughts"), 0),
    cached: legs.reduce((sum, leg) => sum + pick(leg, "cached"), 0),
    cache_write: legs.reduce((sum, leg) => sum + pick(leg, "cache_write"), 0),
    rerank:
      rerankCalls > 0
        ? { calls: rerankCalls, tokens: legs.reduce((sum, leg) => sum + pick(leg, "rerank_tokens"), 0) }
        : undefined,
    decision:
      decisionCalls > 0
        ? { calls: decisionCalls, tokens: legs.reduce((sum, leg) => sum + pick(leg, "decision_tokens"), 0) }
        : undefined,
  };
}

let cache: { at: number; value: KnowledgeStats } | null = null;
const CACHE_MS = 30_000;

export async function knowledgeStats(): Promise<KnowledgeStats> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cache.value;
  }
  await pg();
  const [ledger, threads, events, runLegs, answerLegs, embed] = await Promise.all([
    pgQuery<{ kind: string; n: string; bytes: string }>("SELECT kind, n, bytes FROM stats"),
    pgQuery<{ n: string }>("SELECT count(*) AS n FROM thread_head"),
    pgQuery<{ n: string }>("SELECT COALESCE(sum(events), 0) AS n FROM run_summary"),
    pgQuery<UsageLeg>(`SELECT ${USAGE_SUM} FROM run_summary WHERE usage IS NOT NULL`),
    pgQuery<UsageLeg>(
      `SELECT ${USAGE_SUM.replace(/usage->/g, "meta->'usage'->")} FROM knowledge
       WHERE kind = 'answer' AND meta->'usage' IS NOT NULL`,
    ),
    pgQuery<{ embed_model: string | null }>("SELECT embed_model FROM knowledge WHERE embed_model IS NOT NULL LIMIT 1"),
  ]);
  const byKind = new Map<string, number>((ledger ?? []).map((row) => [row.kind, Number(row.n) || 0]));
  const pick = (kind: string) => byKind.get(kind) ?? 0;
  const value: KnowledgeStats = {
    threads: Number((threads ?? [])[0]?.n ?? 0),
    runs: pick("run"),
    sources: pick("source"),
    documents: pick("document"),
    memories: pick("memory"),
    answers: pick("answer"),
    events: Number((events ?? [])[0]?.n ?? 0),
    approxBytes: (ledger ?? []).reduce((sum, row) => sum + (Number(row.bytes) || 0), 0),
    embedModel: (embed ?? [])[0]?.embed_model ?? null,
    usage: foldUsage([...(runLegs ?? []), ...(answerLegs ?? [])]),
  };
  cache = { at: Date.now(), value };
  return value;
}

/** The stats cache invalidates when the store's shape changes (a settle
    landed, a delete happened) -- callers bump instead of waiting out the
    30s window. */
export function invalidateStatsCache(): void {
  cache = null;
}
