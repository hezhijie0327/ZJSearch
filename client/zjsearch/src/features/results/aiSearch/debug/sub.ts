// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  base,
  call,
  calls,
  FRAME,
  PAGES,
  settled,
  sourceBook,
  usage,
} from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "调研纸飞机备赛:折法实测;纸张克重;投掷角度";
const SUBTASK = "折法实测对比";
const OBJECTIVE = "建立三种折法的距离与滞空实测矩阵(镖形/滑翔形/特技形)";
const S = sourceBook();
// the delegation's digest cites the page the child is about to gather
S.reserve("folds", "records");
const RECORDS = PAGES.records;
const CHILD = { round: 1, id: 10000, agent: "S1" };

const DIGEST = `[Subtask S1] ${SUBTASK}\n已确认:\n- 滑翔形距离 15.8 米、滞空 6.4 秒${S.cite("folds")}\n- 镖形距离 12.4 米${S.cite("folds")}\n未决:\n- 往届成绩的投掷口径`;
const FOLLOWUP_DIGEST = `[Subtask S1] ${SUBTASK}\n已确认:\n- 往届成绩与社团实测同口径 ${S.cite("records")}`;

/** Subagents: the delegation row, the child's own timeline folded under it
    (its events addressed by `turn`), a browser frame tagged with the
    child's session, the context compaction marker, and a follow-up message
    that resumes the same child. */
