// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, sourceBook, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "纸飞机比赛日的流程安排";
const TITLE = "纸飞机比赛日流程安排";
const S = sourceBook();

const outline = (status: string[]): Record<string, unknown> => ({
  e: "outline",
  title: TITLE,
  subtitle: "签到、比赛与颁奖的时间线",
  sections: [
    { id: "summary", title: "执行摘要", status: status[0] },
    { id: "s1", title: "签到与热身", status: status[1] },
    { id: "s2", title: "比赛与颁奖", status: status[2] },
  ],
});

/** One section dies mid-sentence when the run settles (the failed-section
    chip appears); clicking REWRITE re-streams that section after the
    settle -- the post-settle lane. */
export const REWRITE_STAGE: DebugScenario = {
  id: "rewrite",
  name: "章节重写",
  label: "failed section → rewrite (report, post-settle lane)",
  q: QUESTION,
  mode: "report",
  events: [
    { e: "client.start", runNo: 1, q: QUESTION, mode: "report" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "两条线:场馆的开放时间,以及往届比赛日的实际流程。" },
    calls(
      [
        call(1, "search_web", "示例体育馆 开放时间 预约", { query: "示例体育馆 开放时间 预约" }),
        call(2, "search_web", "纸飞机 比赛 流程 往届", { query: "纸飞机 比赛 流程 往届" }),
      ],
      1,
    ),
    S.join({ round: 1, id: 1 }, "venue", "records"),
    { e: "call", id: 1, call: 1, status: "ok", n: 4, ms: 1650, feed: `plan: 5 deep lines ${S.cite("venue")}` },
    { e: "call", id: 1, call: 2, status: "ok", n: 3, ms: 1490, feed: `plan: 5 deep lines ${S.cite("records")}` },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    { e: "think", id: 2, t: "按时间线写:签到热身在前,比赛颁奖在后,每段给出具体时间点。" },
    outline(["writing", "pending", "pending"]),
    {
      e: "section",
      id: "summary",
      t: `**基线判断.** 比赛日分三段:**9:00 签到热身,10:00 开始比赛,12:00 颁奖**。场地订上午场,200 元/小时${S.cite("venue")}。`,
    },
    {
      e: "section",
      id: "s1",
      t: `签到台设在一楼东侧,领取号码牌和 3 张 80g A4 纸${S.cite("venue")}。热身区用 6 张折叠桌,每人试投 5 次,不计成绩。`,
    },
    { e: "section", id: "s2", t: "比赛按组别轮流上场,每人投 3 次取最远的一次;" },
    { e: "settle", status: "done", finish: "stop", usage: usage(9820, 640, 260, 4110), model: "demo-model" },
    outline(["done", "done", "writing"]),
    {
      e: "section",
      id: "s2",
      reset: true,
      t: `比赛按组别轮流上场,每人投 3 次取最远的一次;两组之间留 10 分钟捡飞机。颁奖在 12:00,前三名各得一包彩纸;往届冠军的成绩是 18.6 米${S.cite("records")}。`,
    },
    outline(["done", "done", "done"]),
  ],
};
