// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, settled, sourceBook, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "用 demo 引擎查一下纸飞机比赛的往届冠军";
const PAID_QUERY = "!demo 纸飞机 比赛 往届 冠军";
const CONFIRM = {
  intro: "demo 按调用计费,本次研究是否允许使用?",
  questions: [{ q: "允许本次研究使用计费引擎 demo 吗?", type: "single", options: ["允许", "不用,走免费引擎"] }],
};

/** A bang naming an API-BILLED engine is HELD until the user approves: the
    search settles as `approval`, the run parks `awaiting` on an ask_user
    confirmation, and the user's yes comes back as a re-run carrying
    `paid_ok: true`.  (`demo` is a fictional paid engine.) */
export const PAID_STAGE: DebugScenario = {
  id: "paid",
  name: "付费确认",
  label: "paid engine confirmation (hold · ask_user · approved re-run)",
  q: QUESTION,
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: QUESTION, mode: "balanced" },
    { ...base },
    { e: "phase", name: "plan" },
    { e: "say", id: 1, t: "用户点名 demo(计费引擎):先发起检索,若被扣下就向用户确认计费使用。" },
    calls([call(1, "search_web", PAID_QUERY, { query: PAID_QUERY })]),
    {
      e: "call",
      id: 1,
      call: 1,
      status: "approval",
      n: 0,
      ms: 0,
      feed: "held: the bang targets demo -- an API-BILLED engine (every call costs the user money) and this run has no approval yet.  Ask ONCE: call ask_user (as the ONLY call of a turn) with a short confirmation naming the engine and that it is billed per call.  When the user APPROVES, re-run this search with paid_ok: true -- the approval covers the rest of the run.  If they decline, never set paid_ok and stay on the free engines.",
    },
    {
      e: "think",
      id: 1,
      t: "demo 是计费引擎,执行器把检索扣下了——按规则先用 ask_user 问一次用户,批准后再带 paid_ok 重跑。",
    },
    { e: "close", id: 1 },
    { ...base, id: 2 },
    calls([call(1, "ask_user", "", CONFIRM)], 2),
    {
      e: "call",
      id: 2,
      call: 1,
      status: "ok",
      ms: 4,
      feed: "ask recorded -- the run continues on the user's best interpretation",
    },
    { e: "ask", ...CONFIRM },
    { e: "settle", status: "awaiting", halt: "awaiting the user's direction", finish: null, usage: null, model: null },
  ],
  // the approved re-run: the same bang with paid_ok, a free engine beside it
  clarifyTail: (transcript) => {
    const S = sourceBook();
    return [
      { e: "client.clarify", text: transcript, startedAt: Date.now(), mode: "balanced" },
      { ...base, id: 3 },
      { e: "phase", name: "research" },
      { e: "say", id: 3, t: "用户已批准 demo:带 paid_ok 重跑检索,并行一路免费引擎对照。" },
      calls(
        [
          call(1, "search_web", PAID_QUERY, { query: PAID_QUERY, paid_ok: true }),
          call(2, "search_web", "纸飞机 比赛 往届 冠军", { query: "纸飞机 比赛 往届 冠军", category: "general" }),
        ],
        3,
      ),
      S.join({ round: 1, id: 3 }, "records", "angle"),
      {
        e: "call",
        id: 3,
        call: 1,
        status: "ok",
        n: 8,
        ms: 2140,
        feed: `plan: 5 deep + 3 shallow lines ${S.cite("records", "angle")}…`,
      },
      { e: "call", id: 3, call: 2, status: "ok", n: 5, ms: 1870, feed: `plan: 5 deep lines ${S.cite("angle")}` },
      { e: "close", id: 3 },
      { e: "open", id: 4, kind: "write", round: 0 },
      { e: "phase", name: "write" },
      {
        e: "answer",
        t: `去年的冠军用**滑翔形**飞出 **18.6 米**,平均滞空 6.2 秒${S.cite("records")};他的出手角度是 10 度,正是滞空最久的角度${S.cite("angle")}。计费引擎 demo 的结果与免费引擎的检索互相印证。`,
      },
      { e: "close", id: 4 },
      { e: "related", items: ["往届亚军的成绩是多少?", "10 度出手怎么练?"] },
      settled(usage(6840, 186, 140, 2100)),
    ];
  },
};
