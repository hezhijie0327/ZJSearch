// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge store's inspector reads: the thread inspector's answer
    (the ``run_summary`` rollup row -- the full answer text lives there
    since settle, no event-log reassembly) with its cited sources and
    token usage, any knowledge row's full body, and an archived
    document's full text (the reading pane).  Factored apart from
    projections.ts because these reads are standalone SELECTs -- nothing
    in the write paths needs them. */

import type { OverviewUsage } from "@/lib/kb/projections.ts";
import { pg, pgQuery, urlHash } from "@/lib/pg.ts";

export interface ThreadAnswer {
  answer: string;
  /** the run's cited sources in citation order (the inspector's 引用来源) */
  sources: Array<{ n: number; url: string; title: string; host: string; favicon: string }>;
  /** the run's token usage (the run_summary rollup) */
  usage: OverviewUsage | null;
  /** the REPORT document's outline (the run row's meta.report) -- the
      knowledge inspector re-renders the same DocumentView the research
      page used when sections ride along */
  report?: { title: string; subtitle?: string; sections: Array<{ id: string; title: string }> } | null;
  /** the per-section markdown texts ({id: body}) off the run_summary
      rollup -- absent for single-write runs and pre-v5.2 rows */
  sections?: Record<string, string> | null;
}

/** A thread's latest run answer off the rollup row, with the run's cited
    sources and token usage.  Gallery placeholders strip -- the inspector
    renders plain markdown. */
export async function loadThreadAnswer(threadId: string): Promise<ThreadAnswer> {
  await pg();
  const rows = await pgQuery<{
    answer: string;
    usage: OverviewUsage | null;
    model: string | null;
    sections: Record<string, string> | null;
  }>(
    `SELECT rs.answer, rs.usage, rs.model, rs.sections FROM run_summary rs
     WHERE rs.run_id = (SELECT run_id FROM knowledge WHERE thread_id = $1 AND kind = 'run' ORDER BY n DESC LIMIT 1)`,
    [threadId],
  );
  const reportRow = await pgQuery<{
    report: { title?: string; subtitle?: string; sections?: Array<{ id?: string; title?: string }> } | null;
  }>(
    `SELECT meta->'report' AS report FROM knowledge
     WHERE thread_id = $1 AND kind = 'run' ORDER BY n DESC LIMIT 1`,
    [threadId],
  );
  const reportMeta = reportRow?.[0]?.report ?? null;
  const report =
    reportMeta && Array.isArray(reportMeta.sections) && reportMeta.sections.length >= 2
      ? {
          title: String(reportMeta.title ?? ""),
          subtitle: reportMeta.subtitle ? String(reportMeta.subtitle) : undefined,
          sections: reportMeta.sections
            .filter((section) => section?.title != null)
            .map((section) => ({ id: String(section.id ?? ""), title: String(section.title ?? "") })),
        }
      : null;
  const sources = await pgQuery<{ n: number; url: string; title: string; host: string; favicon: string | null }>(
    `SELECT n, url, title, host, COALESCE(meta->>'favicon', '') AS favicon
     FROM knowledge
     WHERE kind = 'source_ref' AND thread_id = $1
       AND run_id = (SELECT run_id FROM knowledge WHERE thread_id = $1 AND kind = 'run' ORDER BY n DESC LIMIT 1)
     ORDER BY n`,
    [threadId],
  );
  const row = rows?.[0];
  const usage = row?.usage
    ? {
        model: row.model ?? null,
        input: row.usage.input ?? null,
        output: row.usage.output ?? null,
        thoughts: row.usage.thoughts ?? null,
        cached: row.usage.cached ?? null,
        rerank: row.usage.rerank,
      }
    : null;
  return {
    answer: String(row?.answer ?? "").replace(/\{\{zjs-gallery:\d+\}\}/g, ""),
    report,
    sections: (row?.sections ?? null) as Record<string, string> | null,
    sources: (sources ?? []).map((source) => ({
      n: Number(source.n) || 0,
      url: String(source.url ?? ""),
      title: String(source.title ?? ""),
      host: String(source.host ?? ""),
      favicon: String(source.favicon ?? ""),
    })),
    usage,
  };
}

/** Any knowledge row's full body (the listings carry the 600-char head
    excerpt only -- the inspector fetches the whole text on open). */
export async function loadItemBody(id: string): Promise<string> {
  const rows = await pgQuery<{ body: string }>("SELECT body FROM knowledge WHERE id = $1", [id]);
  return String((rows ?? [])[0]?.body ?? "");
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
