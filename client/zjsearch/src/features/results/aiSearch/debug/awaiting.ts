// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, settled, sourceBook, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "帮我调研一下纸飞机怎么折飞得远";

/** The clarify gate: the run parks `awaiting` on an open-ended question.
    Answer the card in the stage and `clarifyTail` replays the rest. */
export const AWAITING_STAGE: DebugScenario = {
  id: "awaiting",
  name: "澄清门",
  label: "clarify gate (awaiting)",
  q: QUESTION,
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: QUESTION, mode: "balanced" },
    { ...base },
    { e: "phase", name: "plan" },
    {
      e: "ask",
      intro: "「飞得远」有几种比法,范围需要先对齐:",
      questions: [
        { q: "更看重哪个指标?", type: "multi", options: ["飞行距离", "滞空时间", "特技动作"] },
        { q: "是室内比赛还是户外玩耍?", type: "single", options: ["室内比赛", "户外玩耍"] },
      ],
    },
    { e: "settle", status: "awaiting", halt: "awaiting the user's direction", finish: null, usage: null, model: null },
  ],
  // the tail is built per answer, so the book numbers the pages it joins
  clarifyTail: (transcript) => {
    const tail = sourceBook();
    return [
      { e: "client.clarify", text: transcript, startedAt: Date.now(), mode: "balanced" },
      { ...base, id: 2 },
      { e: "phase", name: "research" },
      { e: "say", id: 2, t: "按确认的方向收窄:室内比赛、比飞行距离,折法与纸张两条线并行。" },
      calls(
        [
          call(1, "search_web", "纸飞机 折法 室内 距离", { query: "纸飞机 折法 室内 距离" }),
          call(2, "search_web", "A4 纸 克重 飞行距离", { query: "A4 纸 克重 飞行距离" }),
        ],
        2,
      ),
      tail.join({ round: 1, id: 1 }, "folds", "weight"),
      {
        e: "call",
        id: 2,
        call: 1,
        status: "ok",
        n: 6,
        ms: 1620,
        feed: `plan: 5 deep + 5 shallow lines ${tail.cite("folds")}`,
      },
      { e: "call", id: 2, call: 2, status: "ok", n: 4, ms: 1735, feed: `plan: 5 deep lines ${tail.cite("weight")}` },
      {
        e: "findings",
        items: [
          {
            id: 1,
            text: `80g 纸比 70g 纸平均多飞 1.8 米${tail.cite("weight")}。`,
            refs: [tail.number("weight")],
            status: "active",
            round: 2,
          },
        ],
        gaps: [],
      },
      {
        e: "plan",
        items: [
          { title: "折法对比", status: "done", sources: [tail.number("folds")] },
          { title: "纸张与投掷", status: "done", sources: [tail.number("weight")] },
        ],
      },
      { e: "close", id: 2 },
      { e: "open", id: 3, kind: "write", round: 0 },
      { e: "phase", name: "write" },
      {
        e: "answer",
        t: `从**室内比赛**的角度,答案分两层:\n\n- **折法**:选滑翔形,翼面宽、滞空久,距离与稳定性最均衡${tail.cite("folds")};\n- **纸张**:用 80g 的 A4 纸,比 70g 平均多飞 1.8 米${tail.cite("weight")}。\n\n特技动作与户外玩法不在本轮范围内。`,
      },
      { e: "close", id: 3 },
      { e: "related", items: ["滑翔形怎么折才不容易俯冲?", "80g 纸会不会太硬不好折?"] },
      settled(usage(6840, 186, 140, 2100)),
    ];
  },
};
