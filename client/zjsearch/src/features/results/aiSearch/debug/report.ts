// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  base,
  call,
  calls,
  GALLERY_IMAGE,
  settled,
  sourceBook,
  usage,
} from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "`纸飞机`三种折法对比与社团备赛方案";
const TITLE = "纸飞机三种折法对比与社团备赛方案";
const S = sourceBook();

const outline = (status: string[]): Record<string, unknown> => ({
  e: "outline",
  title: TITLE,
  subtitle: "折法、纸张与投掷:社团备赛的三条线",
  sections: [
    { id: "summary", title: "执行摘要", status: status[0] },
    { id: "s1", title: "折法对比:距离与滞空", status: status[1] },
    { id: "s2", title: "纸张与投掷角度", status: status[2] },
    { id: "s3", title: "场地与时间安排", status: status[3] },
    { id: "s4", title: "比赛日风险与备选方案", status: status[4] },
  ],
});

/** A REPORT mid-write, cut short on purpose: the run opens with two
    attachments and the depth probe, researches one round, then the write
    phase streams the outline and two sections (each with its reasoning
    reset) before the settle leaves three sections unwritten -- the
    failed-section state.  The stage's DEFAULT scenario. */
export const REPORT_STAGE: DebugScenario = {
  id: "report",
  name: "报告进行中",
  label: "report in progress (attachments · depth probe · outline · sections)",
  q: QUESTION,
  mode: "report",
  events: [
    {
      e: "client.start",
      runNo: 1,
      q: QUESTION,
      mode: "report",
      attachments: [
        {
          kind: "file",
          mime: "text/markdown",
          name: "活动计划.md",
          bytes: 96,
          data: "# 活动计划\n\n- 12 月 5 日在示例体育馆比赛\n- 每人限带 3 架,纸自备",
        },
        { kind: "image", mime: "image/svg+xml", name: "折法草图.svg", bytes: 480, data: GALLERY_IMAGE },
      ],
    },
    {
      e: "decisions",
      items: [
        {
          purpose: "depth_probe",
          question: "How deep and broad does the research need to be (score 0-4)?",
          target: QUESTION,
          answer: {
            type: "score",
            score: 3,
            probabilities: { "0": 0.01, "1": 0.04, "2": 0.18, "3": 0.52, "4": 0.25 },
            legend: { "3": "Thorough" },
            confidence: 0.52,
          },
          ms: 620,
        },
        {
          purpose: "outline",
          question: "The report skeleton: sections and the deliverable entities they cover",
          target: TITLE,
          sections: 5,
          entities: 3,
          uncovered: 1,
          ms: 1480,
        },
      ],
    },
    { ...base },
    { e: "phase", name: "plan" },
    { e: "say", id: 1, t: "拆成折法、纸张与投掷、场地时间三条线,先把实测数据找齐。" },
    calls(
      [
        call(1, "search_web", "纸飞机 折法 距离 滞空 对比", { query: "纸飞机 折法 距离 滞空 对比" }),
        call(2, "search_web", "A4 纸 克重 飞行距离", { query: "A4 纸 克重 飞行距离", category: "general" }),
      ],
      1,
    ),
    S.join({ round: 1, id: 1 }, "folds", "weight", "venue"),
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      n: 5,
      ms: 2395,
      feed: `plan: 5 deep + 5 shallow lines ${S.cite("folds", "weight")}…`,
    },
    {
      e: "call",
      id: 1,
      call: 2,
      status: "ok",
      n: 8,
      ms: 1870,
      feed: `plan: 5 deep + 5 shallow lines ${S.cite("venue")}…`,
    },
    {
      e: "findings",
      items: [
        {
          id: 1,
          text: `滑翔形平均飞行 **15.8 米**、滞空 6.4 秒${S.cite("folds")}。`,
          refs: [S.number("folds")],
          tags: ["折法"],
          status: "active",
          round: 1,
        },
      ],
      gaps: [],
    },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    { e: "think", id: 2, t: "摘要只收两条结论;折法一节先给对比表,再落到推荐;其余小节按计划逐个展开。" },
    outline(["writing", "pending", "pending", "pending", "pending"]),
    { e: "section", id: "summary", t: "先给结论,再说明依据;数字全部带引用。", think: true, reset: true },
    {
      e: "section",
      id: "summary",
      t: `**基线判断.** 三种折法里滑翔形最均衡:平均飞行 **15.8 米**、滞空 6.4 秒${S.cite("folds", "weight")};镖形出手快但落地早,特技形胜在稳定。\n\n**核心建议.** 比赛用 80g A4 纸折滑翔形,出手角度取 10 度;场地订示例体育馆的周末场,300 元/小时${S.cite("venue")}。`,
    },
    outline(["done", "writing", "pending", "pending", "pending"]),
    {
      e: "section",
      id: "s1",
      t: "先摆三种折法的实测表,再解释滑翔形为什么胜出;口径不一致的两份记录要如实说明。",
      think: true,
      reset: true,
    },
    {
      e: "section",
      id: "s1",
      t: `三种折法的差距集中在滞空一项:\n\n| 折法 | 平均距离 | 平均滞空 | 上手难度 |\n|---|---|---|---|\n| 镖形 | 12.4 米 | 3.1 秒 | 容易 |\n| 滑翔形 | 15.8 米 | 6.4 秒 | 中等 |\n| 特技形 | 8.2 米 | 4.8 秒 | 较难 |\n\n滑翔形两项都排第一,折叠步骤却只比特技形多两步${S.cite("folds")}。`,
    },
    outline(["done", "done", "writing", "pending", "pending"]),
    { e: "related", items: ["80g 纸会不会太重影响出手?", "示例体育馆的门口风大怎么办?", "特技形怎么折才能回旋?"] },
    // the settle lands with three sections still unwritten: they read as
    // failed sections (the rewrite chip's surface)
    settled(usage(21400, 1980, 1140, 9030)),
  ],
};
