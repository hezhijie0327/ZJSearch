// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { AiSearchRun } from "@/features/results/aiSearch/timeline.ts";

/**
 * The findings-ledger / task-list state helpers of the AI Search fold:
 * the PURE pieces of the wire-event reducer that own the run's ledger
 * surfaces -- the task card's snapshot merge, the findings facts, the
 * settle-time task completion (the honest done/missed flip), the clarify
 * answer grammar and the continue run's brief.  timeline.ts calls them
 * from its event cases; keeping them here lets the ledger rules be read
 * (and changed) without wading through the wire plumbing.
 */

/** Parse the clarify answer text ("1. Question：Answer" lines + a trailing
    free-text note) into Q/A pairs -- the same grammar the rail's
    ClarifySegment renders. */
export function parseClarifyPairs(text: string): Array<{ q: string; a: string }> {
  const pairs: Array<{ q: string; a: string }> = [];
  let note = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^(?:\d+[.、]\s*)?(.+?)[：:]\s*(.+)$/.exec(trimmed);
    if (match?.[1] && match[2]) {
      pairs.push({ q: match[1].trim(), a: match[2].trim() });
    } else {
      note = (note ? `${note} ` : "") + trimmed;
    }
  }
  if (note) {
    pairs.push({ q: "", a: note });
  }
  return pairs;
}

/** The task card's AUTHORITATIVE snapshot merge: the wire `tasks` event
    replaces the list wholesale, but a task's research provenance (its
    steps and findings, LEGACY-era fields) survives the replace when the
    title matches. */
export function mergeTaskSnapshot(
  existing: AiSearchRun["tasks"],
  items: Array<Record<string, unknown>>,
): AiSearchRun["tasks"] {
  return items.map((item) => {
    const prior = existing.find((task) => task.title === String(item.title ?? ""));
    return {
      title: String(item.title ?? ""),
      status: String(item.status ?? "pending") as "pending" | "active" | "done",
      sources: Array.isArray(item.sources) ? item.sources.map((n) => Number(n) || 0).filter((n) => n > 0) : undefined,
      steps: prior?.steps ?? [],
      findings: prior?.findings,
    };
  });
}

/** One ledger FACT (the learnings tool's v2 shape): revisable -- a later
    fact may supersede or retract it; only active facts reach the writer. */
export interface LedgerFact {
  id: number;
  text: string;
  refs: number[];
  status: "active" | "superseded" | "retracted";
  round?: number;
  /** the id of an established fact this one CONFLICTS with (the audit's
      consistency scan) -- the findings card renders the ⚡ */
  conflict_with?: number;
}

/** One ledger GAP: the open questions the research still owes an answer
    to -- the findings card renders them under the facts, the continue
    brief hands them to the resumed run. */
export interface LedgerGap {
  id: number;
  q: string;
  why?: string;
  status: "open" | "closed";
  close_as?: string;
  round?: number;
}

/** The findings ledger off a `learnings` wire event: the v2 items are
    fact objects (with ids/revision status); a stored legacy thread's
    plain-string facts type-dispatch into bare active facts.  An absent
    list is an empty ledger. */
export function learningFacts(items: unknown): LedgerFact[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return (items as unknown[])
    .map((fact, index): LedgerFact | null => {
      if (typeof fact === "string") {
        return fact.trim() ? { id: index + 1, text: fact, refs: [], status: "active" as const } : null;
      }
      if (!fact || typeof fact !== "object") {
        return null;
      }
      const record = fact as Record<string, unknown>;
      const text = String(record.text ?? "").trim();
      if (!text) {
        return null;
      }
      return {
        id: Number(record.id) || index + 1,
        text,
        refs: Array.isArray(record.refs) ? record.refs.map((n) => Number(n) || 0).filter((n) => n > 0) : [],
        status: record.status === "superseded" || record.status === "retracted" ? record.status : "active",
        round: typeof record.round === "number" ? record.round : undefined,
        conflict_with: typeof record.conflict_with === "number" ? record.conflict_with : undefined,
      };
    })
    .filter((fact): fact is LedgerFact => fact !== null);
}

/** The ledger's gaps partition off a `learnings` wire event. */
export function learningGaps(gaps: unknown): LedgerGap[] {
  if (!Array.isArray(gaps)) {
    return [];
  }
  return (gaps as unknown[])
    .map((gap, index): LedgerGap | null => {
      if (!gap || typeof gap !== "object") {
        return null;
      }
      const record = gap as Record<string, unknown>;
      const q = String(record.q ?? "").trim();
      if (!q) {
        return null;
      }
      return {
        id: Number(record.id) || index + 1,
        q,
        why: String(record.why ?? "") || undefined,
        status: record.status === "closed" ? ("closed" as const) : ("open" as const),
        close_as: String(record.close_as ?? "") || undefined,
        round: typeof record.round === "number" ? record.round : undefined,
      };
    })
    .filter((gap): gap is LedgerGap => gap !== null);
}

/** The task card's settle completion, HONESTLY: a subtask with sources
    is done; one that never gathered a source stays visibly unresearched. */
export function completeTasks(tasks: AiSearchRun["tasks"]): AiSearchRun["tasks"] {
  return tasks.map((task) =>
    task.status === "done" || (task.sources?.length ?? 0) > 0
      ? { ...task, status: "done" as const }
      : { ...task, status: "missed" as const },
  );
}

/** The continue run's clarified direction: the interrupted run's question,
    its recorded facts AND its open gaps as the resume brief -- the
    researcher picks up exactly where the ledger stands instead of
    restarting. */
export function continueBrief(q: string, learnings: LedgerFact[], gaps: LedgerGap[] = []): string {
  const findings = learnings
    .filter((fact) => fact.status === "active")
    .map((fact) => `- ${fact.text}`)
    .join("\n");
  const open = gaps
    .filter((gap) => gap.status === "open")
    .map((gap) => `- ${gap.q}`)
    .join("\n");
  // model-facing prompt block: ENGLISH only (every prompt block is -- which
  // language the ANSWER takes is the language_directive's business, not the
  // block's); the quoted task titles / findings stay in their own language:
  // content
  return (
    `This continues the previous INTERRUPTED research (same question -- do` +
    ` not start over): "${q}".\n` +
    `Established findings before the interruption:\n${findings || "(none recorded)"}\n` +
    (open ? `Unresolved gaps:\n${open}\n` : "") +
    `Continue from where it stopped: cover the unresearched facets; do not` +
    ` repeat angles already searched.`
  ).slice(0, 2000);
}
