// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, settled, sourceBook, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

/** 72 lines of fictional past records: enough bulk to make the pasted
    brief clamp the run title to its three lines and grow the composer. */
const RECORDS = Array.from({ length: 72 }, (_, index) => {
  const year = 2014 + Math.floor(index / 6);
  const round = (index % 6) + 1;
  const fold = ["镖形", "滑翔形", "特技形"][index % 3];
  const distance = (9 + ((index * 7) % 10) * 0.9).toFixed(1);
  const airtime = (2.6 + ((index * 5) % 7) * 0.5).toFixed(1);
  return `${year} 年第 ${round} 场:${fold},出手角 20 度,无风,飞行 ${distance} 米,滞空 ${airtime} 秒,纸重 70g。`;
});

const BRIEF = [
  "# 示例学校纸飞机社团 · 城市邀请赛备赛简报",
  "",
  "一、我们是谁",
  "示例学校纸飞机社团成立于 2014 年,现有社员 32 人,每周五下午在学校活动室活动。社团已经连续参加七届城市邀请赛,最好成绩是去年的冠军。今年比赛定在 12 月 5 日(周六),地点是示例体育馆。",
  "",
  "二、我们要解决的问题",
  "1. 三种常用折法(镖形、滑翔形、特技形)在室内无风条件下,哪一种的距离和滞空最均衡?",
  "2. 70g 与 80g 的 A4 纸对飞行距离影响多大?哪一种更适合比赛?",
  "3. 出手角度在 10 度到 45 度之间,距离和滞空分别怎么变化?",
  "4. 示例体育馆的租用价格、预约规则和使用限制是什么?",
  "5. 比赛日如果遇到门口大风或者场地临时关闭,有哪些备选方案?",
  "",
  "三、已有的材料",
  "- 社团在活动室做过 20 次一组的投掷实测,记录了折法、纸张、出手角度、飞行距离和滞空时间。",
  "- 往届比赛的成绩表由主办方提供,记录条件是室内、无风。",
  "- 示例体育馆的价目表和使用须知都可以在网上查到。",
  "",
  "四、希望的输出",
  "请给出一份分节的报告:先给结论(推荐折法、纸张、出手角度),再给依据和对比表,最后给比赛日的时间安排和备选方案。数字要带引用,口径不一致的地方要如实说明。",
  "",
  "五、往届记录(节选)",
  ...RECORDS,
  "",
  "六、注意事项",
  "- 不要使用任何需要付费的引擎。",
  "- 特技形的回旋动作不在这次比赛的评分范围内。",
  "- 如果材料之间有矛盾,以社团自己的实测为准。",
].join("\n");

const S = sourceBook();

/** A pasted multi-line brief: the run title clamps at three lines behind
    its expand chip (the QA surface for the long-prompt title). */
export const LONGTEXT_STAGE: DebugScenario = {
  id: "longtext",
  name: "长文提问",
  label: "pasted multi-line brief (clamped run title)",
  q: BRIEF,
  mode: "report",
  events: [
    { e: "client.start", runNo: 1, q: BRIEF, mode: "report" },
    { ...base },
    { e: "phase", name: "plan" },
    {
      e: "say",
      id: 1,
      t: "已收到完整的备赛简报:折法、纸张、出手角度和场地四条线;先并行核实折法实测和场馆规则两条主线。",
    },
    {
      e: "think",
      id: 1,
      t: "简报本身划定了交付结构,按「结论 → 依据 → 时间安排 → 备选」展开;往届记录只作参照,以社团实测为准。",
    },
    calls(
      [
        call(1, "search_web", "纸飞机 折法 距离 滞空 实测", { query: "纸飞机 折法 距离 滞空 实测" }),
        call(2, "search_web", "示例体育馆 租用 预约 规则", { query: "示例体育馆 租用 预约 规则" }),
      ],
      1,
    ),
    S.join({ round: 1, id: 1 }, "folds", "venue"),
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      n: 5,
      ms: 2240,
      feed: `plan: 5 deep + 5 shallow lines ${S.cite("folds")}`,
    },
    { e: "call", id: 1, call: 2, status: "ok", n: 4, ms: 1980, feed: `plan: 4 deep lines ${S.cite("venue")}` },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    { e: "think", id: 2, t: "简报要求分部交付并区分实测与提案;先给结论,再按四条线落小节,引用只放可核实的数字。" },
    {
      e: "answer",
      t: `## 结论\n\n**推荐组合**:滑翔形 + 80g A4 纸 + 10 度出手角。滑翔形平均飞行 15.8 米、滞空 6.4 秒${S.cite("folds")}。\n\n## 依据\n\n| 折法 | 平均距离 | 平均滞空 |\n|---|---|---|\n| 镖形 | 12.4 米 | 3.1 秒 |\n| 滑翔形 | 15.8 米 | 6.4 秒 |\n| 特技形 | 8.2 米 | 4.8 秒 |\n\n## 时间安排\n\n比赛日 12 月 5 日(周六)。示例体育馆周末场 300 元/小时,需提前三天预约${S.cite("venue")}。\n\n完整报告(含出手角度、备选方案与往届记录对照)见下文——此处从略,聚焦长标题下的排版验证。`,
    },
    { e: "close", id: 2 },
    settled(usage(31204, 962, 1840, 12288)),
  ],
};
