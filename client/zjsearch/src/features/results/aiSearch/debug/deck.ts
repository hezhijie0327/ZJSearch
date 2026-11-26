// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, settled, sourceBook, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const TITLE = "纸飞机社团招新宣讲";
const SUBTITLE = "三种折法一页看懂";
const S = sourceBook();

/** A run born as a DECK: the write boundary announces the chapter outline
    and the single writer streams the whole slide markdown (Marpit dialect,
    `---` splits the slides). */
export const DECK_STAGE: DebugScenario = {
  id: "deck",
  name: "演示文稿",
  label: "single-write deck (deck)",
  q: "纸飞机社团招新宣讲速览",
  mode: "deck",
  events: [
    { e: "client.start", runNo: 1, q: "纸飞机社团招新宣讲速览", mode: "deck" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "速览型交付:一轮检索拿折法与社团信息,幻灯片按章节组织。" },
    calls([call(1, "search_web", "纸飞机 社团 招新 折法", { query: "纸飞机 社团 招新 折法" })]),
    S.join({ round: 1, id: 1 }, "folds", "weight", "club"),
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      n: 3,
      ms: 1180,
      feed: `plan: 3 deep lines ${S.cite("folds", "weight", "club")}`,
    },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "outline",
      title: TITLE,
      subtitle: SUBTITLE,
      shape: "deck",
      sections: [
        { id: "c1", title: "社团与比赛", status: "pending" },
        { id: "c2", title: "三种折法怎么选", status: "pending" },
        { id: "c3", title: "备赛的三件事", status: "pending" },
      ],
    },
    {
      e: "think",
      id: 2,
      t: "章节按「社团 → 折法 → 备赛」推进:每章一到两页,数字全部带引用;最后一章收在可以马上照做的三件事上。",
    },
    {
      e: "answer",
      t: `# 纸飞机社团招新宣讲\n三种折法一页看懂 · 纸飞机社团\n\n---\n\n# 我们是谁\n- 学校纸飞机社团,**每周五下午**活动${S.cite("club")}\n- 新社员先在会员系统登记${S.cite("club")}\n\n---\n\n# 一年两场比赛\n- 12 月城市邀请赛,在示例体育馆\n- 每人限带 3 架,纸自备\n\n---\n\n# 三种折法\n- **滑翔形**:距离 15.8 米、滞空 6.4 秒,最均衡${S.cite("folds")}\n- 镖形:12.4 米,出手快${S.cite("folds")}\n- 特技形:8.2 米,能回旋${S.cite("folds")}\n\n---\n\n# 备赛的三件事\n- 用 **80g A4 纸**,比 70g 多飞 1.8 米${S.cite("weight")}\n- 出手角度取 **10 度**,滞空最久\n- 周末场地 300 元/小时,提前三天预约`,
    },
    { e: "close", id: 2 },
    { e: "related", items: ["滑翔形分步骤怎么折?", "80g 纸哪里能买到?"] },
    settled(usage(9840, 920, 640, 3100)),
  ],
};
