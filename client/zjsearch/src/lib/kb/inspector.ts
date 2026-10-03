// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store's inspector reads: the thread inspector's answer
    (reassembled from the evt log -- the run rows only carry a 600-char
    head for the directory preview) with its cited sources and token
    usage, and an archived document's full text (the reading pane).
    Factored apart from projections.ts because both reads are standalone
    SELECTs -- nothing in the write paths needs them. */

import type { OverviewUsage } from "@/lib/kb/projections.ts";
import { pg, pgQuery, urlHash } from "@/lib/pg.ts";

export interface ThreadAnswer {
  answer: string;
  /** the run's cited sources in citation order (the inspector's 引用来源) */
  sources: Array<{ n: number; url: string; title: string; host: string; favicon: string }>;
  /** the run's token usage (the run row's meta) */
  usage: OverviewUsage | null;
}

/** A thread's latest run answer, reassembled from the evt log, with the
    run's cited sources and token usage.  Gallery placeholders strip --
    the inspector renders plain markdown. */
export async function loadThreadAnswer(threadId: string): Promise<ThreadAnswer> {
  await pg();
  const rows = await pgQuery<{ answer: string }>(
    `SELECT COALESCE(string_agg(data->>'t', '' ORDER BY n), '') AS answer
     FROM run_event
     WHERE thread_id = $1 AND data->>'e' = 'answer'
       AND run_id = (SELECT run_id FROM knowledge WHERE thread_id = $1 AND kind = 'run' ORDER BY n DESC LIMIT 1)`,
    [threadId],
  );
  const sources = await pgQuery<{ n: number; url: string; title: string; host: string; favicon: string | null }>(
    `SELECT n, url, title, host, COALESCE(meta->>'favicon', '') AS favicon
     FROM knowledge
     WHERE kind = 'source_ref' AND thread_id = $1
       AND run_id = (SELECT run_id FROM knowledge WHERE thread_id = $1 AND kind = 'run' ORDER BY n DESC LIMIT 1)
     ORDER BY n`,
    [threadId],
  );
  const usageRows = await pgQuery<{ meta: Record<string, unknown> }>(
    "SELECT meta FROM knowledge WHERE thread_id = $1 AND kind = 'run' ORDER BY n DESC LIMIT 1",
    [threadId],
  );
  const runMeta = (usageRows?.[0]?.meta ?? {}) as {
    model?: string;
    usage?: {
      input?: number;
      output?: number;
      thoughts?: number | null;
      cached?: number;
      rerank?: { calls: number; tokens: number };
    };
  };
  const usage = runMeta.usage
    ? {
        model: runMeta.model ?? null,
        input: runMeta.usage.input ?? null,
        output: runMeta.usage.output ?? null,
        thoughts: runMeta.usage.thoughts ?? null,
        cached: runMeta.usage.cached ?? null,
        rerank: runMeta.usage.rerank,
      }
    : null;
  return {
    answer: String(rows?.[0]?.answer ?? "").replace(/\{\{zjs-gallery:\d+\}\}/g, ""),
    sources: (sources ?? []).map((row) => ({
      n: Number(row.n) || 0,
      url: String(row.url ?? ""),
      title: String(row.title ?? ""),
      host: String(row.host ?? ""),
      favicon: String(row.favicon ?? ""),
    })),
    usage,
  };
}

/** One archived document's full markdown (the inspector's reading pane). */
export async function loadDocument(url: string): Promise<{ title: string; markdown: string; chars: number } | null> {
  const rows = await pgQuery<{ title: string; body: string; n: number }>(
    "SELECT title, body, n FROM knowledge WHERE id = $1 AND kind = 'document'",
    [`doc:${urlHash(url)}`],
  );
  const row = (rows ?? [])[0];
  if (!row) {
    return null;
  }
  return { title: String(row.title ?? ""), markdown: String(row.body ?? ""), chars: Number(row.n ?? 0) || 0 };
}
