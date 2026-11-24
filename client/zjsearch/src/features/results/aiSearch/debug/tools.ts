// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  CALENDAR_DATE,
  CALENDAR_FIND,
  CALENDAR_NOW,
  CALENDAR_TERMS,
} from "@/features/results/aiSearch/debug/calendar.ts";
import { base, call, calls, settled, sourceBook, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "纸飞机比赛日安排在哪天合适?";
const S = sourceBook();
// the table and the image call cite pages their own round gathers: number
// them before the events are built
S.reserve("folds", "weight", "venue");

const VERDICT = {
  best: {
    type: "choice",
    choice: "滑翔形",
    probabilities: { 滑翔形: 0.81, 镖形: 0.14, 特技形: 0.05 },
    confidence: 0.81,
  },
};

const TABLE = {
  title: "三种折法实测对比",
  columns: ["折法", "平均距离", "平均滞空", "上手难度"],
  rows: [
    { cells: ["镖形", "12.4 米", "3.1 秒", "容易"] },
    { cells: ["滑翔形", "15.8 米", "6.4 秒", "中等"] },
    { cells: ["特技形", "8.2 米", "4.8 秒", "较难"] },
  ],
  note: "社团 20 次投掷的平均值",
};

/** The DETERMINISTIC tools in one round: calculate, the clock, the
    calendar's four modes (now · date · auspicious-day scan · term
    vocabulary), evaluate, build_table (ok with its artifact, and the
    error), inspect_image, an ask_user that only records, the four memory
    verbs and an MCP call -- closed by the round's decision card. */
export const TOOLS_STAGE: DebugScenario = {
  id: "tools",
  name: "确定性工具",
  label: "calculate · clock · calendar ×4 · evaluate · table · image · memory · mcp · decisions",
  q: QUESTION,
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: QUESTION, mode: "balanced" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "先用日历看比赛日,再把折法数据算一遍、记下来。" },
    calls(
      [
        call(1, "calculate", "12.4 + 3.4", { expression: "12.4 + 3.4", precision: 4 }),
        call(2, "clock", "", {}),
        call(3, "calendar", "12-05", { date: "12-05" }),
        call(4, "calendar", "宴会", { find_suited: "宴会" }),
        call(5, "calendar", "", { list_terms: true }),
        call(6, "evaluate", "哪种折法最适合比赛", {
          questions: [{ name: "best", instructions: "哪种折法最适合比赛?", type: "choice" }],
        }),
        call(7, "build_table", TABLE.title, {
          title: TABLE.title,
          columns: TABLE.columns,
          rows: [
            { ...TABLE.rows[0], refs: [S.number("folds")] },
            { ...TABLE.rows[1], refs: [S.number("folds"), S.number("weight")] },
            { ...TABLE.rows[2], refs: [S.number("folds")] },
          ],
          note: TABLE.note,
        }),
        call(8, "build_table", "", { title: "缺少列的表" }),
        call(9, "inspect_image", "", { url: "https://lab.example.org/angle-chart.png", n: S.number("folds") }),
        call(10, "ask_user", "", {
          intro: "报告更偏比赛策略还是活动筹备?",
          questions: [{ q: "报告的主要用途?", type: "single", options: ["比赛策略", "活动筹备", "社团招新"] }],
        }),
        call(11, "memory", "纸飞机", { action: "search", query: "纸飞机" }, "search"),
        call(12, "memory", "", { action: "save", kind: "fact", content: "用户是学校纸飞机社团成员" }, "save"),
        call(
          13,
          "memory",
          "",
          { action: "update", target: "纸飞机社团", content: "用户在社团里负责比赛报名" },
          "update",
        ),
        call(14, "memory", "", { action: "save", content: "用户偏好表格对比" }, "reinforce"),
        call(15, "mcp", "示例体育馆", { address: "示例体育馆" }, "demo_maps_geo"),
      ],
      1,
    ),
    S.join({ round: 1, id: 1 }, "folds", "weight", "venue"),
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      ms: 3,
      result: "15.8",
      feed: '{"expression": "12.4 + 3.4", "result": "15.8"}',
    },
    {
      e: "call",
      id: 1,
      call: 2,
      status: "ok",
      ms: 2,
      calendar: CALENDAR_NOW,
      feed: JSON.stringify({ clock: CALENDAR_NOW }),
    },
    {
      e: "call",
      id: 1,
      call: 3,
      status: "ok",
      ms: 2,
      calendar: CALENDAR_DATE,
      feed: JSON.stringify({ calendar: CALENDAR_DATE }),
    },
    {
      e: "call",
      id: 1,
      call: 4,
      status: "ok",
      ms: 6,
      calendar: CALENDAR_FIND,
      feed: JSON.stringify({ calendar: CALENDAR_FIND }),
    },
    {
      e: "call",
      id: 1,
      call: 5,
      status: "ok",
      ms: 40,
      calendar: CALENDAR_TERMS,
      feed: JSON.stringify({ calendar: CALENDAR_TERMS }),
    },
    {
      e: "call",
      id: 1,
      call: 6,
      status: "ok",
      ms: 940,
      result: "choice: 滑翔形 (p=0.81)",
      answers: VERDICT,
      preview: "best: 滑翔形 (p=0.81)",
    },
    { e: "call", id: 1, call: 7, status: "ok", n: TABLE.rows.length, ms: 6, feed: "table 1 recorded" },
    {
      e: "call",
      id: 1,
      call: 8,
      status: "error",
      ms: 2,
      feed: "error: build_table needs a title, 2+ columns and at least one row -- a table the writer can cite.",
    },
    {
      e: "call",
      id: 1,
      call: 9,
      status: "ok",
      ms: 1200,
      preview: "https://lab.example.org/angle-chart.png",
      feed: `image attached (inline) -- it is visible to you in the next turn (source ${S.cite("folds")}).`,
    },
    {
      e: "call",
      id: 1,
      call: 10,
      status: "ok",
      ms: 300,
      feed: "ask recorded -- the run continues on the user's best interpretation",
    },
    { e: "call", id: 1, call: 11, status: "ok", n: 1, ms: 4, preview: "- 用户是学校纸飞机社团成员" },
    {
      e: "call",
      id: 1,
      call: 12,
      status: "ok",
      ms: 6,
      label: "用户是学校纸飞机社团成员",
      feed: "saved: 用户是学校纸飞机社团成员",
    },
    {
      e: "call",
      id: 1,
      call: 13,
      status: "ok",
      ms: 5,
      label: "用户在社团里负责比赛报名",
      feed: "updated: 用户在社团里负责比赛报名",
    },
    {
      e: "call",
      id: 1,
      call: 14,
      status: "ok",
      ms: 3,
      label: "用户偏好表格对比",
      feed: "reinforced: 用户偏好表格对比",
    },
    {
      e: "call",
      id: 1,
      call: 15,
      status: "ok",
      ms: 460,
      preview:
        '{\n  "country": "示例国",\n  "province": "示例省",\n  "city": "示例市",\n  "district": "城东区",\n  "adcode": "000000",\n  "location": "0.0000,0.0000"\n}',
    },
    { e: "artifact", id: 1, item: TABLE },
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
          ms: 812,
        },
        {
          purpose: "evaluate",
          question: "哪种折法最适合比赛?",
          target: "折法对比:距离与滞空",
          answers: VERDICT,
          record_questions: [{ name: "best", instructions: "哪种折法最适合比赛?" }],
          ms: 940,
        },
        {
          purpose: "coverage",
          question: "Per open subtask: covered by this round's new sources (noul 0-1, above threshold suggests done)",
          target: "折法对比:距离与滞空 / 纸张与投掷角度",
          answers: { task_0: { noul: 0.86, type: "noul" }, task_1: { noul: 0.74, type: "noul" } },
          ms: 583,
        },
        {
          purpose: "entity_coverage",
          question: "Deliverable entities the answer makes claims about; screened against the plan",
          target: "滑翔形 / 示例体育馆",
          answer: {
            task_0: { choice: "covered", confidence: 1, probabilities: { covered: 1, uncovered: 0 }, type: "choice" },
            task_1: { choice: "uncovered", confidence: 1, probabilities: { covered: 0, uncovered: 1 }, type: "choice" },
          },
          record_questions: [
            { name: "task_0", instructions: "滑翔形 -- the recommended fold rests on its distance and airtime" },
            { name: "task_1", instructions: "示例体育馆 -- no subtask studied its booking rules" },
          ],
          ms: 120,
        },
        {
          purpose: "citation_gate",
          question: "Spot check: are the sampled citations supported by their sources?",
          target: "折法对比:距离与滞空",
          answer: { c_1: "supported" },
          record_questions: [
            {
              name: "citation_gate",
              instructions: "Spot check: are the sampled citations supported by their sources?",
            },
          ],
          ms: 640,
        },
      ],
    },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "answer",
      t: `比赛日定在 **12 月 5 日(周六)**最合适:它正是黄历里宜「宴会」的日子,赛后聚餐可以排在同一天。场地订示例体育馆的周末场,300 元/小时${S.cite("venue")}。`,
    },
    { e: "close", id: 2 },
    { e: "related", items: ["12 月还有哪些天宜宴会?", "体育馆周末场怎么预约?"] },
    settled(usage(9600, 420, 360, 5100)),
  ],
};
