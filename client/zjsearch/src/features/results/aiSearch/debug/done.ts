// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, settled, sourceBook, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "纸飞机用多重的纸飞得最远?";
const S = sourceBook();

/** A lookup-shaped question answered after ONE research round: the
    duplicate settle (a re-search whose hits were all numbered already)
    beside a normal one, then the single write. */
export const DONE_STAGE: DebugScenario = {
  id: "done",
  name: "单轮作答",
  label: "single-write done (balanced)",
  q: QUESTION,
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: QUESTION, mode: "balanced" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "这是一个查数型问题,一轮两条检索即可。" },
    calls([
      call(1, "search_web", "A4 纸 克重 纸飞机 距离", { query: "A4 纸 克重 纸飞机 距离" }),
      call(2, "search_web", "纸张重量 滑翔 距离", { query: "纸张重量 滑翔 距离" }),
    ]),
    S.join({ round: 1, id: 1 }, "weight"),
    { e: "call", id: 1, call: 1, status: "ok", n: 4, ms: 1420, feed: `plan: 5 deep lines ${S.cite("weight")}` },
    {
      e: "call",
      id: 1,
      call: 2,
      status: "duplicate",
      ms: 1300,
      dupes: [S.number("weight")],
      feed: `duplicate: all hits already numbered ${S.cite("weight")}`,
    },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    { e: "think", id: 2, t: "只有一条实测来源,直接给数字并标明条件。" },
    {
      e: "answer",
      t: `在社团的实测里,**80g 的 A4 纸**飞得最远:同样折成滑翔形,比 70g 纸平均多飞 **1.8 米**(15.8 米对 14.0 米),滞空也多 0.8 秒${S.cite("weight")}。`,
    },
    { e: "close", id: 2 },
    settled(usage(4210, 186, 220, 2048)),
  ],
};
