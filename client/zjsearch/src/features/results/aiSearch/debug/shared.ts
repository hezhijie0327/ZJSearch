// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * The debug stage's shared DEMO material.  Every scenario is set in one
 * fictional place -- a school paper-plane club preparing for its contest --
 * and draws on the same six demo pages.  Nothing here is a real research
 * subject: the club, its numbers and every page are invented for the stage.
 */

/** The demo pages a run can gather (title / url / netloc / snippet). */
export const PAGES = {
  folds: {
    title: "三种经典折法的步骤图解",
    url: "https://example.com/folds",
    netloc: "example.com",
    content: "镖形、滑翔形、特技形三种折法的分解步骤与各自的适用场景。",
  },
  weight: {
    title: "纸张克重对飞行距离的影响(社团实测)",
    url: "https://paper.example.org/weight-test",
    netloc: "paper.example.org",
    content: "70g 与 80g 的 A4 纸各投 20 次,80g 平均多飞 1.8 米。",
  },
  venue: {
    title: "示例体育馆场地租用价目表",
    url: "https://venue.example.net/price",
    netloc: "venue.example.net",
    content: "工作日 200 元/小时,周末 300 元/小时,含 20 张折叠桌。",
  },
  angle: {
    title: "投掷角度与滞空时间的关系(社团实验)",
    url: "https://lab.example.org/angle",
    netloc: "lab.example.org",
    content: "10 度投掷滞空最久,45 度投掷距离最远。",
  },
  club: {
    title: "纸飞机社团招新帖",
    url: "https://club.example.org/join",
    netloc: "club.example.org",
    content: "每周五下午活动,新社员需先在会员系统登记。",
  },
  records: {
    title: "往届比赛成绩表",
    url: "https://records.example.org/2025",
    netloc: "records.example.org",
    content: "去年冠军用滑翔形飞出 18.6 米,平均滞空 6.2 秒。",
  },
};

export type Page = keyof typeof PAGES;

/** Fields every item of one `sources` event shares: the producing batch
    (the row-join keys) and, inside a subagent, the `agent` tag. */
export type Batch = Record<string, unknown>;

/**
 * ONE scenario's source registry.  `[n]` is the order a page JOINS the
 * registry (the live wire numbers sources by arrival), so a scenario never
 * hard-codes a number: `join` returns the `sources` event, `cite` the [n]
 * marks its prose should carry -- the two cannot drift apart.
 */
export function sourceBook() {
  const numbers: Partial<Record<Page, number>> = {};
  let count = 0;
  /** number the pages not numbered yet, in the given order */
  const reserve = (...pages: Page[]): void => {
    for (const page of pages) {
      if (numbers[page] === undefined) {
        count += 1;
        numbers[page] = count;
      }
    }
  };
  return {
    /** number pages BEFORE they join -- for a call's arguments that cite a
        page its own round is about to gather (the args render before the
        `sources` event lands) */
    reserve,
    /** the `sources` event for pages joining the registry now */
    join(batch: Batch, ...pages: Page[]): Record<string, unknown> {
      reserve(...pages);
      return { e: "sources", items: pages.map((page) => ({ ...batch, ...PAGES[page], n: numbers[page] })) };
    },
    /** a page the BROWSER reached (not one of the demo pages) joining the
        registry as the next number */
    mintPage(batch: Batch, fields: Record<string, unknown>): Record<string, unknown> {
      count += 1;
      const item = { idx: count - 1, favicon: "", crawled: false, browser: true, ...batch, ...fields, n: count };
      return { e: "sources", items: [item] };
    },
    /** the [n] mark(s) of joined pages, for the prose's citations */
    cite(...pages: Page[]): string {
      return pages.map((page) => `[${numbers[page] ?? 0}]`).join("");
    },
    /** the bare number of a joined page (a `dupes` list, a feed line) */
    number(page: Page): number {
      return numbers[page] ?? 0;
    },
  };
}

/** The first research entry of a run: spread and override per entry. */
export const base = { e: "open", id: 1, kind: "research", round: 1 };

/** A round's tool-call batch (the items are PENDING here; each settles
    through its own `call` event). */
export function calls(items: Array<Record<string, unknown>>, id = 1): Record<string, unknown> {
  return { e: "calls", id, items };
}

