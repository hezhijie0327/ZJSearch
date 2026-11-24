// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, PAGES, sourceBook } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "纸飞机社团比赛日的场地怎么选";
const S = sourceBook();
const VENUE = PAGES.venue;

/** Research gathered material, then the writer died before any answer
    text: the failed box with its receipt, and CONTINUE as the way out. */
export const FAILED_STAGE: DebugScenario = {
  id: "failed",
  name: "失败态",
  label: "failed state (receipt + continue)",
  q: QUESTION,
  mode: "report",
  events: [
    { e: "client.start", runNo: 1, q: QUESTION, mode: "report" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "先查场馆价目与开放时间,再读一遍体育馆的使用须知。" },
    calls(
      [
        call(1, "search_web", "示例市 体育馆 租用 价格", { query: "示例市 体育馆 租用 价格" }),
        call(2, "browse", VENUE.url, { action: "open", url: VENUE.url }),
      ],
      1,
    ),
    S.join({ round: 1, id: 1 }, "venue"),
    { e: "call", id: 1, call: 1, status: "ok", n: 6, ms: 2100, feed: `plan: 5 deep lines ${S.cite("venue")}` },
    {
      e: "call",
      id: 1,
      call: 2,
      status: "ok",
      ms: 6100,
      feed: `opened ${VENUE.url} -- ${VENUE.title}\n\ne1\tlink\t价目表\n(110 refs)\n\n(this page is already your source ${S.cite("venue")} -- cite it as ${S.cite("venue")})`,
      page: { url: VENUE.url, title: VENUE.title },
    },
    { e: "close", id: 1 },
    {
      e: "settle",
      status: "error",
      halt: "the model answered in its reasoning channel only -- no answer text",
      finish: "end",
      usage: {
        input: 18234,
        output: 0,
        thoughts: 1204,
        cached: 9210,
        cache_write: 512,
        research: { input: 18234, output: 0 },
        write: null,
        gates: { input: 812, output: 40, calls: 3 },
        rerank: { calls: 4, tokens: 3120 },
        decision: { calls: 2, tokens: 640 },
      },
      model: "demo-model",
    },
  ],
};
