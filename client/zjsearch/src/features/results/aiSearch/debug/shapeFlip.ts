// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, settled, sourceBook, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const TITLE = "纸飞机社团招新宣讲要点";
const S = sourceBook();

/** The reader flips the output shape to a DECK from the rail mid-research:
    the server pairs the pending deck with one canonical steer notice, and
    the write boundary announces the deck outline before the single writer
    streams the whole slide deck in the Marpit dialect. */
export const SHAPE_FLIP_STAGE: DebugScenario = {
  id: "shape-flip",
  name: "形态切换",
  label: "shape flip (guide injection · boundary flip · slide answer)",
  q: "纸飞机社团招新宣讲要点",
  mode: "report",
  events: [
    { e: "client.start", runNo: 1, q: "纸飞机社团招新宣讲要点", mode: "report" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "先找社团活动安排和折法实测两组材料。" },
    calls([call(1, "search_web", "纸飞机 社团 活动 折法", { query: "纸飞机 社团 活动 折法" })]),
    S.join({ round: 1, id: 1 }, "folds", "club"),
    { e: "call", id: 1, call: 1, status: "ok", n: 3, ms: 1240, feed: `plan: 3 deep lines ${S.cite("folds", "club")}` },
    {
      e: "steer",
      text: "The output format switched to a presentation deck: for any remaining research, favor slide-ready points, numeric comparisons and chart-able material; gathered material need not be redone.",
      delivery: "guide",
      status: "drained",
    },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "outline",
      title: TITLE,
      subtitle: "演示文稿版",
      shape: "deck",
      sections: [
        { id: "c1", title: "社团与比赛", status: "pending" },
        { id: "c2", title: "三种折法与备赛", status: "pending" },
      ],
    },
    { e: "think", id: 2, t: "改成演示文稿:每页一个要点,数字带引用,封面加标题页。" },
    {
      e: "answer",
      t: `# 纸飞机社团招新宣讲\n演示文稿版 · 纸飞机社团\n\n---\n\n# 社团与比赛\n- 学校纸飞机社团,每周五下午活动${S.cite("club")}\n- 12 月在示例体育馆参加城市邀请赛${S.cite("club")}\n\n---\n\n# 三种折法\n- **滑翔形**:15.8 米,滞空 6.4 秒,最均衡${S.cite("folds")}\n- 镖形 12.4 米,特技形 8.2 米${S.cite("folds")}\n\n---\n\n# 备赛\n- 80g A4 纸,出手 10 度\n- 每周五下午常规训练\n\n<!-- 欢迎新社员先到会员系统登记,再领取练习纸。 -->`,
    },
    { e: "close", id: 2 },
    settled(usage(7420, 640, 410, 2200)),
  ],
};
