// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  base,
  call,
  calls,
  GALLERY_IMAGE,
  PAGES,
  sourceBook,
  usage,
} from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const S = sourceBook();
const VENUE = PAGES.venue;
/** long enough to render the reading pane with a measurable clamp */
const VENUE_RULES = [
  "## 示例体育馆使用须知",
  "",
  "- 开放时间:工作日 9:00 至 21:00,周末 8:00 至 22:00。",
  "- 篮球场在工作日 18:00 后免费开放,其余时段按价目表计费。",
  "- 周末场需提前三天预约,押金 500 元,当场退还。",
  "- 馆内禁止使用无人机;纸飞机活动需自备回收网。",
  "- 折叠桌每张限放 4 人,不得叠放。",
  "- 音响设备免费借用,需登记学生证。",
  "- 比赛日可租用记分牌,每块 20 元。",
  "- 饮水机在一楼东侧,请自备水杯。",
  "- 更衣室在二楼,比赛期间免费开放。",
  "- 停车场按小时收费,社团车辆可申请免费通行证。",
  "- 活动结束后请把场地恢复原状,离场前由管理员验收。",
].join("\n");

/** EVERY late event after the answer: the gallery placeholder inside the
    answer, a stalled halt reason, related questions, the run title, a
    memory row, tags and the gates usage. */
export const PANORAMA_STAGE: DebugScenario = {
  id: "panorama",
  name: "全景",
  label: "panorama (gallery · follow-up · title · memory · tags · gates)",
  q: "全景演示:答案尾部的每个面",
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: "全景演示:答案尾部的每个面", mode: "balanced" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "两份材料就够:一条检索、一次页面阅读。" },
    calls([call(1, "search_web", "示例体育馆 使用须知", { query: "示例体育馆 使用须知" })]),
    S.join({ round: 1, id: 1 }, "folds"),
    { e: "call", id: 1, call: 1, status: "ok", n: 6, ms: 1180, feed: `6 条结果进入 feed ${S.cite("folds")}` },
    { e: "close", id: 1 },
    { ...base, id: 2, round: 2 },
    { e: "think", id: 2, t: "把体育馆的使用须知整页读下来,给画廊一个可引用的图源。" },
    calls([call(1, "browse", "", { action: "read" })], 2),
    S.join({ round: 2, id: 1, crawled: true }, "venue"),
    {
      e: "call",
      id: 2,
      call: 1,
      status: "ok",
      ms: 2140,
      url: VENUE.url,
      chars: VENUE_RULES.length,
      preview: VENUE_RULES.slice(0, 120),
      text: VENUE_RULES,
      page: { url: VENUE.url, title: VENUE.title },
      feed: `${VENUE.title}\n\n${VENUE_RULES.slice(0, 160)}…`,
    },
    { e: "close", id: 2 },
    {
      e: "findings",
      items: [
        {
          id: 9,
          text: `周末场需提前三天预约,押金 500 元 ${S.cite("venue")}。`,
          refs: [S.number("venue")],
          tags: ["场地"],
          status: "active",
          round: 2,
        },
      ],
      gaps: [],
    },
    {
      e: "plan",
      items: [
        { title: "两份材料到位", status: "done" },
        { title: "答案尾部逐项渲染", status: "active" },
      ],
    },
    { e: "phase", name: "write" },
    { e: "open", id: 3, kind: "write", round: 0 },
    {
      e: "answer",
      t: `全景演示把答案尾部逐一过一遍:引用落在 ${S.cite("folds")} 与 ${S.cite("venue")},下方的画廊占位符由 gallery 事件填充。\n\n{{zjs-gallery:0}}\n\n占位符之后的正文继续流动,验证占位符两侧的文本都完好。`,
    },
    { e: "gallery", items: [{ u: GALLERY_IMAGE, n: 2 }] },
    { e: "answer", t: "\n\n结尾再补一句:画廊之后的行为不受影响。" },
    { e: "close", id: 3 },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      halt_reason: "stalled",
      usage: usage(3810, 210, 140, 1024),
      model: "demo-model",
    },
    { e: "related", items: ["画廊占位符两侧的文本还在吗?", "体育馆周末场怎么预约?"] },
    { e: "title", text: "全景演示:答案尾部面面观" },
    { e: "memory", op: "save", kind: "fact", content: "用户的社团在示例体育馆活动" },
    { e: "tags", items: ["全景演示", "答案尾部", "纸飞机"] },
    { e: "usage", gates: { calls: 5, tokens: 3120 } },
  ],
};
