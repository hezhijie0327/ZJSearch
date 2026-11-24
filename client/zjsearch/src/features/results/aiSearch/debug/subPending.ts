// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "调研纸飞机备赛:折法实测;纸张克重;投掷角度";
const SUBTASK = "折法实测对比";
const OBJECTIVE = "建立三种折法的距离与滞空实测矩阵(镖形/滑翔形/特技形)";

/** The run hits its time budget while a child is mid-search: the settle's
    interrupted sweep must reach the PENDING rows inside the sub row (the
    flat walk used to miss them). */
export const SUB_PENDING_STAGE: DebugScenario = {
  id: "sub-pending",
  name: "子代理中断",
  label: "sub pending at settle (the inner interrupted sweep)",
  q: QUESTION,
  mode: "deep",
  events: [
    { ...base },
    { e: "phase", name: "research" },
    calls([call(1, "delegate_research", SUBTASK, { title: SUBTASK, objective: OBJECTIVE })]),
    { e: "call", id: 1, call: 1, status: "ok", ms: 120, label: `S1 · ${SUBTASK}`, feed: OBJECTIVE },
    {
      e: "open",
      id: 10000,
      kind: "sub",
      round: 1,
      agent: "S1",
      title: `S1 · ${SUBTASK}`,
      objective: OBJECTIVE,
    },
    { e: "think", id: 10000, t: "子代理:先并行三种折法的实测检索。" },
    {
      ...calls(
        [
          call(1, "search_web", "镖形 纸飞机 实测 距离", { query: "镖形 纸飞机 实测 距离" }),
          call(2, "search_web", "滑翔形 纸飞机 实测 滞空", { query: "滑翔形 纸飞机 实测 滞空" }),
        ],
        10000,
      ),
      round: 1,
      turn: 1,
    },
    // the run DIES here: the settle's interrupted sweep must reach these
    // two pending child rows
    { e: "settle", status: "error", halt: "time_budget", finish: null, usage: null, model: null },
  ],
};
