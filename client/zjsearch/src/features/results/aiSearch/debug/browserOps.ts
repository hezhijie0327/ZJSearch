// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ANNOTATED_FRAME, base, call, calls, FRAME, settled, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "在浏览器里查纸飞机滑翔形的折法,开个新标签对比比赛规则,再滚到百科条目";

const SEARCH_URL = "https://search.example.org/?q=纸飞机+滑翔形+折法";
const SEARCH_TITLE = "纸飞机 滑翔形 折法 - 示例搜索";
const RULES_URL = "https://search.example.org/?q=纸飞机+比赛+规则";
const RULES_TITLE = "纸飞机 比赛 规则 - 示例搜索";
const WIKI_URL = "https://wiki.example.org/paper-plane";
const WIKI_TITLE = "纸飞机 - 示例百科";
const PDF_URL = "https://venue.example.net/rules.pdf";
const PDF_TITLE = "示例体育馆使用规则";

const SEARCH_PAGE = { url: SEARCH_URL, title: SEARCH_TITLE };
const SNAPSHOT = [
  "e111\tbutton\t跳到主要内容",
  "e114\tinput\t纸飞机 滑翔形 折法",
  "e116\tbutton\t搜索",
  "e117\tlink\t滑翔形的折法步骤",
  "e118\tlink\t纸飞机 - 示例百科",
].join("\n");

const browserSource = (
  n: number,
  id: number,
  page: { url: string; title: string },
  crawled: boolean,
): Record<string, unknown> => ({
  n,
  round: 3,
  id,
  idx: id - 1,
  title: page.title,
  url: page.url,
  netloc: "search.example.org",
  favicon: "",
  crawled,
  browser: true,
});

/** The browser's mechanical surface: an open with its annotated mirror
    frame and outline, the tab strip (a background tab switches in), the
    targeted scroll-to-text, a fetched document, a multi batch whose
    click-through lands a fresh outline, and a multi that ENDS on a
    screenshot (the attachment-line settlement carries img+shot beside the
    step summaries) -- the explored pages join the source registry with
    the browser mark. */
