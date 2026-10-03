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

/** The findings ledger's facts off a `learnings` wire event (the items
    array may be absent -- an absent list is an empty ledger). */
export function learningFacts(items: unknown): string[] {
  return Array.isArray(items) ? (items as unknown[]).map((fact) => String(fact ?? "")).filter(Boolean) : [];
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

/** The continue run's clarified direction: the interrupted run's question
    plus its recorded findings as the resume brief -- the researcher
    picks up the gaps instead of restarting. */
export function continueBrief(q: string, learnings: string[]): string {
  const findings = learnings.map((fact) => `- ${fact}`).join("\n");
  return (
    `这是对上一轮被中断调研的继续(同一问题,不要从头开始):「${q}」。` +
    `中断前已确立的研究发现:\n${findings || "(暂无记录)"}\n` +
    `从中断处继续:覆盖尚未研究的面,不要重复已搜索过的角度。`.slice(0, 2000)
  );
}
