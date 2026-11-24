// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, PAGES, settled, sourceBook, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "读一下折法图解、克重实测和场馆价目这三页";
const S = sourceBook();

const FOLDS = PAGES.folds;
const WEIGHT = PAGES.weight;
const RECORDS = PAGES.records;
const VENUE = PAGES.venue;
const ANGLE = PAGES.angle;

const FOLDS_DOC =
  "# 三种经典折法的步骤图解\n\n镖形、滑翔形、特技形三种折法各有适用场景:镖形出手快,适合比距离;滑翔形翼面宽,滞空久;特技形可以做出回旋动作。\n\n## 折叠要点\n\n- 先对折出中线,左右两翼必须完全对称;\n- 滑翔形的翼尾要向上折 1 厘米,否则容易俯冲;\n- 特技形的升降舵左右不等,才能画出弧线。";
const WEIGHT_DOC =
  "## 纸张克重对飞行距离的影响\n\n| 纸张 | 平均距离 | 平均滞空 |\n|---|---|---|\n| 70g A4 | 14.0 米 | 5.6 秒 |\n| 80g A4 | 15.8 米 | 6.4 秒 |\n\n80g 纸更挺括,出手后不易被气流压低。";

const tabStep = (index: number, page: { url: string; title: string }): Record<string, unknown> => ({
  action: "tab",
  status: "ok",
  label: `opened in BACKGROUND as tab [${index}]: ${page.url} -- ${page.title}`,
  url: page.url,
  title: page.title,
});

const OUTLINE = [
  "e1\tlink\t三种折法",
  "e2\tlink\t纸张选择",
  "e3\tlink\t投掷技巧",
  "e4\tbutton\t下载步骤图",
  "e5\tlink\t常见问题",
  "e6\tbutton\t加入社团",
].join("\n");

/** Crawling several sources at once: pages open in BACKGROUND tabs, one
    multi-index read returns every tab's document -- including the tab
    that FAILED beside the read ones -- a second batch repeats the rhythm,
    the viewport switch re-flows the active page, and an open that dies. */
export const BATCH_READ_STAGE: DebugScenario = {
  id: "batch-read",
  name: "后台批量读取",
  label: "background tabs × multi-index read (with a failed tab) × viewport",
  q: QUESTION,
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: QUESTION, mode: "balanced" },
    { ...base },
    { e: "phase", name: "research" },
    {
      e: "say",
      id: 1,
      t: "三页在后台一起打开,再按标签页序号一次读完;价目表那页换成手机视口看一遍。",
    },
    calls(
      [
        call(1, "browse", "", {
          action: "multi",
          steps: [
            { action: "tab", op: "new", url: FOLDS.url, activate: false },
            { action: "tab", op: "new", url: WEIGHT.url, activate: false },
            { action: "tab", op: "new", url: RECORDS.url, activate: false },
            { action: "read", indexes: [1, 2, 3] },
          ],
        }),
        call(2, "browse", "https://dead.example.org/missing", {
          action: "open",
          url: "https://dead.example.org/missing",
        }),
        call(3, "browse", "", { action: "viewport", width: 440, height: 956 }),
        call(4, "browse", "", {
          action: "multi",
          steps: [
            { action: "tab", op: "new", url: VENUE.url, activate: false },
            { action: "tab", op: "new", url: ANGLE.url, activate: false },
            { action: "read", indexes: [4, 5] },
          ],
        }),
      ],
      1,
    ),
    S.join({ round: 1, id: 1 }, "folds", "weight", "records"),
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      ms: 12840,
      page: { url: WEIGHT.url, title: WEIGHT.title },
      steps: [
        tabStep(1, FOLDS),
        tabStep(2, WEIGHT),
        tabStep(3, RECORDS),
        {
          action: "read",
          status: "ok",
          label: `[tab 1] ${FOLDS.title} (${FOLDS.url})`,
          url: WEIGHT.url,
          title: WEIGHT.title,
          sections: [
            { url: FOLDS.url, title: FOLDS.title, text: FOLDS_DOC },
            { url: WEIGHT.url, title: WEIGHT.title, text: WEIGHT_DOC },
          ],
          // the tab that FAILED beside the read ones: an alert row under
          // the documents -- it never vanishes from the step
          errors: [{ index: "3", url: RECORDS.url, error: "no readable content found" }],
        },
      ],
      feed: `1. tab: opened in BACKGROUND as tab [1]: ${FOLDS.url}\n2. tab: opened in BACKGROUND as tab [2]: ${WEIGHT.url}\n3. tab: opened in BACKGROUND as tab [3]: ${RECORDS.url}\n4. read: [tab 1] ${FOLDS.title} (${FOLDS.url})\n\n${FOLDS_DOC}`,
    },
    {
      e: "call",
      id: 1,
      call: 2,
      status: "error",
      ms: 15200,
      feed: "error: could not open the page (net::ERR_NAME_NOT_RESOLVED at https://dead.example.org/missing)",
    },
    {
      e: "call",
      id: 1,
      call: 3,
      status: "ok",
      ms: 640,
      n: 6,
      page: { url: FOLDS.url, title: FOLDS.title },
      snapshot: OUTLINE,
      feed: `viewport is now 440x956 -- tabs opened from now inherit it (the claimed OS / user agent stays desktop); the page re-flowed: ${FOLDS.url} -- ${FOLDS.title}\n\n${OUTLINE}`,
    },
    S.join({ round: 1, id: 1 }, "venue", "angle"),
    {
      e: "call",
      id: 1,
      call: 4,
      status: "ok",
      ms: 6200,
      page: { url: ANGLE.url, title: ANGLE.title },
      steps: [
        tabStep(4, VENUE),
        tabStep(5, ANGLE),
        {
          action: "read",
          status: "ok",
          label: `[tab 4] ${VENUE.title} (${VENUE.url})`,
          url: ANGLE.url,
          title: ANGLE.title,
          sections: [
            {
              url: VENUE.url,
              title: VENUE.title,
              text: "## 示例体育馆场地租用价目表\n\n| 时段 | 价格 | 包含 |\n|---|---|---|\n| 工作日 | 200 元/小时 | 场地 |\n| 周末 | 300 元/小时 | 场地 + 20 张折叠桌 |",
            },
            {
              url: ANGLE.url,
              title: ANGLE.title,
              text: "## 投掷角度与滞空时间\n\n10 度投掷滞空最久(6.4 秒),45 度投掷距离最远(18.6 米)。角度再大,飞机会失速下坠。",
            },
          ],
        },
      ],
      feed: `1. tab: opened in BACKGROUND as tab [4]: ${VENUE.url}\n2. tab: opened in BACKGROUND as tab [5]: ${ANGLE.url}\n3. read: [tab 4] ${VENUE.title}`,
    },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "answer",
      t: `三页里读到两页:**80g 纸**比 70g 多飞 1.8 米${S.cite("weight")};折法上滑翔形翼面最宽、滞空最久${S.cite("folds")}。往届成绩表那一页没有读到可读内容,需要换个来源${S.cite("records")}。`,
    },
    { e: "close", id: 2 },
    { e: "related", items: ["往届成绩表还有别的出处吗?", "滑翔形怎么折才不容易俯冲?"] },
    settled(usage(8900, 310, 260, 4300)),
  ],
};