export const BROWSER_OPS_STAGE: DebugScenario = {
  id: "browser-ops",
  name: "浏览器操作",
  label: "browser ops (annotated frame × tab strip × scroll-to-text × multi × multi-shot)",
  q: QUESTION,
  mode: "balanced",
  events: [
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "开浏览器搜索,顺便演示新的标签页、定向滚动和批量操作。" },
    calls([call(1, "browse", SEARCH_URL, { action: "open", url: SEARCH_URL })]),
    { e: "browser", url: SEARCH_URL, title: SEARCH_TITLE, img: ANNOTATED_FRAME, w: 1920, h: 1080 },
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      ms: 6480,
      url: SEARCH_URL,
      n: 110,
      page: SEARCH_PAGE,
      snapshot: SNAPSHOT,
      feed: `opened ${SEARCH_URL} -- ${SEARCH_TITLE}\n\n${SNAPSHOT}\n\n(110 refs -- the mirror shows each one's dashed outline + ref badge)`,
    },
    { ...base, id: 2, round: 2 },
    { e: "say", id: 2, t: "开一个新标签对比比赛规则,再回到第一页滚动到百科条目。" },
    calls(
      [
        call(1, "browse", "", { action: "tab", op: "new", url: RULES_URL }),
        call(2, "browse", "", { action: "scroll", text: "示例百科" }),
      ],
      2,
    ),
    {
      e: "browser",
      url: SEARCH_URL,
      title: SEARCH_TITLE,
      img: ANNOTATED_FRAME,
      w: 1920,
      h: 1080,
      px: 340,
      py: 706,
      pk: "scroll",
      name: "示例百科",
      box: [120, 690, 420, 32],
      tabs: [
        { index: 0, url: SEARCH_URL, title: SEARCH_TITLE, active: true },
        { index: 1, url: RULES_URL, title: RULES_TITLE, active: false },
      ],
    },
    {
      e: "call",
      id: 2,
      call: 1,
      status: "ok",
      ms: 5240,
      url: RULES_URL,
      n: 86,
      tabs: [
        { index: 0, url: SEARCH_URL, title: SEARCH_TITLE, active: false },
        { index: 1, url: RULES_URL, title: RULES_TITLE, active: true },
      ],
      feed: `new tab opened and active: ${RULES_URL} -- ${RULES_TITLE}\n\ne1\tinput\t纸飞机 比赛 规则\n\n(86 refs; tab [0] sleeps beside it)`,
    },
    {
      e: "call",
      id: 2,
      call: 2,
      status: "ok",
      ms: 980,
      url: SEARCH_URL,
      feed: `scrolled to '示例百科'. now: ${SEARCH_TITLE} (${SEARCH_URL})`,
      page: SEARCH_PAGE,
    },
    { ...calls([call(3, "browse", "", { action: "fetch", url: PDF_URL })], 2), round: 2 },
    {
      e: "call",
      id: 2,
      call: 3,
      status: "ok",
      ms: 3410,
      chars: 2140,
      text: "示例体育馆使用规则\n\n比赛日场地按小时计费;观众席限 200 人;馆内风速需低于 0.5 米/秒。\n\n(表格:各时段的价格与开放时间)",
      feed: "示例体育馆使用规则\n\n比赛日场地按小时计费;观众席限 200 人;馆内风速需低于 0.5 米/秒。\n\n(表格:各时段的价格与开放时间)",
      page: { url: PDF_URL, title: PDF_TITLE },
    },
    { ...base, id: 3, round: 3 },
    { e: "say", id: 3, t: "一组机械动作打包成一次调用:滚动、点进百科、回列表。" },
    calls(
      [
        call(1, "browse", "", {
          action: "multi",
          steps: [
            { action: "scroll", text: "示例百科" },
            { action: "click", ref: "e118" },
          ],
        }),
      ],
      3,
    ),
    {
      e: "call",
      id: 3,
      call: 1,
      status: "ok",
      ms: 4120,
      url: SEARCH_URL,
      n: 110,
      steps: [
        {
          action: "scroll",
          status: "ok",
          label: `scrolled to '示例百科'. now: ${SEARCH_TITLE}`,
          url: SEARCH_URL,
          title: SEARCH_TITLE,
        },
        {
          action: "click",
          status: "ok",
          label: `clicked. now: ${WIKI_TITLE}`,
          url: WIKI_URL,
          title: WIKI_TITLE,
        },
      ],
      feed: `1. scroll: scrolled to '示例百科'. now: ${SEARCH_TITLE} (${SEARCH_URL})\n2. click: clicked. now: ${WIKI_TITLE} (${WIKI_URL})\n\n-- the action navigated: every old ref is dead, the fresh outline is below --`,
      page: { url: WIKI_URL, title: WIKI_TITLE },
    },
    {
      e: "sources",
      items: [
        browserSource(1, 1, SEARCH_PAGE, true),
        browserSource(2, 2, { url: RULES_URL, title: RULES_TITLE }, false),
      ],
    },
    { ...base, id: 4, round: 4 },
    {
      e: "say",
      id: 4,
      t: "滚到规则表格,把页脚的入会二维码解码出来,再整批截一张最终版面的图,作为交付前的视觉核对。",
    },
    calls(
      [
        call(1, "browse", "", {
          action: "multi",
          steps: [{ action: "scroll", text: "比赛规则" }, { action: "decode", ref: "e186" }, { action: "screenshot" }],
        }),
      ],
      4,
    ),
    {
      e: "call",
      id: 4,
      call: 1,
      status: "ok",
      ms: 3860,
      // a multi that ENDS on a screenshot: the early-exit settlement's
      // feed is the attachment line alone -- the step summaries must ride
      // `steps` beside img+shot or the row's step list collapses; the
      // decode step's label IS its payload (the decoded text the model
      // read in the feed)
      img: FRAME,
      shot: true,
      steps: [
        {
          action: "scroll",
          status: "ok",
          label: `scrolled to '比赛规则'. now: ${WIKI_TITLE}`,
          url: WIKI_URL,
          title: WIKI_TITLE,
        },
        {
          action: "decode",
          status: "ok",
          label: "decoded QRCode: https://app.example.org/invite?code=ppc",
          url: WIKI_URL,
          title: WIKI_TITLE,
        },
        {
          action: "screenshot",
          status: "ok",
          label: "viewport captured",
          url: WIKI_URL,
          title: WIKI_TITLE,
        },
      ],
      feed: "screenshot attached -- it is visible to you in the next turn.",
      page: { url: WIKI_URL, title: WIKI_TITLE },
    },
    { e: "open", id: 5, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "think",
      id: 5,
      t: "两个搜索页 + 百科条目互相印证:滑翔形最均衡、馆内风速要低于 0.5 米/秒[1][2]。最终截图确认了百科页的版面,浏览器探索的页面已在来源里,直接给结论。",
    },
    {
      e: "answer",
      t: "比赛用**滑翔形**最稳妥,翼面宽、滞空久[1];示例体育馆要求馆内风速低于 **0.5 米/秒**,回旋动作不吃分[2]。百科条目与比赛规则已核对,最终截图确认页面版面无误。",
    },
    { e: "close", id: 5 },
    settled(usage(26100, 1740, 1050, 11800)),
  ],
};
