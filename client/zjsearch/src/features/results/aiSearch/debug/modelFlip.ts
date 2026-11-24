// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, settled, sourceBook, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "帮我调研一下纸飞机比赛的备赛方案";
const TITLE = "纸飞机比赛备赛方案调研报告";
const S = sourceBook();

const SECTIONS = [
  { id: "summary", title: "执行摘要" },
  { id: "s1", title: "折法与纸张的选择" },
  { id: "s2", title: "投掷角度与练习安排" },
  { id: "s3", title: "场地与时间安排" },
];

const outline = (status: string[]): Record<string, unknown> => ({
  e: "outline",
  title: TITLE,
  subtitle: "",
  sections: SECTIONS.map((section, index) => ({ ...section, status: status[index] })),
});

/** A balanced run the MODEL flips to a report mid-research through
    set_deliverable: the settled row folds the mode forward, and the write
    phase streams a report outline section by section. */
export const MODEL_FLIP_STAGE: DebugScenario = {
  id: "model-flip",
  name: "交付翻转",
  label: "set_deliverable flip (balanced → report)",
  q: QUESTION,
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: QUESTION, mode: "balanced" },
    { ...base },
    { e: "phase", name: "plan" },
    { e: "say", id: 1, t: "这个问题有四个面,值得出一份报告:先定结构,再补材料。" },
    calls(
      [
        call(1, "search_web", "纸飞机 比赛 备赛 折法", { query: "纸飞机 比赛 备赛 折法" }),
        call(2, "set_deliverable", "report", { shape: "report" }),
      ],
      1,
    ),
    S.join({ round: 1, id: 1 }, "folds", "weight"),
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      n: 2,
      ms: 2140,
      feed: `plan: 5 deep lines ${S.cite("folds", "weight")}`,
    },
    {
      e: "call",
      id: 1,
      call: 2,
      status: "ok",
      q: "report",
      ms: 1730,
      feed: `deliverable shape set to report: an outline of 4 sections ("${TITLE}") was minted. Keep researching exactly as planned -- every source you gather is what the sections will cite; the document itself is written at the write phase.`,
    },
    { e: "close", id: 1 },
    { ...base, id: 2, round: 2 },
    { e: "think", id: 2, t: "报告结构已定,补投掷角度和场馆两块材料。" },
    calls(
      [
        call(1, "search_web", "纸飞机 投掷角度 滞空", { query: "纸飞机 投掷角度 滞空" }),
        call(2, "search_web", "示例体育馆 租用 价格", { query: "示例体育馆 租用 价格" }),
      ],
      2,
    ),
    S.join({ round: 2, id: 2 }, "angle", "venue"),
    { e: "call", id: 2, call: 1, status: "ok", n: 3, ms: 1810, feed: `plan: 5 deep lines ${S.cite("angle")}` },
    { e: "call", id: 2, call: 2, status: "ok", n: 4, ms: 1620, feed: `plan: 4 deep lines ${S.cite("venue")}` },
    { e: "close", id: 2 },
    { e: "open", id: 3, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    { e: "think", id: 3, t: "摘要收两条结论;每节先给依据再给可执行的做法。" },
    outline(["done", "writing", "pending", "pending"]),
    {
      e: "section",
      id: "summary",
      t: `**基线判断.** 备赛的胜负手是折法与纸张:滑翔形配 80g A4 纸,平均能飞 **15.8 米**${S.cite("folds", "weight")}。出手角度和场地是第二位的影响因素${S.cite("angle", "venue")}。`,
    },
    {
      e: "section",
      id: "s1",
      t: `三种折法里滑翔形两项都排第一:距离 15.8 米、滞空 6.4 秒${S.cite("folds")}。\n\n> [!IMPORTANT] 纸张的选择\n> 80g 纸比 70g 纸平均多飞 1.8 米${S.cite("weight")},但更难折出锐利的折痕,练习时要先用骨刀压线。`,
    },
    outline(["done", "done", "writing", "pending"]),
    {
      e: "section",
      id: "s2",
      t: `投掷角度取 **10 度**时滞空最久,取 45 度时距离最远${S.cite("angle")}。比赛比距离,练习以 40 至 45 度为主,每轮 20 次投掷并记录。`,
    },
    {
      e: "section",
      id: "s3",
      t: `示例体育馆周末场 **300 元/小时**,含 20 张折叠桌,需提前三天预约${S.cite("venue")}。比赛日是 12 月 5 日(周六),建议赛前两周每周五下午进场练习。`,
    },
    outline(["done", "done", "done", "done"]),
    { e: "related", items: ["滑翔形分步骤怎么折?", "比赛日下雨有备选场地吗?"] },
    settled(usage(11200, 890, 620, 3600)),
  ],
};
