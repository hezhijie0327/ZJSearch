// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, settled, sourceBook, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "对比三种纸飞机折法的距离与滞空";
const S = sourceBook();
// round 2's record_findings arguments cite a page that round gathers
S.reserve("folds", "records", "angle");

/** The user steers a live run: a guide injected at the round boundary, a
    preempt that lands before the writer takes over, and a third one that
    never gets delivered. */
export const STEER_STAGE: DebugScenario = {
  id: "steer",
  name: "引导注入",
  label: "guide (boundary injection · preempt · undelivered)",
  q: QUESTION,
  mode: "balanced",
  events: [
    { e: "client.start", q: QUESTION, runNo: 1, mode: "balanced", startedAt: 0 },
    { e: "phase", name: "plan" },
    { ...base },
    { e: "say", id: 1, t: "先并行找三组实测:距离、滞空和往届成绩。" },
    calls(
      [
        call(1, "search_web", "纸飞机 折法 距离 实测", { query: "纸飞机 折法 距离 实测" }),
        call(2, "search_web", "纸飞机 折法 滞空 时间", { query: "纸飞机 折法 滞空 时间" }),
      ],
      1,
    ),
    S.join({ round: 1, id: 1 }, "folds", "records"),
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      n: 8,
      ms: 1834,
      feed: `plan: 5 deep + 5 shallow lines ${S.cite("folds", "records")}…`,
    },
    {
      e: "call",
      id: 1,
      call: 2,
      status: "ok",
      n: 6,
      ms: 2210,
      feed: `plan: 4 deep + 2 shallow lines ${S.cite("records")}…`,
    },
    { e: "close", id: 1 },
    { e: "steer", text: "重点看滑翔形,其余两种一笔带过就行", delivery: "guide", status: "drained" },
    { ...base, id: 2, round: 2 },
    { e: "say", id: 2, t: "收到引导:以滑翔形为主,补它的滞空数据和往届成绩。" },
    calls(
      [
        call(1, "search_web", "滑翔形 纸飞机 滞空 实测", { query: "滑翔形 纸飞机 滞空 实测" }),
        call(2, "record_findings", "2 条", {
          facts: [
            { text: `滑翔形平均滞空 **6.4 秒**${S.cite("angle")}`, refs: [S.number("angle")] },
            { text: `去年冠军用滑翔形飞出 18.6 米${S.cite("records")}`, refs: [S.number("records")] },
          ],
        }),
      ],
      2,
    ),
    S.join({ round: 2, id: 2 }, "angle"),
    {
      e: "call",
      id: 2,
      call: 1,
      status: "ok",
      n: 7,
      ms: 1450,
      feed: `plan: 5 deep + 2 shallow lines ${S.cite("angle")}…`,
    },
    { e: "call", id: 2, call: 2, status: "ok", n: 2, ms: 640, feed: "ledger: +2 facts" },
    { e: "close", id: 2 },
    { e: "steer", text: "别管滞空了,只比飞行距离", delivery: "preempt", status: "drained" },
    { e: "steer", text: "顺便加一段往届冠军的数据", delivery: "guide", status: "discarded" },
    { e: "open", id: 3, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "answer",
      t: `按最新引导,只比**飞行距离**(滞空折叠为背景):\n\n- **滑翔形**:平均 **15.8 米**,三种折法里最远${S.cite("folds")};\n- **镖形**:12.4 米,出手快但落地早${S.cite("folds")};\n- **特技形**:8.2 米,胜在稳定${S.cite("folds")}。\n\n往届冠军数据未纳入本轮(那条引导没有送达)。`,
    },
    { e: "close", id: 3 },
    { e: "related", items: ["滑翔形怎么折才飞得更远?", "镖形适合比什么项目?"] },
    { e: "title", text: "三种纸飞机的距离对比" },
    settled(usage(9210, 380, 540, 4880)),
  ],
};
