// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, sourceBook } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "对比三种纸飞机折法的抗风性";
const S = sourceBook();

/** The reader pressed STOP mid-round: the pending row is swept to
    `interrupted`, no answer ever arrives. */
export const STOPPED_STAGE: DebugScenario = {
  id: "stopped",
  name: "已停止",
  label: "stopped state (title keying)",
  q: QUESTION,
  mode: "report",
  events: [
    { e: "client.start", runNo: 1, q: QUESTION, mode: "report" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "先找带风速标注的实测,再补社团自己的实验记录。" },
    calls([call(1, "search_web", "纸飞机 抗风 风速 实测", { query: "纸飞机 抗风 风速 实测" })]),
    S.join({ round: 1, id: 1 }, "angle"),
    { e: "settle", status: "error", halt: "stopped_by_user", finish: null, usage: null, model: null },
  ],
};
