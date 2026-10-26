// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The DOMAIN PRIMERS (the episodic->semantic consolidation's document
    layer): when the same topic cluster keeps coming back, the run's
    contributions distill into ONE living document instead of scattering
    across threads -- the human researcher's territory map.  A primer is
    a knowledge row (kind='document', meta.primer) so the existing
    recall funnel (hybrid search, recall_history, the panel) carries it
    with zero new injection code; it is user-visible, editable and
    deletable like any document.  Fire-and-forget like every write:
    failure = console warn. */

import { embedPending } from "@/lib/kb/projections.ts";
import { enqueue, type KnowledgeItem } from "@/lib/kb/shared.ts";
import { pgQuery } from "@/lib/pg.ts";

/** The recurrence threshold: the cluster's third run mints the primer
    (two prior runs + this one) -- earlier would mint primers for every
    passing topic. */
const PRIMER_MINT_RUNS = 3;

const PRIMER_BODY_CAP = 6000;

/** The run's contribution line: what THIS run added, one line. */
function contributionLine(runTitle: string, answerHead: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const head = answerHead.replace(/\s+/g, " ").trim().slice(0, 200);
  return `- [${date}] ${runTitle.trim().slice(0, 120) || "(untitled run)"}${head ? ` -- ${head}` : ""}`;
}

/** The settle-time consolidation: `run.tags` names the cluster (the
    extractor's concept tags, already normalized to the user's
    language); a primer for the cluster is appended to or minted from
    the run's own contribution. */
export function consolidatePrimer(run: { tags?: string[]; title?: string; answer?: string }): void {
  const cluster = (run.tags ?? [])
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    .slice(0, 6);
  if (cluster.length === 0) {
    return;
  }
  const line = contributionLine(run.title ?? "", run.answer ?? "");
  void enqueue(async () => {
    const existing = await pgQuery<{ id: string; body: string }>(
      `SELECT id, body FROM knowledge
       WHERE kind = 'document' AND meta->>'primer' = '1' AND tags ?| $1::text[]
       ORDER BY updated DESC LIMIT 1`,
      [cluster],
    );
    const found = (existing ?? [])[0];
    if (found) {
      if (found.body.includes(line) || found.body.length >= PRIMER_BODY_CAP) {
        return; // the contribution already landed, or the primer is full
      }
      await pgQuery("UPDATE knowledge SET body = $1, updated = $2 WHERE id = $3", [
        `${found.body}\n${line}`,
        Date.now(),
        found.id,
      ]);
      return;
    }
    // the recurrence check: this cluster has run hot enough to deserve
    // a territory map (the CURRENT run's row included)
    const siblings = await pgQuery<{ n: string }>(
      `SELECT count(*) AS n FROM knowledge
       WHERE kind = 'run' AND tags ?| $1::text[]`,
      [cluster],
    );
    if (Number((siblings ?? [])[0]?.n ?? 0) < PRIMER_MINT_RUNS) {
      return;
    }
    await pgQuery(
      `INSERT INTO knowledge (id, kind, title, body, meta, tags, search_text, created, updated, occurred_at)
       SELECT $1, 'document', $2, $3, $4::jsonb, $5::jsonb, $6, $7, $7, $7
       WHERE NOT EXISTS (SELECT 1 FROM knowledge WHERE meta->>'primer' = '1' AND title = $2)`,
      [
        `primer:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        `${cluster[0]} · primer`,
        `# ${cluster[0]}\n\n${line}`,
        JSON.stringify({ primer: "1" }),
        JSON.stringify(cluster),
        cluster.join(" ").slice(0, 300),
        Date.now(),
      ],
    );
    void embedPending();
  });
}

/** The panel's primer listing aid (kept near the write path): primers
    are plain documents to every reader. */
export function isPrimer(item: KnowledgeItem): boolean {
  return item.meta?.primer === "1";
}