/** One pending tool-call row: `q` is the row's label, `args` its raw
    arguments (the debug pane's text). */
export function call(
  id: number,
  tool: string,
  q: string,
  args: Record<string, unknown>,
  name?: string,
): Record<string, unknown> {
  return { id, tool, name, q, status: "pending", args };
}

/** The settle's usage block: the research / write split derives from the
    totals so the numbers stay self-consistent across scenarios. */
export function usage(input: number, output: number, thoughts: number, cached: number): Record<string, unknown> {
  return {
    input,
    output,
    thoughts,
    cached,
    cache_write: 0,
    research: { input: Math.round(input * 0.78), output: Math.round(output * 0.3) },
    write: { input: Math.round(input * 0.22), output: Math.round(output * 0.7) },
    gates: { input: 640, output: 32, calls: 3 },
    rerank: { calls: 2, tokens: 1360 },
    decision: { calls: 4, tokens: 980 },
  };
}

export const MODEL = "demo-model";

/** The fictional deployment's engine inventory: what `list_engines`
    answers and its row renders as two directory grids. */
export const INVENTORY = {
  total: 48,
  categories: [
    { name: "general", count: 12 },
    { name: "images", count: 8 },
    { name: "news", count: 6 },
    { name: "videos", count: 5 },
    { name: "science", count: 5 },
    { name: "it", count: 4 },
    { name: "files", count: 4 },
    { name: "dictionaries", count: 4 },
  ],
  disabled: [
    { name: "demo.paid", bang: "demo", cats: ["general"], paid: true },
    { name: "archive.demo", bang: "arc", cats: ["it", "files"], paid: false },
  ],
};

/** A run that finished normally. */
export function settled(usageBlock: Record<string, unknown>): Record<string, unknown> {
  return { e: "settle", status: "done", finish: "stop", usage: usageBlock, model: MODEL };
}

/** A 1x1 JPEG stand-in for a mirror frame: the real wire carries the
    frame's jpeg bytes as a data URL, the stage only needs a decodable one. */
const TINY_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAASACADASIAAhEBAxEB/8QAGwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8xRcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxeiiiqAKKKKACiiigAooooA//2Q==";

export const FRAME = `data:image/jpeg;base64,${TINY_JPEG}`;

/** An ANNOTATED mirror frame, synthesized: the page as a few grey blocks
    and the capture-time annotation the server paints into the jpeg (the
    dashed family-palette outlines around two clickable elements and their
    ref badges). */
export const ANNOTATED_FRAME = `data:image/svg+xml;utf8,${[
  `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='270'>`,
  `<rect width='480' height='270' fill='#f4f1ea'/>`,
  `<rect x='24' y='20' width='120' height='14' rx='4' fill='#8c6800'/>`,
  `<rect x='24' y='56' width='432' height='10' rx='3' fill='#d9d2c3'/>`,
  `<rect x='24' y='76' width='380' height='10' rx='3' fill='#d9d2c3'/>`,
  `<rect x='24' y='110' width='150' height='34' rx='6' fill='#fffdf7' stroke='#8c6800' stroke-width='2' stroke-dasharray='6 4'/>`,
  `<rect x='24' y='166' width='220' height='34' rx='6' fill='#fffdf7' stroke='#b5541c' stroke-width='2' stroke-dasharray='6 4'/>`,
  `<rect x='24' y='110' width='26' height='14' fill='#8c6800'/>`,
  `<rect x='24' y='166' width='26' height='14' fill='#b5541c'/>`,
  `<text x='37' y='121' font-family='monospace' font-size='10' fill='#fffdf7' text-anchor='middle'>e1</text>`,
  `<text x='37' y='177' font-family='monospace' font-size='10' fill='#fffdf7' text-anchor='middle'>e2</text>`,
  `</svg>`,
].join("")}`;

/** A wide stand-in image for the answer gallery (a 640x360 SVG data URL). */
export const GALLERY_IMAGE = `data:image/svg+xml;utf8,${[
  `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='360'>`,
  `<rect width='100%' height='100%' fill='%23262a33'/>`,
  `<text x='50%' y='50%' fill='%23e8e0cc' font-size='28' text-anchor='middle' font-family='sans-serif'>DEMO IMAGE 640x360</text>`,
  `</svg>`,
].join("")}`;