export const SUB_STAGE: DebugScenario = {
  id: "sub",
  name: "子代理",
  label: "subagents (delegation row · folded sub-timeline · browser tabs)",
  q: QUESTION,
  mode: "deep",
  events: [
    { ...base },
    { e: "phase", name: "research" },
    {
      e: "browser",
      url: "https://search.example.org/?q=纸飞机+折法+实测",
      title: "纸飞机 折法 实测 - 示例搜索",
      img: FRAME,
      w: 1920,
      h: 1080,
      agent: "lead",
    },
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
    { e: "think", id: 10000, t: "子代理:先宽后窄," },
    { e: "think", id: 10000, t: "先找三种折法的实测," },
    { e: "think", id: 10000, t: "再补滑翔形的滞空数据。" },
    {
      ...calls([call(1, "search_web", "纸飞机 三种折法 实测 距离", { query: "纸飞机 三种折法 实测 距离" })], 10000),
      round: 1,
      turn: 1,
    },
    { ...S.join(CHILD, "folds"), turn: 1 },
    {
      e: "call",
      id: 10000,
      call: 1,
      turn: 1,
      status: "ok",
      n: 6,
      ms: 1640,
      feed: `plan: 5 deep + 1 shallow ${S.cite("folds")}`,
    },
    {
      e: "browser",
      url: "https://search.example.org/?q=纸飞机+滑翔形+滞空",
      title: "纸飞机 滑翔形 滞空 - 示例搜索",
      img: FRAME,
      w: 1920,
      h: 1080,
      agent: "sub-10000",
    },
    { e: "close", id: 10000 },
    { e: "open", id: 10000, kind: "sub", round: 2, agent: "S1", title: "" },
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      ms: 0,
      label: `S1 · ${SUBTASK}`,
      chars: DIGEST.length,
      feed: DIGEST,
      result: DIGEST,
    },
    { e: "findings", round: 2, items: [], gaps: [] },
    { e: "close", id: 1 },
    { e: "compact", round: 2, trigger: "micro", pre: 148000, post: 121000, summarized: 0, kept: 0 },
    { ...base, id: 3, round: 2 },
    calls(
      [
        call(1, "message_subtask", "S1 · 往届成绩的投掷口径未决,补一个同口径对比", {
          id: "S1",
          message: "往届成绩的投掷口径未决:补一个同口径的对比",
        }),
      ],
      3,
    ),
    {
      e: "call",
      id: 3,
      call: 1,
      status: "ok",
      ms: 0,
      label: "S1 · follow-up",
      feed: "往届成绩的投掷口径未决:补一个同口径的对比",
    },
    { e: "open", id: 10000, kind: "sub", round: 1, agent: "S1", title: "" },
    { e: "think", id: 10000, t: "跟进收到:在已入册的实测矩阵上补往届口径,不重开调研。" },
    {
      ...calls(
        [
          call(1, "search_web", "纸飞机 比赛 往届 成绩 投掷", { query: "纸飞机 比赛 往届 成绩 投掷" }),
          call(2, "browse", RECORDS.url, { action: "read" }),
        ],
        10000,
      ),
      round: 1,
      turn: 2,
    },
    {
      e: "call",
      id: 10000,
      call: 1,
      turn: 2,
      status: "ok",
      n: 3,
      ms: 1220,
      feed: `往届比赛成绩口径 ${S.cite("records")}`,
    },
    { ...S.join(CHILD, "records"), turn: 2 },
    {
      e: "call",
      id: 10000,
      call: 2,
      turn: 2,
      status: "ok",
      ms: 2140,
      chars: 3120,
      url: RECORDS.url,
      page: { url: RECORDS.url, title: RECORDS.title },
      text: "## 往届比赛成绩表\n\n去年冠军用滑翔形飞出 18.6 米,平均滞空 6.2 秒;成绩按室内、无风条件记录,与社团实测同口径。",
      feed: `${RECORDS.title}\n\n去年冠军用滑翔形飞出 18.6 米…(this page is ${S.cite("records")})`,
    },
    {
      ...calls(
        [
          call(1, "calculate", "(15.8 + 12.4) / 2", { expression: "(15.8 + 12.4) / 2" }),
          call(2, "list_engines", "", {}),
          call(3, "record_findings", "", {
            facts: [
              { text: `往届成绩按室内无风记录,与社团实测同口径${S.cite("records")}。`, refs: [S.number("records")] },
            ],
            tags: ["往届", "口径"],
          }),
          call(4, "evaluate", "往届口径与实测是否一致", {
            questions: [{ name: "caliber", instructions: "往届成绩的记录条件与社团实测是否同口径?", type: "choice" }],
          }),
        ],
        10000,
      ),
      round: 1,
      turn: 3,
    },
    {
      e: "call",
      id: 10000,
      call: 1,
      turn: 3,
      status: "ok",
      result: "14.1",
      ms: 3,
      feed: '{"expression": "(15.8 + 12.4) / 2", "result": "14.1"}',
    },
    {
      e: "call",
      id: 10000,
      call: 2,
      turn: 3,
      status: "ok",
      n: 48,
      ms: 3,
      feed: "This demo deployment searches 48 enabled engines across 8 categories…",
    },
    {
      e: "call",
      id: 10000,
      call: 3,
      turn: 3,
      status: "ok",
      n: 1,
      ms: 5,
      feed: "recorded: 1 new fact; the writer reads the active list",
    },
    {
      e: "call",
      id: 10000,
      call: 4,
      turn: 3,
      status: "ok",
      answers: { caliber: "同口径" },
      ms: 640,
      feed: "caliber: 同口径",
    },
    {
      e: "call",
      id: 3,
      call: 1,
      status: "ok",
      ms: 0,
      label: "S1 · follow-up",
      chars: FOLLOWUP_DIGEST.length,
      feed: FOLLOWUP_DIGEST,
      result: FOLLOWUP_DIGEST,
    },
    { e: "findings", round: 3, items: [], gaps: [] },
    { e: "close", id: 3 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "answer",
      t: `折法实测由子任务完成:**滑翔形**的距离(15.8 米)与滞空(6.4 秒)都排第一${S.cite("folds")};往届冠军的成绩按同一口径记录,可以与实测直接比较${S.cite("records")}。`,
    },
    { e: "close", id: 2 },
    { e: "related", items: ["特技形的实测数据在哪里?", "纸张克重对距离影响多大?"] },
    settled(usage(15200, 520, 800, 8100)),
  ],
};
