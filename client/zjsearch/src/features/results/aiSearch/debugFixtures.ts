// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { AiSearchMode } from "@/features/results/aiSearch/timeline.ts";

/**
 * The AI debug stage's FIXTURE STREAMS: wire-event scripts replayed
 * through the REAL fold (`applyEvent`) so the debug page exercises the
 * exact renderers a live run uses -- every tool row kind in every
 * status, the report document's outline/section/artifact events, the
 * clarify gate and the failed settle.  A new tool row or a new wire
 * event ships with a fixture here (the stage is the UI's own audit).
 */

export interface DebugScenario {
  id: string;
  label: string;
  q: string;
  mode: AiSearchMode;
  events: Array<Record<string, unknown>>;
  /** OPTIONAL continuation after the clarify gate is answered: the stage
      passes the user's transcript (or "" on skip) and the returned events
      replay from the awaiting settle -- the simulator's submit/skip are
      wired to this, so the clarify flow is testable end to end. */
  clarifyTail?: (transcript: string) => Array<Record<string, unknown>>;
}

const SOURCES = [
  {
    n: 1,
    title: "多肽原料药(CDMO)行业深度报告",
    url: "https://example.com/peptide-report",
    netloc: "example.com",
    round: 1,
    id: 1,
    idx: 0,
    content: "全球多肽原料药市场规模 2025 年达到 41.2 亿美元,年复合增速 8.6%。",
  },
  {
    n: 2,
    title: "Novo Nordisk API 供应商名录",
    url: "https://pharma.example.com/novo-suppliers",
    netloc: "pharma.example.com",
    round: 1,
    id: 1,
    idx: 1,
    content: "Novo Nordisk 的肽类原料药长期供应商包括 Polypeptide 与 Bachem。",
  },
  {
    n: 3,
    title: "深圳市2025年房地产统计数据",
    url: "https://stats.example.com/sz-2025",
    netloc: "stats.example.com",
    round: 1,
    id: 2,
    idx: 0,
    content: "2025 年深圳新房成交均价 5.8 万/㎡,二手房挂牌量 6.2 万套。",
  },
  {
    n: 4,
    title: "Peptide API capacity analysis",
    url: "https://chem.example.com/capacity",
    netloc: "chem.example.com",
    round: 2,
    id: 1,
    idx: 1,
    content: "Chinese CDMO capacity share reached 28% of global peptide API supply.",
  },
  {
    n: 5,
    title: "翰宇药业年报摘要",
    url: "https://cninfo.example.com/hanyu",
    netloc: "cninfo.example.com",
    round: 3,
    id: 3,
    idx: 0,
    content: "报告期内公司多肽原料药业务收入 4.7 亿元,同比增长 32%。",
  },
];

const base = {
  e: "open",
  id: 1,
  kind: "research",
  round: 1,
};

function calls(items: Array<Record<string, unknown>>, id = 1): Record<string, unknown> {
  return { e: "calls", id, items };
}

/** EVERY tool row kind × status, the report document mid-stream, the
    decision card, sources, findings, plan -- the whole surface. */
const FULL_STAGE: DebugScenario = {
  id: "full",
  label: "all tool rows × states (report in progress)",
  q: "多肽原料药全球竞争格局与深圳住宅市场价格矩阵深度调研",
  mode: "report",
  events: [
    {
      e: "client.start",
      runNo: 1,
      q: "多肽原料药全球竞争格局与深圳住宅市场价格矩阵深度调研",
      mode: "report",
      // attachment METADATA only -- the bytes live in the browser's
      // attachment table; the simulator inlines a tiny SVG so the thumb
      // renders (the real flow loads them from the attachment table)
      attachments: [
        {
          kind: "file",
          mime: "text/markdown",
          name: "background.md",
          bytes: 96,
          data: "# 背景\n\n- 2025 深圳新房成交均价 5.8 万/㎡(限购松绑后)\n- 多肽原料药 GLP-1 供应链为主要增量",
        },
        {
          kind: "image",
          mime: "image/svg+xml",
          name: "产能分布草图.svg",
          bytes: 480,
          data: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='8' fill='%23f0e6d2'/><rect x='10' y='34' width='12' height='20' fill='%23b08c3e'/><rect x='26' y='24' width='12' height='30' fill='%238c6800'/><rect x='42' y='12' width='12' height='42' fill='%235c4400'/></svg>",
        },
      ],
    },
    // the PRE-FLIGHT verdicts (route-side gates riding _drive's preamble):
    // the decisions card OPENS with them before the loop's first event
    {
      e: "decisions",
      items: [
        {
          purpose: "depth_probe",
          question: "How deep and broad does the research need to be (score 0-4)?",
          target: "多肽原料药全球竞争格局…",
          answer: {
            type: "score",
            score: 4,
            probabilities: { 0: 0.01, 1: 0.02, 2: 0.07, 3: 0.25, 4: 0.65 },
            legend: { 4: "Exhaustive" },
            confidence: 0.65,
          },
          ms: 620,
        },
        {
          purpose: "outline",
          question: "The report skeleton: sections and the deliverable entities they cover",
          target: "多肽原料药全球竞争格局 × 深圳住宅市场价格矩阵深度调研",
          sections: 5,
          entities: 1,
          uncovered: 1,
          ms: 1480,
        },
      ],
    },
    { ...base },
    { e: "phase", name: "plan" },
    { e: "say", id: 1, t: "拆解为竞争格局、产能对比与深圳价格矩阵三条线,先做行业面,再落到片区数据。" },
    { e: "think", id: 1, t: "先并行三组检索:行业规模、头部供应商、深圳分片区价格;读页留给承载关键数字的来源。" },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "多肽原料药 全球市场规模 2025",
        status: "pending",
        args: { query: "多肽原料药 全球市场规模 2025" },
      },
      {
        id: 2,
        tool: "search_web",
        q: "深圳 新房成交均价 分片区 2025",
        status: "pending",
        args: { query: "深圳 新房成交均价 分片区 2025", category: "general" },
      },
      {
        id: 3,
        tool: "search_web",
        q: "peptide API CDMO capacity share",
        status: "error",
        ms: 3210,
        args: { query: "peptide API CDMO capacity share" },
        feed: "error: the search failed",
      },
      {
        id: 4,
        tool: "update_plan",
        q: "2/4",
        status: "ok",
        ms: 412,
        args: {
          items: [
            { title: "全球竞争格局与头部玩家", status: "active" },
            { title: "产能与投资对比", status: "active" },
            { title: "深圳分片区价格矩阵", status: "done" },
            { title: "风险与机会评估", status: "pending" },
          ],
        },
        feed: "plan written: 1/4 subtasks covered. Search each subtask's keywords; when a subtask's evidence is in, mark it done yourself via update_plan (the card only tracks which sources landed where).",
      },
      {
        id: 5,
        tool: "list_engines",
        q: "",
        status: "pending",
        args: {},
      },
    ]),
    { e: "sources", items: [SOURCES[0], SOURCES[1], SOURCES[2]] },
    { e: "call", id: 1, call: 1, status: "ok", n: 5, ms: 2395, feed: "plan: 5 deep + 5 shallow lines [1][2]…" },
    { e: "call", id: 1, call: 2, status: "ok", n: 8, ms: 1870, feed: "plan: 5 deep + 5 shallow lines [3]…" },
    { e: "call", id: 1, call: 3, status: "error", ms: 3210, feed: "error: the search failed" },
    { e: "call", id: 1, call: 4, status: "ok", ms: 412, feed: "plan written: 1/4 subtasks covered." },
    {
      e: "call",
      id: 1,
      call: 5,
      status: "ok",
      n: 361,
      ms: 0,
      // the STRUCTURED inventory: the row's chevron renders the category
      // chip cloud + the cap-expandable bang rows (the feed keeps the
      // model's plain-text copy -- the debug pane shows its head)
      inventory: {
        total: 361,
        categories: [
          { name: "general", count: 95 },
          { name: "it", count: 52 },
          { name: "images", count: 48 },
          { name: "videos", count: 42 },
          { name: "news", count: 32 },
          { name: "other", count: 38 },
          { name: "science", count: 19 },
          { name: "web", count: 17 },
          { name: "packages", count: 17 },
          { name: "music", count: 14 },
          { name: "files", count: 14 },
          { name: "repos", count: 11 },
          { name: "social media", count: 10 },
          { name: "stock images", count: 10 },
          { name: "wikimedia", count: 8 },
          { name: "scientific publications", count: 8 },
          { name: "dictionaries", count: 7 },
          { name: "translate", count: 6 },
          { name: "q&a", count: 6 },
          { name: "icons", count: 6 },
          { name: "movies", count: 5 },
          { name: "software wikis", count: 5 },
          { name: "map", count: 3 },
          { name: "weather", count: 3 },
          { name: "apps", count: 4 },
          { name: "blogs", count: 8 },
          { name: "books", count: 4 },
          { name: "shopping", count: 2 },
        ],
        disabled: [
          { name: "1337x", bang: "1337x", cats: ["files"], paid: false },
          { name: "bocha", bang: "bocha", cats: ["general", "web"], paid: true },
          { name: "bocha images", bang: "bochai", cats: ["images"], paid: true },
          { name: "brave.api", bang: "brapi", cats: ["general", "web"], paid: true },
          { name: "digbt", bang: "dbt", cats: ["videos", "music", "files"], paid: false },
          { name: "exa", bang: "exa", cats: ["general", "web"], paid: true },
          { name: "firecrawl", bang: "fc", cats: ["general", "web"], paid: true },
          { name: "firecrawl news", bang: "fcn", cats: ["news"], paid: true },
          { name: "google.api", bang: "goapi", cats: ["general"], paid: true },
          { name: "openfda", bang: "fda", cats: ["science"], paid: true },
          { name: "search1api youtube", bang: "s1yt", cats: ["music", "videos"], paid: true },
          { name: "tavily", bang: "tvly", cats: ["general", "web"], paid: true },
          { name: "tavily finance", bang: "tvlf", cats: ["finance", "other"], paid: true },
          { name: "tavily news", bang: "tvlyn", cats: ["news"], paid: true },
        ],
      },
      feed: 'This deployment searches 361 enabled engines across 28 categories:\n  apps (4) · blogs (8) · books (4) · …\nDisabled engines (12) -- a bang prefix still reaches them, e.g. "!shortcut keywords":\n  bocha (bang: bocha) -- general, web\n  …',
    },
    {
      e: "plan",
      items: [
        { title: "全球竞争格局与头部玩家", status: "active", sources: [1, 2] },
        { title: "产能与投资对比", status: "active", sources: [] },
        { title: "深圳分片区价格矩阵", status: "done", sources: [3] },
        { title: "风险与机会评估", status: "pending" },
      ],
    },
    {
      e: "findings",
      items: [
        {
          id: 1,
          text: "全球多肽原料药市场 2025 年规模 41.2 亿美元,CAGR 8.6%[1]。",
          refs: [1],
          tags: ["多肽原料药", "市场规模"],
          status: "active",
          round: 1,
        },
        {
          id: 2,
          text: "中国 CDMO 产能占全球多肽原料药供给的 28%[4]。",
          refs: [4],
          tags: ["CDMO", "多肽原料药"],
          status: "active",
          round: 1,
        },
        {
          id: 3,
          text: "另一家机构口径:2025 年全球规模 52 亿美元,CAGR 12%[6],与 [1] 的统计口径明显不一致。",
          refs: [6],
          tags: ["多肽原料药", "市场规模"],
          status: "active",
          round: 1,
          conflict_with: 1,
        },
        {
          id: 4,
          text: "早期草案:多肽原料药 2025 年规模约 30 亿美元[2]。",
          refs: [2],
          tags: ["多肽原料药"],
          status: "superseded",
          round: 1,
        },
      ],
      gaps: [{ id: 1, q: "深圳各片区二手房挂牌量与成交周期", why: "价格矩阵需要供给面数据", status: "open" }],
    },
    {
      ...base,
      id: 2,
      round: 2,
    },
    { e: "phase", name: "research" },
    { e: "say", id: 2, t: "行业面已立住;这轮读承载关键数字的两页,并补深圳片区明细。" },
    calls(
      [
        {
          id: 1,
          tool: "browse",
          q: "",
          url: "https://example.com/peptide-report",
          status: "ok",
          chars: 12480,
          ms: 8420,
          args: { action: "read", url: "https://example.com/peptide-report" },
          feed: 'Opened https://example.com/peptide-report (title: "多肽原料药行业深度报告"; source [1]):\n\n# 多肽原料药行业深度报告\n全球多肽原料药市场…',
        },
        {
          id: 2,
          tool: "browse",
          q: "",
          url: "https://dead.example.com/404",
          status: "error",
          ms: 15200,
          args: { action: "read", url: "https://dead.example.com/404" },
          feed: "error: page reader HTTP 404: not found",
        },
        {
          id: 3,
          tool: "calculate",
          q: "41.2 * 1.086",
          result: "44.7432",
          status: "ok",
          ms: 3,
          args: { expression: "41.2 * 1.086", precision: 4 },
          feed: '{"expression": "41.2 * 1.086", "result": "44.7432"}',
        },
        {
          id: 4,
          tool: "evaluate",
          q: "哪家 CDMO 产能扩张最激进",
          status: "ok",
          ms: 940,
          result: "choice: 中国CDMO (p=0.72)",
          args: {
            state: "…",
            questions: [{ name: "aggressive", instructions: "哪家 CDMO 产能扩张最激进?", type: "choice" }],
          },
        },
        {
          id: 5,
          tool: "record_findings",
          q: "",
          status: "ok",
          n: 2,
          ms: 5,
          args: {
            facts: [
              { text: "深圳 2025 新房成交均价 5.8 万/㎡[3]。", refs: [3] },
              { text: "翰宇药业多肽原料药收入 4.7 亿元,同比 +32%[5]。", refs: [5] },
            ],
          },
          feed: "recorded: 2 new facts; the writer reads the active list",
        },
        {
          id: 6,
          tool: "recall_history",
          q: "深圳 房地产 政策",
          status: "ok",
          n: 3,
          ms: 12,
          args: { query: "深圳 房地产 政策" },
          feed: "matched 3 past sources; heads follow",
        },
        {
          id: 7,
          tool: "memory",
          q: "深圳",
          name: "search",
          status: "ok",
          n: 1,
          ms: 4,
          args: { action: "search", query: "深圳" },
          feed: "- 用户关注深圳本地房产政策",
        },
        {
          id: 8,
          tool: "mcp",
          name: "maps_geo",
          q: "深圳湾",
          status: "ok",
          ms: 460,
          text: '{"country":"中国","province":"广东省","city":"深圳市","district":"南山区"}',
          args: { address: "深圳湾" },
          feed: "geocode result: 深圳 南山",
        },
        {
          id: 13,
          tool: "mcp",
          name: "search_tools",
          q: "engine inventory",
          status: "ok",
          n: 2,
          ms: 3,
          args: { query: "engine inventory" },
          feed: '[{"name":"list_engines","server":"","description":"List the search ENGINES this deployment carries","inputSchema":{"type":"object","properties":{},"required":[]},"instructions":"Consult it ONCE, and only when it can change a decision."}]',
          tools: [
            {
              name: "list_engines",
              server: "",
              description:
                "List the search ENGINES this deployment carries: the enabled ones grouped by category, and the engines kept disabled by default -- still reachable by their bang.",
              params: [],
              required: [],
              instructions:
                "Consult it ONCE, and only when it can change a decision: when unsure which vertical fits, when searches keep coming back thin or empty, or before relying on a niche vertical.",
            },
            {
              name: "mcp_amap_maps_search_poi",
              server: "amap-maps",
              description: "Search points of interest around a location (POI keyword search).",
              params: ["keywords", "city", "page"],
              required: ["keywords"],
              instructions: "返回结果含名称、地址与距离；城市名可显著提升命中率。",
            },
          ],
        },
        {
          id: 9,
          tool: "build_table",
          q: "头部多肽 CDMO 产能对比",
          status: "ok",
          n: 4,
          ms: 6,
          args: {
            title: "头部多肽 CDMO 产能对比",
            columns: ["企业", "产能(吨/年)", "扩产投资", "投产时间"],
            rows: [
              { cells: ["Polypeptide", "≈12", "€1.4亿", "2026"], refs: [1, 4] },
              { cells: ["Bachem", "≈9", "CHF 1.1亿", "2025"], refs: [4] },
              { cells: ["诺泰生物", "≈5", "¥8.2亿", "2025"], refs: [5] },
              { cells: ["翰宇药业", "≈4", "¥6.5亿", "2026"], refs: [5] },
            ],
            note: "产能为公开披露口径的估计值",
          },
          feed: "table 1 recorded: 头部多肽 CDMO 产能对比 (4 rows x 4 columns). It reaches the report as a real table -- interpret it in the relevant section, do not re-type the numbers.",
        },
        {
          id: 10,
          tool: "inspect_image",
          q: "source [4] 产能图",
          status: "ok",
          ms: 1200,
          args: {
            url: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='8' fill='%23e8e0cc'/><circle cx='32' cy='32' r='20' fill='%238c6800'/></svg>",
            n: 4,
          },
          preview: "https://chem.example.com/capacity-chart",
          feed: "image fetched and attached -- it is visible to you in the next turn (source [4]).",
        },
        {
          id: 11,
          tool: "build_table",
          q: "",
          status: "error",
          ms: 2,
          args: { title: "残缺表" },
          feed: "error: build_table needs a title, 2+ columns and at least one row -- a table the writer can cite.",
        },
        {
          id: 12,
          tool: "ask_user",
          q: "",
          status: "pending",
          args: {
            intro: "报告侧重产业还是置业建议?",
            questions: [{ q: "报告的主要用途?", type: "single", options: ["产业投资", "置业参考", "学术研究"] }],
          },
        },
      ],
      2,
    ),
    { e: "sources", items: [SOURCES[3], SOURCES[4]] },
    {
      e: "call",
      id: 2,
      call: 1,
      status: "ok",
      chars: 12480,
      ms: 8420,
      // the READING PANE payload: what the model actually read -- the row's
      // chevron expands to it (scroll-capped), the debug pane shows the raw
      // args + receipt; without this field the fixture cannot demo the fold
      text: "# 多肽原料药(CDMO)行业深度报告\n\n## 市场规模\n\n全球多肽原料药市场 2025 年规模 **41.2 亿美元**,2019-2025 年 CAGR 8.6%;其中 GLP-1 相关肽类占比从 31% 升至 58%。\n\n## 产能格局\n\n| 企业 | 产能(吨/年) | 扩产投资 |\n|---|---|---|\n| Polypeptide | ≈12 | €1.4亿 |\n| Bachem | ≈9 | CHF 1.1亿 |\n| 诺泰生物 | ≈5 | ¥8.2亿 |\n\n欧洲双雄占据高端合成订单,中国企业以 40-60% 的成本优势切入仿制肽与轻改造肽。\n\n## 采购要点\n\n- 长约锁价周期从 2 年缩短至 1 年,买方倾向分批定价;\n- 固相合成 overcrowding:2026 年新产能投产后价格战风险上升;\n- 质量审计成本占交付价 8-12%,FDA 483 记录是硬门槛。",
    },
    { e: "call", id: 2, call: 2, status: "error", ms: 15200, feed: "error: page reader HTTP 404: not found" },
    {
      e: "call",
      id: 2,
      call: 13,
      status: "ok",
      n: 2,
      ms: 3,
      feed: '[{"name":"list_engines","server":"","description":"List the search ENGINES this deployment carries","inputSchema":{"type":"object","properties":{},"required":[]},"instructions":"Consult it ONCE, and only when it can change a decision."}]',
      tools: [
        {
          name: "list_engines",
          server: "",
          description:
            "List the search ENGINES this deployment carries: the enabled ones grouped by category, and the engines kept disabled by default -- still reachable by their bang.",
          params: [],
          required: [],
          instructions:
            "Consult it ONCE, and only when it can change a decision: when unsure which vertical fits, when searches keep coming back thin or empty, or before relying on a niche vertical.",
        },
        {
          name: "mcp_amap_maps_search_poi",
          server: "amap-maps",
          description: "Search points of interest around a location (POI keyword search).",
          params: ["keywords", "city", "page"],
          required: ["keywords"],
          instructions: "返回结果含名称、地址与距离；城市名可显著提升命中率。",
        },
      ],
    },
    {
      e: "call",
      id: 2,
      call: 3,
      status: "ok",
      ms: 3,
      result: "44.7432",
      feed: '{"expression": "41.2 * 1.086", "result": "44.7432"}',
    },
    {
      e: "call",
      id: 2,
      call: 4,
      status: "ok",
      ms: 940,
      result: "中国CDMO (72%)",
      // the STRUCTURED verdict: the row's chevron renders the same
      // probability bars as the rail's decision card (one judgment, one
      // rendering); `preview` mirrors the text the model saw
      answers: {
        aggressive: {
          type: "choice",
          choice: "中国CDMO",
          probabilities: { 中国CDMO: 0.72, 欧洲双雄: 0.21, 其他: 0.07 },
          confidence: 0.72,
        },
      },
      preview:
        "哪家 CDMO 产能扩张最激进?\n  choice: 中国CDMO (72.0%)\n  - 中国CDMO 72%\n  - 欧洲双雄 21%\n  - 其他 7%\n  confidence: 72%",
    },
    { e: "call", id: 2, call: 5, status: "ok", n: 2, ms: 5, feed: "recorded: 2 new facts" },
    {
      e: "call",
      id: 2,
      call: 6,
      status: "duplicate",
      ms: 2,
      dupes: [3],
      feed: "duplicate: all hits already numbered [3]",
    },
    {
      e: "call",
      id: 2,
      call: 7,
      status: "ok",
      n: 1,
      ms: 4,
      args: { action: "search", query: "深圳" },
      // preview = the recalled memory lines (the server's search_memories
      // output) -- folded into `text`, the row's chevron shows what was recalled
      preview: "- 用户常住深圳, 关注本地房产政策与学区\n- 用户偏好简洁的结论式回答",
    },
    {
      e: "call",
      id: 2,
      call: 8,
      status: "ok",
      ms: 460,
      preview:
        '{\n  "country": "中国",\n  "province": "广东省",\n  "city": "深圳市",\n  "district": "南山区",\n  "adcode": "440305",\n  "location": "113.9304,22.5333"\n}',
    },
    { e: "call", id: 2, call: 9, status: "ok", n: 4, ms: 6, feed: "table 1 recorded" },
    {
      e: "call",
      id: 2,
      call: 10,
      status: "ok",
      ms: 1200,
      preview: "https://chem.example.com/capacity-chart",
      feed: "image fetched and attached -- it is visible to you in the next turn (source [4]).",
    },
    { e: "call", id: 2, call: 11, status: "error", ms: 2, feed: "error: build_table needs a title…" },
    // ask_user settles TOO: in the real loop a solo ask_user call always
    // ENDS the run (awaiting) -- a permanently-pending ask row mid-timeline
    // is unrealistic and made the replay look stuck at the last row
    {
      e: "call",
      id: 2,
      call: 12,
      status: "ok",
      ms: 300,
      feed: "ask recorded -- the run continues on the user's best interpretation",
    },
    {
      e: "artifact",
      id: 1,
      item: {
        title: "头部多肽 CDMO 产能对比",
        columns: ["企业", "产能(吨/年)", "扩产投资", "投产时间"],
        rows: [
          { cells: ["Polypeptide", "≈12", "€1.4亿", "2026"], refs: [1, 4] },
          { cells: ["Bachem", "≈9", "CHF 1.1亿", "2025"], refs: [4] },
          { cells: ["诺泰生物", "≈5", "¥8.2亿", "2025"], refs: [5] },
          { cells: ["翰宇药业", "≈4", "¥6.5亿", "2026"], refs: [5] },
        ],
        note: "产能为公开披露口径的估计值",
      },
    },
    {
      e: "decisions",
      items: [
        {
          purpose: "evaluate",
          question: "哪家 CDMO 产能扩张最激进?",
          target: "全球竞争格局与头部玩家",
          answers: {
            aggressive: {
              type: "choice",
              choice: "中国CDMO",
              probabilities: { 中国CDMO: 0.72, 欧洲双雄: 0.21, 其他: 0.07 },
              confidence: 0.72,
            },
          },
          record_questions: [{ name: "aggressive", instructions: "哪家 CDMO 产能扩张最激进?" }],
          ms: 940,
        },
        {
          purpose: "coverage",
          question: "Per open subtask: covered by this round's new sources (noul 0-1, above threshold suggests done)",
          target: "全球竞争格局与头部玩家 / 产能与投资对比",
          answers: {
            task_0: { noul: 0.77, type: "noul" },
            task_1: { noul: 0.77, type: "noul" },
          },
          ms: 583,
        },
        {
          // the deliverable-entity gate speaks the ONE named-verdict-map
          // protocol (the server's entity_gate.py): answer keyed task_N
          // (row labels resolve from the target's " / " sequence -- the
          // entity names), per-entity covered/uncovered choice
          // primitives, and record_questions carrying the why-text -- the
          // old entities/uncovered LIST fields rendered an empty card
          purpose: "entity_coverage",
          question: "Deliverable entities the answer makes claims about; screened against the plan",
          target: "Novo Nordisk / Cytiva",
          answer: {
            task_0: {
              choice: "covered",
              confidence: 1,
              probabilities: { covered: 1, uncovered: 0 },
              type: "choice",
            },
            task_1: {
              choice: "uncovered",
              confidence: 1,
              probabilities: { covered: 0, uncovered: 1 },
              type: "choice",
            },
          },
          record_questions: [
            {
              name: "task_0",
              instructions: "Novo Nordisk -- the answer's supplier-side recommendations rest on its API sourcing",
            },
            {
              name: "task_1",
              instructions: "Cytiva -- the recommended purification counterpart; no subtask studies it",
            },
          ],
          ms: 120,
        },
        {
          purpose: "depth_probe",
          question: "How deep and broad does the research need to be (score 0-4)?",
          target: "多肽原料药全球竞争格局…",
          answer: {
            type: "score",
            score: 4,
            probabilities: { 0: 0.01, 1: 0.02, 2: 0.07, 3: 0.25, 4: 0.65 },
            legend: { 4: "Exhaustive" },
            confidence: 0.65,
          },
          ms: 812,
        },
        {
          purpose: "citation_gate",
          question: "Spot check: are the sampled citations supported by their sources?",
          target: "全球竞争格局与头部玩家",
          answer: { c_4: "noul" },
          record_questions: [
            {
              name: "citation_gate",
              instructions: "Spot check: are the sampled citations supported by their sources?",
            },
          ],
          ms: 640,
        },
      ],
    },
    { e: "close", id: 1 },
    { e: "close", id: 2 },
    { e: "open", id: 3, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      // the WRITER's reasoning on the write entry: the settled report
      // surfaces it as the folded 思考过程 toggle at the document's top
      e: "think",
      id: 3,
      t: "两线材料都已闭环:格局线有份额与扩产节点[2][4],房价线有均价与片区样本[3]。执行摘要先给双线结论;格局章用 xychart 呈现中国 CDMO 份额爬升;风险章收在可执行判断上。",
    },
    {
      e: "outline",
      title: "多肽原料药全球竞争格局 × 深圳住宅市场价格矩阵深度调研",
      subtitle: "科研与产业双线:供给侧格局 + 置业侧价格锚点",
      sections: [
        { id: "summary", title: "执行摘要", status: "done" },
        { id: "s1", title: "全球竞争格局与头部玩家", status: "writing" },
        { id: "s2", title: "产能与投资对比", status: "pending" },
        { id: "s3", title: "深圳分片区价格矩阵", status: "pending" },
        { id: "s4", title: "风险与机会评估", status: "pending" },
      ],
    },
    {
      e: "section",
      id: "summary",
      t: "**基线判断.** 全球多肽原料药处于产能军备竞赛早段:需求端 GLP-1 药物放量驱动,2025 年市场规模 41.2 亿美元,CAGR 8.6%[1];供给端中国 CDMO 已占全球产能 28%[4],扩产节奏最激进。\n\n**核心逻辑.** 产能与合规资质是双重壁垒,头部企业以长约锁定订单[2];深圳住宅市场则呈「新房定价锚、二手房以量换价」格局,2025 年新房成交均价 5.8 万/㎡[3]。",
    },
    {
      e: "section",
      id: "s1",
      t: '全球供给由欧洲老牌 CDMO 与中国新锐共同主导。Novo Nordisk 的肽类原料药长期供应商包括 Polypeptide 与 Bachem[2];中国企业以成本与响应速度切入,翰宇药业多肽原料药业务收入 4.7 亿元,同比增长 ==32%==[5]。\n\n> [!IMPORTANT] 格局判断\n> 产能军备竞赛已进入中国时间:三大头部扩产项目全部在 2026 年前落地[4],欧洲厂商的合计份额将首次跌破五成。\n\n中国 CDMO 全球产能份额的爬升轨迹[4]:\n\n```mermaid\nxychart\n  title "中国 CDMO 全球产能份额 (%)"\n  x-axis [2021, 2022, 2023, 2024, 2025]\n  y-axis "份额 (%)" 0 --> 40\n  bar [12, 16, 21, 25, 28]\n  line [12, 16, 21, 25, 28]\n```\n\n份额数据为四家头部厂商公开披露口径的加总估计[4,5]。',
    },
    {
      e: "related",
      items: [
        "GLP-1 供应瓶颈会持续到何时?",
        "深圳前海 vs 光明:哪个片区性价比更高?",
        "中国 CDMO 的 EHS 合规风险有哪些?",
      ],
    },
    {
      // the run-level settle: WITHOUT it the stage replays forever as
      // "streaming" -- MermaidBlock never mounts (settled gate) and the
      // report document never reaches its final render path
      e: "settle",
      status: "done",
      finish: "stop",
      usage: {
        input: 21400,
        output: 1980,
        thoughts: 1140,
        cached: 9030,
        cache_write: 0,
        research: { input: 16800, output: 1520 },
        write: { input: 4600, output: 460 },
        gates: { input: 1180, output: 96, calls: 6 },
        rerank: { calls: 5, tokens: 3980 },
        decision: { calls: 9, tokens: 2140 },
      },
      model: "deepseek-flash",
    },
  ],
};

const AWAITING_STAGE: DebugScenario = {
  id: "awaiting",
  label: "clarify gate (awaiting)",
  q: "帮我调研一下新能源车的电池",
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: "帮我调研一下新能源车的电池", mode: "balanced" },
    { ...base },
    { e: "phase", name: "plan" },
    {
      e: "ask",
      intro: "电池调研的范围需要先对齐:",
      questions: [
        { q: "关注哪种电池技术?", type: "multi", options: ["磷酸铁锂", "三元锂", "固态电池"] },
        { q: "视角是购车决策还是产业研究?", type: "single", options: ["购车决策", "产业研究"] },
      ],
    },
    { e: "settle", status: "awaiting", halt: "awaiting the user's direction", finish: null, usage: null, model: null },
  ],
  clarifyTail: (transcript) => [
    {
      e: "client.clarify",
      text: transcript,
      startedAt: Date.now(),
      mode: "balanced",
    },
    { e: "open", id: 2, kind: "research", round: 1 },
    { e: "phase", name: "research" },
    { e: "say", id: 2, t: "按确认的方向收窄:三元锂+固态的购车视角,补贴与车型对比并行。" },
    {
      e: "calls",
      id: 2,
      items: [
        {
          id: 1,
          tool: "search_web",
          q: "三元锂 固态电池 车型 2025 对比",
          status: "pending",
          args: { query: "三元锂 固态电池 车型 2025 对比" },
        },
        {
          id: 2,
          tool: "search_web",
          q: "新能源车 购置税减免 2025 政策",
          status: "pending",
          args: { query: "新能源车 购置税减免 2025 政策" },
        },
      ],
    },
    {
      e: "sources",
      items: [
        {
          n: 4,
          title: "2025 新能源购车补贴与购置税政策解读",
          url: "https://policy.example.com/nev-2025",
          netloc: "policy.example.com",
          round: 2,
          id: 1,
          idx: 0,
          content: "2025 年购置税减免延续,单车免税额上限 3 万元。",
        },
        {
          n: 5,
          title: "固态电池量产时间表:头部车企规划",
          url: "https://auto.example.com/solid-state",
          netloc: "auto.example.com",
          round: 2,
          id: 2,
          idx: 0,
          content: "半固态电池已在量产车装载,全固态预计 2027 年小批量。",
        },
      ],
    },
    { e: "call", id: 2, call: 1, status: "ok", n: 9, ms: 1620, feed: "plan: 5 deep + 5 shallow lines [4][5]" },
    { e: "call", id: 2, call: 2, status: "ok", n: 6, ms: 1735, feed: "plan: 5 deep lines [4]" },
    {
      e: "findings",
      items: [
        { id: 1, text: "2025 年购置税减免延续,单车免税额上限 3 万元[4]。", refs: [4], status: "active", round: 2 },
      ],
      gaps: [],
    },
    {
      e: "plan",
      items: [
        { title: "电池技术路线对比(购车视角)", status: "done", sources: [4, 5] },
        { title: "政策与成本核算", status: "done", sources: [4] },
      ],
    },
    { e: "close", id: 2 },
    { e: "open", id: 3, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "answer",
      t: "从**购车决策**视角,两条技术路线的答案已经很清晰:\n\n- **磷酸铁锂**:成本最低、循环寿命长,适合预算敏感、以城区通勤为主的购车[4];\n- **三元锂**:能量密度高、低温衰减小,长途与北方用户优先[4];\n- **固态电池**:半固态已量产,全固态预计 2027 年小批量上车[5]——现在购车无需为它等待,但可关注支持换电的车型以延长生命周期。\n\n**结论**:2025 年购车,磷酸铁锂与三元锂的车型选择充足且政策友好(购置税减免延续,上限 3 万元/车)[4];把预算放在续航与充电条件匹配上,比等待固态电池更实际。",
    },
    { e: "close", id: 3 },
    { e: "related", items: ["固态电池车型 2026 年有哪些?", "电池衰减质保政策怎么读?", "换电车型值不值得买?"] },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      usage: {
        input: 12840,
        output: 412,
        thoughts: 660,
        cached: 5210,
        cache_write: 0,
        research: { input: 8940, output: 230 },
        write: { input: 3900, output: 182 },
        gates: { input: 640, output: 48, calls: 3 },
        rerank: { calls: 2, tokens: 1520 },
        decision: null,
      },
      model: "deepseek-flash",
    },
  ],
};

const STOPPED_STAGE: DebugScenario = {
  id: "stopped",
  label: "stopped state (title keying)",
  q: "深度对比三家 CDMO 的合规记录",
  mode: "report",
  events: [
    { e: "client.start", runNo: 1, q: "深度对比三家 CDMO 的合规记录", mode: "report" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "先并行两家已披露处罚记录的检索,第三家走监管官网。" },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "CDMO 药监处罚记录 对比",
        status: "pending",
        args: { query: "CDMO 药监处罚记录 对比" },
      },
    ]),
    {
      e: "sources",
      items: [
        {
          n: 1,
          title: "CDMO 合规监管处罚公开数据库",
          url: "https://compliance.example.com/cdmo-penalties",
          netloc: "compliance.example.com",
          round: 1,
          id: 1,
          idx: 0,
          content: "近三年 CDMO 企业药监处罚记录汇总,含警告信与召回事件。",
        },
      ],
    },
    { e: "settle", status: "error", halt: "stopped_by_user", finish: null, usage: null, model: null },
  ],
};

const FAILED_STAGE: DebugScenario = {
  id: "failed",
  label: "failed state (receipt + continue)",
  q: "深度对比三家 CDMO 的合规记录",
  mode: "report",
  events: [
    { e: "client.start", runNo: 1, q: "深度对比三家 CDMO 的合规记录", mode: "report" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "先并行检索三家企业的 FDA/EMA 合规记录。" },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "CDMO FDA 483 warning letters",
        status: "ok",
        n: 6,
        ms: 2100,
        args: { query: "CDMO FDA 483 warning letters" },
      },
      {
        id: 2,
        tool: "browse",
        q: "",
        url: "https://fda.example.com/letters",
        status: "ok",
        chars: 8210,
        ms: 6100,
        args: { action: "read", url: "https://fda.example.com/letters" },
      },
    ]),
    { e: "sources", items: [SOURCES[0]] },
    { e: "call", id: 1, call: 1, status: "ok", n: 6, ms: 2100, feed: "plan: 5 deep lines [1]" },
    { e: "call", id: 1, call: 2, status: "ok", chars: 8210, ms: 6100, feed: "Opened …" },
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
      model: "deepseek-flash",
    },
  ],
};

const DONE_STAGE: DebugScenario = {
  id: "done",
  label: "single-write done (balanced)",
  q: "Kimi K3 的上下文长度是多少?",
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: "Kimi K3 的上下文长度是多少?", mode: "balanced" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "这是一个查数型问题,一轮两条检索即可。" },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "Kimi K3 context length",
        status: "ok",
        n: 4,
        ms: 1420,
        args: { query: "Kimi K3 context length" },
      },
      {
        id: 2,
        tool: "search_web",
        q: "Kimi K3 上下文长度 官方",
        status: "duplicate",
        ms: 1300,
        dupes: [1],
        args: { query: "Kimi K3 上下文长度 官方" },
      },
    ]),
    { e: "sources", items: [SOURCES[1]] },
    { e: "call", id: 1, call: 1, status: "ok", n: 4, ms: 1420, feed: "plan: 5 deep lines [2]" },
    {
      e: "call",
      id: 1,
      call: 2,
      status: "duplicate",
      ms: 1300,
      dupes: [2],
      feed: "duplicate: all hits already numbered [2]",
    },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      // the WRITER's reasoning: streams into the answer-column 思考过程
      // toggle (expanded live, folded once the answer takes over, and it
      // stays re-openable above the settled answer)
      e: "think",
      id: 2,
      t: "两条检索互相印证:官方口径 256K 上下文窗口 + 长文档场景 8K 输出[2]。答案一句话给数、带引用,不铺陈。",
    },
    {
      e: "answer",
      // the related fence is intercepted SERVER-side (the loop's
      // FenceSplitter) -- the client only ever sees the prose + the
      // related event; a fence in `answer` would render as a raw code block
      t: "Kimi K3 提供 **256K** 上下文窗口[2],并在长文档场景下支持 8K 的输出长度。",
    },
    { e: "close", id: 2 },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      usage: {
        input: 4210,
        output: 186,
        thoughts: 220,
        cached: 2048,
        cache_write: 0,
        research: { input: 4210, output: 30 },
        write: { input: 3900, output: 156 },
        gates: { input: 500, output: 22, calls: 2 },
        rerank: { calls: 1, tokens: 780 },
        decision: null,
      },
      model: "deepseek-flash",
    },
  ],
};

/** The DECK output shape end to end: mode "deck" puts 智能PPT + the deck
    presets in the pre-outline 输出结构 picker (the shape filter), the
    outline snapshot's `shape: "deck"` flips the document to DeckView,
    and the settled run shows the chapter structure card plus the
    write-think toggle at the deck's top (hidden while it writes). */
const DECK_STAGE: DebugScenario = {
  id: "deck",
  label: "deck done (deck)",
  q: "多肽原料药产业格局 × 深圳置业价格锚点速览",
  mode: "deck",
  events: [
    { e: "client.start", runNo: 1, q: "多肽原料药产业格局 × 深圳置业价格锚点速览", mode: "deck" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "速览型报告:一轮检索拿格局与价格锚点,幻灯片按章节组织。" },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "多肽原料药 全球产能 格局 2025",
        status: "ok",
        n: 3,
        ms: 1180,
        args: { query: "多肽原料药 全球产能 格局 2025" },
      },
    ]),
    { e: "sources", items: [SOURCES[0], SOURCES[1], SOURCES[2]] },
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      n: 3,
      ms: 1180,
      feed: "plan: 3 deep lines [1]",
    },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      // the WRITER's reasoning: hidden while the deck writes (the
      // document is the progress surface), shown at the deck's top once
      // settled
      e: "think",
      id: 2,
      t: "章节按「格局 → 机会 → 价格锚点」推进:每章一到两页,数字全部带引用;最后一章收在置业侧的判断上,与报告的双线结论呼应。",
    },
    {
      e: "outline",
      title: "多肽原料药产业格局 × 深圳置业价格锚点",
      subtitle: "产业与置业双线速览",
      shape: "deck",
      sections: [
        { id: "c1", title: "行业全景:格局与产能", status: "writing" },
        { id: "c2", title: "中国 CDMO 的机会窗口", status: "pending" },
        { id: "c3", title: "深圳置业价格锚点", status: "pending" },
      ],
    },
    {
      e: "section",
      id: "c1",
      t: "# 全球格局:军备竞赛早段\n- 需求端 **GLP-1 放量**:2025 年市场规模 41.2 亿美元,CAGR 8.6%[1]\n- 供给端中国 CDMO 已占 **28%** 全球产能[2]\n\n---\n\n# 头部玩家\n- 欧洲老牌:Polypeptide、Bachem[2]\n- 中国新锐:翰宇药业多肽业务收入 4.7 亿元,**+32%**[3]",
    },
    {
      e: "section",
      id: "c2",
      t: "# 机会窗口\n- 产能与合规资质是**双重壁垒**,头部以长约锁定订单[2]\n- 2026 年前三大扩产项目落地,欧洲合计份额首次跌破五成[2]",
    },
    {
      e: "section",
      id: "c3",
      t: "# 深圳价格锚点\n- 新房成交均价 **5.8 万/㎡**(2025,限购松绑后)[3]\n- 二手房「以量换价」,挂牌 6.2 万套[3]",
    },
    {
      e: "outline",
      title: "多肽原料药产业格局 × 深圳置业价格锚点",
      subtitle: "产业与置业双线速览",
      shape: "deck",
      sections: [
        { id: "c1", title: "行业全景:格局与产能", status: "done" },
        { id: "c2", title: "中国 CDMO 的机会窗口", status: "done" },
        { id: "c3", title: "深圳置业价格锚点", status: "done" },
      ],
    },
    {
      e: "related",
      items: ["GLP-1 供应瓶颈会持续到何时?", "深圳前海 vs 光明:哪个片区性价比更高?"],
    },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      usage: {
        input: 9840,
        output: 920,
        thoughts: 640,
        cached: 3100,
        cache_write: 0,
        research: { input: 7200, output: 620 },
        write: { input: 2640, output: 300 },
        gates: { input: 500, output: 24, calls: 2 },
        rerank: { calls: 2, tokens: 1400 },
        decision: null,
      },
      model: "deepseek-flash",
    },
  ],
};

/** The SHAPE FLIP: a report-mode run whose user flips 报告→演示文稿 while
    the research streams -- the canonical steer notice rides the timeline
    (the 引导行), and the outline snapshot arrives `shape: "deck"`: the
    fold flips run.deck off the SNAPSHOT (run.mode stays "report") and the
    document renders DeckView.  The write-think toggle sits at the deck's
    top once settled. */
const SHAPE_FLIP_STAGE: DebugScenario = {
  id: "shape-flip",
  label: "shape flip (guide injection · boundary flip)",
  q: "多肽原料药产业格局速览",
  mode: "report",
  events: [
    { e: "client.start", runNo: 1, q: "多肽原料药产业格局速览", mode: "report" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "先并行两组检索:行业规模与头部玩家。" },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "多肽原料药 市场规模 2025",
        status: "ok",
        n: 3,
        ms: 1240,
        args: { query: "多肽原料药 市场规模 2025" },
      },
    ]),
    { e: "sources", items: [SOURCES[0], SOURCES[1], SOURCES[2]] },
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      n: 3,
      ms: 1240,
      feed: "plan: 3 deep lines [1]",
    },
    {
      // the shape flip's canonical notice: the control endpoint queued it
      // as a guide AND parked the pending shape for the write boundary
      e: "steer",
      text: "The output format switched to a presentation deck: for any remaining research, favor slide-ready points, numeric comparisons and chart-able material; gathered material need not be redone.",
      delivery: "guide",
      status: "drained",
    },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "think",
      id: 2,
      t: "用户中途改了产出格式:按演示文稿组织——格局线一章、机会线一章,每章一到两页,数字全带引用。",
    },
    {
      e: "outline",
      title: "多肽原料药产业格局速览",
      subtitle: "演示文稿版",
      shape: "deck",
      sections: [
        { id: "c1", title: "行业全景:规模与增速", status: "writing" },
        { id: "c2", title: "机会窗口与头部玩家", status: "pending" },
      ],
    },
    {
      e: "section",
      id: "c1",
      t: "# 行业全景\n- 2025 年市场规模 **41.2 亿美元**,CAGR 8.6%[1]\n- 需求端 GLP-1 药物放量是核心驱动[1]",
    },
    {
      e: "section",
      id: "c2",
      t: "# 机会窗口\n- 产能与合规资质是**双重壁垒**[2]\n- 中国 CDMO 已占全球产能 28%,扩产最激进[2]",
    },
    {
      e: "outline",
      title: "多肽原料药产业格局速览",
      subtitle: "演示文稿版",
      shape: "deck",
      sections: [
        { id: "c1", title: "行业全景:规模与增速", status: "done" },
        { id: "c2", title: "机会窗口与头部玩家", status: "done" },
      ],
    },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      usage: {
        input: 7420,
        output: 640,
        thoughts: 410,
        cached: 2200,
        cache_write: 0,
        research: { input: 5300, output: 420 },
        write: { input: 2120, output: 220 },
        gates: { input: 400, output: 18, calls: 2 },
        rerank: { calls: 1, tokens: 620 },
        decision: null,
      },
      model: "deepseek-flash",
    },
  ],
};

/** THE MODEL'S OWN DELIVERABLE FLIP end to end: a plain balanced run -- the
    structure picker standing with the neutral 直接回答 face -- whose model
    calls set_deliverable in round 1.  The settled tool row folds run.mode
    to "report" (the picker's face lights up; a reader pick here would
    still outrank the model at the boundary), the research continues one
    more round unchanged, and the outline lands AT THE WRITE BOUNDARY
    like every native report run -- the document renders through
    DocumentView, the settled record keeps the structure card. */
const MODEL_FLIP_STAGE: DebugScenario = {
  id: "model-flip",
  label: "set_deliverable flip (balanced → report)",
  q: "帮我调研一下固态电池的产业化现状",
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: "帮我调研一下固态电池的产业化现状", mode: "balanced" },
    { ...base },
    { e: "phase", name: "plan" },
    {
      e: "say",
      id: 1,
      t: "请求点名了交付物(调研报告):先切换输出形态,再按技术路线、产业化进度、主要玩家三条线检索。",
    },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "固态电池 产业化 现状 2025",
        status: "pending",
        args: { query: "固态电池 产业化 现状 2025" },
      },
      {
        id: 2,
        tool: "set_deliverable",
        q: "report",
        status: "pending",
        args: { shape: "report" },
      },
    ]),
    {
      e: "sources",
      items: [
        {
          n: 1,
          title: "全固态电池产业化路线图 2025",
          url: "https://battery.example.com/roadmap",
          netloc: "battery.example.com",
          round: 1,
          id: 1,
          idx: 0,
          content: "硫化物路线量产时间点集中在 2027 年前后,头部厂商中试线已跑通。",
        },
        {
          n: 2,
          title: "固态电池装车测试进展汇总",
          url: "https://ev.example.com/tests",
          netloc: "ev.example.com",
          round: 1,
          id: 2,
          idx: 0,
          content: "两家整车厂的示范装车已完成冬季标定,能量密度 360Wh/kg。",
        },
      ],
    },
    { e: "call", id: 1, call: 1, status: "ok", n: 2, ms: 2140, feed: "plan: 5 deep lines [1][2]" },
    {
      e: "call",
      id: 1,
      call: 2,
      status: "ok",
      q: "report",
      ms: 1730,
      feed: 'deliverable shape set to report: an outline of 4 sections ("固态电池产业化现状调研报告") was minted. Keep researching exactly as planned -- every source you gather is what the sections will cite; the document itself is written at the write phase.',
    },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "research", round: 2 },
    {
      e: "think",
      id: 2,
      t: "路线与装车有了[1][2],还缺成本侧和玩家名单 -- 本轮补产业链报价与产能布局。",
    },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "固态电池 成本 产能布局 头部厂商",
        status: "ok",
        n: 3,
        ms: 1810,
        args: { query: "固态电池 成本 产能布局 头部厂商" },
      },
    ]),
    {
      e: "sources",
      items: [
        {
          n: 3,
          title: "固态电解质成本下降路径分析",
          url: "https://industry.example.com/cost",
          netloc: "industry.example.com",
          round: 2,
          id: 3,
          idx: 0,
          content: "规模化后硫化物电解质成本有望降至 15 美元/kWh 以下。",
        },
      ],
    },
    { e: "call", id: 2, call: 1, status: "ok", n: 3, ms: 1810, feed: "plan: 5 deep lines [3]" },
    { e: "close", id: 2 },
    { e: "open", id: 3, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "think",
      id: 3,
      t: "三线材料齐了:路线[1]、装车[2]、成本与产能[3]。执行摘要先给判断;进度章收数字;玩家章点名头部并留风险一句。",
    },
    {
      e: "outline",
      title: "固态电池产业化现状调研报告",
      subtitle: "",
      sections: [
        { id: "summary", title: "执行摘要", status: "done" },
        { id: "s1", title: "技术路线与量产时间表", status: "writing" },
        { id: "s2", title: "装车进度与性能表现", status: "pending" },
        { id: "s3", title: "成本走势与产能布局", status: "pending" },
      ],
    },
    {
      e: "section",
      id: "summary",
      t: "**基线判断.** 全固态电池处于中试向量产过渡的早段:硫化物路线的量产时间点集中在 2027 年前后[1],示范装车已完成冬季标定、能量密度 360Wh/kg[2]。成本是最大变量,规模化后电解质有望降至 15 美元/kWh 以下[3]。",
    },
    {
      e: "section",
      id: "s1",
      t: "三条电解质路线中,硫化物凭离子电导率领先成为主流选择,头部厂商的中试线已跑通[1]。量产窗口的共识在 2027 年前后,半固态作为过渡方案先行上车[1]。\n\n> [!IMPORTANT] 节奏判断\n> 2025-2027 是工艺定型期:设备与材料供应商的订单结构比整车发布更能说明真实进度[1]。",
    },
    {
      e: "outline",
      title: "固态电池产业化现状调研报告",
      subtitle: "",
      sections: [
        { id: "summary", title: "执行摘要", status: "done" },
        { id: "s1", title: "技术路线与量产时间表", status: "done" },
        { id: "s2", title: "装车进度与性能表现", status: "writing" },
        { id: "s3", title: "成本走势与产能布局", status: "pending" },
      ],
    },
    {
      e: "section",
      id: "s2",
      t: "两家整车厂的示范装车已完成冬季标定,能量密度 360Wh/kg[2],续航与充电曲线达到设计目标。半固态车型先行放量,全固态的公开工况数据仍集中在厂商口径[2]。",
    },
    {
      e: "section",
      id: "s3",
      t: "成本是产业化的最大变量:规模化后硫化物电解质有望降至 15 美元/kWh 以下[3],头部厂商的产能布局集中在 2026-2028 年落地[1][3]。",
    },
    {
      e: "outline",
      title: "固态电池产业化现状调研报告",
      subtitle: "",
      sections: [
        { id: "summary", title: "执行摘要", status: "done" },
        { id: "s1", title: "技术路线与量产时间表", status: "done" },
        { id: "s2", title: "装车进度与性能表现", status: "done" },
        { id: "s3", title: "成本走势与产能布局", status: "done" },
      ],
    },
    {
      e: "related",
      items: ["半固态路线会存在多久?", "固态电池成本何时与液态打平?", "哪些整车厂已锁定固态电池产能?"],
    },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      usage: {
        input: 11200,
        output: 890,
        thoughts: 620,
        cached: 3600,
        cache_write: 0,
        research: { input: 8400, output: 560 },
        write: { input: 2800, output: 330 },
        gates: { input: 460, output: 24, calls: 2 },
        rerank: { calls: 2, tokens: 1180 },
        decision: null,
      },
      model: "deepseek-flash",
    },
  ],
};

const BING_ANN_JPEG =
  "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";
/** The browser-ops scenario's REAL annotated mirror frame: a downscaled
    Bing SERP capture wearing the capture-time annotation overlay (the
    dashed family-palette outlines + ref badges) -- the one fixture byte
    stream the debug stage cannot synthesize, because the annotation is
    painted server-side into the jpeg. */

const TINY_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAASACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxeiiiqAKKKKACiiigAooooA//2Q==";

/** The browser session's login collaboration: the reader hits a sign-in
    wall, the model opens the page in the browser, the mirror streams
    frames while the user operates the Lightbox, and the post-operation
    read hands the page back.  Frames are 1x1 stand-ins (the real wire
    carries jpeg bytes; mirror frames are stripped from the event
    log, the screenshot's shot bytes persist). */
const BROWSER_STAGE: DebugScenario = {
  id: "browser",
  label: "browser login collaboration (mirror frame × wait user × screenshot)",
  q: "打开小红书的探索页,登录后看看首页热门内容",
  mode: "balanced",
  events: [
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "先读一次目标页;被登录墙挡住就开浏览器,页面交给你来登录。" },
    {
      e: "think",
      id: 1,
      t: "read 先行:返回内容若明显是登录表单,再用 open 打开同一页并 wait_user,把操作交给人。",
    },
    calls([
      {
        id: 1,
        tool: "browse",
        q: "",
        url: "https://www.xiaohongshu.com/explore",
        status: "pending",
        args: { action: "read", url: "https://www.xiaohongshu.com/explore" },
      },
    ]),
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      ms: 2840,
      url: "https://www.xiaohongshu.com/explore",
      chars: 186,
      feed: "登录 小红书 -- 扫码或使用手机号验证码登录…",
      text: "登录 小红书\n\n打开 App 扫码登录 · 使用手机验证码登录 · 其他登录方式\n\n未登录的访问只能看到登录引导页。\n\nLinks on the page:\n[登录](https://www.xiaohongshu.com/login)",
    },
    { ...base, id: 2, round: 2 },
    { e: "say", id: 2, t: "目标页是登录墙——开浏览器打开它,镜像已就绪,由你来完成登录。" },
    calls(
      [
        {
          id: 1,
          tool: "browse",
          q: "https://www.xiaohongshu.com/explore",
          url: "https://www.xiaohongshu.com/explore",
          status: "pending",
          args: { action: "open", url: "https://www.xiaohongshu.com/explore" },
        },
      ],
      2,
    ),
    {
      e: "browser",
      url: "https://www.xiaohongshu.com/explore",
      title: "小红书 - 你的生活指南",
      img: TINY_JPEG,
      w: 1920,
      h: 1080,
      // the model pointer: the QA surface for the drawn cursor + ripple
      px: 640,
      py: 156,
      pk: "click",
      // the action mark: the touched element's viewport box + its OWN
      // name (the server's snapshot vocabulary) -- the client composes
      // the i18n'd verb, the mirror draws the highlight + the label
      box: [560, 130, 160, 52],
      name: "登录",
    },
    {
      e: "sources",
      items: [
        {
          n: 1,
          round: 2,
          id: 1,
          idx: 0,
          title: "小红书 - 你的生活指南",
          url: "https://www.xiaohongshu.com/explore",
          netloc: "www.xiaohongshu.com",
          favicon: "",
          crawled: false,
        },
      ],
    },
    {
      e: "call",
      id: 2,
      call: 1,
      status: "ok",
      ms: 4380,
      feed: "opened https://www.xiaohongshu.com/explore -- 小红书 - 你的生活指南\n\ne1\tinput\t手机号\ne2\tbutton\t登录\ne3\ta\t扫码登录\n\n(this page is NEW source [1] -- cite it as [1])",
      page: { url: "https://www.xiaohongshu.com/explore", title: "小红书 - 你的生活指南" },
      img: `data:image/jpeg;base64,${TINY_JPEG}`,
      snapshot: "e1\tinput\t手机号\ne2\tbutton\t登录\ne3\ta\t扫码登录",
      n: 3,
      url: "https://www.xiaohongshu.com/explore",
    },
    { ...base, id: 3, round: 3 },
    calls(
      [
        {
          id: 1,
          tool: "browse",
          q: "",
          status: "pending",
          args: { action: "wait_user", seconds: 180 },
        },
      ],
      3,
    ),
    {
      e: "browser",
      url: "https://www.xiaohongshu.com/login",
      title: "扫码登录",
      img: TINY_JPEG,
      w: 1920,
      h: 1080,
      wait_left: 174,
      px: 912,
      py: 402,
      pk: "type",
      name: "安吉云上草原",
    },
    {
      e: "browser",
      url: "https://www.xiaohongshu.com/login",
      title: "扫码登录",
      img: TINY_JPEG,
      w: 1920,
      h: 1080,
      wait_left: 170,
    },
    {
      e: "browser",
      url: "https://www.xiaohongshu.com/explore",
      title: "小红书 - 你的生活指南",
      img: TINY_JPEG,
      w: 1920,
      h: 1080,
      wait_left: 149,
    },
    {
      e: "browser",
      url: "https://www.xiaohongshu.com/explore",
      title: "小红书 - 你的生活指南",
      img: TINY_JPEG,
      w: 1920,
      h: 1080,
      // the settled final frame carries the pointer: the QA surface for
      // the drawn cursor + ripple (the fold replaces wholesale -- only
      // the LAST event's coordinates show)
      px: 640,
      py: 156,
      pk: "click",
    },
    {
      e: "sources",
      items: [
        {
          n: 1,
          round: 3,
          id: 1,
          idx: 0,
          title: "小红书 - 你的生活指南",
          url: "https://www.xiaohongshu.com/explore",
          netloc: "www.xiaohongshu.com",
          favicon: "",
          crawled: true,
        },
      ],
    },
    {
      e: "call",
      id: 3,
      call: 1,
      status: "ok",
      ms: 31200,
      feed: "the user's operation window ended -- decide from the page below whether the goal is met or another window is needed.\n\nhttps://www.xiaohongshu.com/explore -- 小红书 - 你的生活指南\n\ne1\ta\t首页 e2\ta\t热门 e3\tbutton\t发布笔记\n\n--- the page's readable text ---\n\n首页推荐:Citywalk 路线合集……\n\n(the page is already your source [1] -- cite it as [1])",
      page: { url: "https://www.xiaohongshu.com/explore", title: "小红书 - 你的生活指南" },
      img: `data:image/jpeg;base64,${TINY_JPEG}`,
      url: "https://www.xiaohongshu.com/explore",
      chars: 3140,
      text: "小红书 - 你的生活指南\n\n首页推荐:Citywalk 路线合集、秋季穿搭、新机测评、家居高性价比改造……\n\n热门话题标签:#citywalk #穿搭日记 #数码测评",
    },
    { ...base, id: 4, round: 4 },
    calls(
      [
        {
          id: 1,
          tool: "browse",
          q: "",
          status: "pending",
          args: { action: "screenshot" },
        },
        {
          id: 2,
          tool: "browse",
          q: "",
          status: "pending",
          args: { action: "screenshot", ref: "e3" },
        },
        {
          id: 3,
          tool: "browse",
          q: "",
          status: "pending",
          args: { action: "hover", ref: "f1e4" },
        },
        {
          id: 4,
          tool: "browse",
          q: "",
          status: "pending",
          args: { action: "select", ref: "e8", values: ["热门"] },
        },
        {
          id: 5,
          tool: "browse",
          q: "",
          status: "pending",
          args: { action: "drag", x1: 640, y1: 700, x2: 980, y2: 700, steps: 20 },
        },
      ],
      4,
    ),
    {
      e: "call",
      id: 4,
      call: 1,
      status: "ok",
      ms: 640,
      feed: "screenshot attached -- it is visible to you in the next turn.",
      page: { url: "https://www.xiaohongshu.com/explore", title: "小红书 - 你的生活指南" },
      img: `data:image/jpeg;base64,${TINY_JPEG}`,
      shot: true,
    },
    {
      e: "call",
      id: 4,
      call: 2,
      status: "ok",
      ms: 720,
      feed: "screenshot attached -- it is visible to you in the next turn.",
      page: { url: "https://www.xiaohongshu.com/explore", title: "小红书 - 你的生活指南" },
      img: `data:image/jpeg;base64,${TINY_JPEG}`,
      shot: true,
    },
    {
      e: "call",
      id: 4,
      call: 3,
      status: "ok",
      ms: 410,
      feed: "hovered. now: 小红书 - 你的生活指南 (https://www.xiaohongshu.com/explore)",
      page: { url: "https://www.xiaohongshu.com/explore", title: "小红书 - 你的生活指南" },
      img: `data:image/jpeg;base64,${TINY_JPEG}`,
    },
    {
      e: "call",
      id: 4,
      call: 4,
      status: "ok",
      ms: 380,
      feed: "selected: 热门. now: 小红书 - 你的生活指南 (https://www.xiaohongshu.com/explore)",
      page: { url: "https://www.xiaohongshu.com/explore", title: "小红书 - 你的生活指南" },
      img: `data:image/jpeg;base64,${TINY_JPEG}`,
    },
    {
      e: "call",
      id: 4,
      call: 5,
      status: "ok",
      ms: 1240,
      feed: "dragged 640,700 -> 980,700. now: 小红书 - 你的生活指南 (https://www.xiaohongshu.com/explore)",
      page: { url: "https://www.xiaohongshu.com/explore", title: "小红书 - 你的生活指南" },
      img: `data:image/jpeg;base64,${TINY_JPEG}`,
    },
    { e: "open", id: 5, kind: "write", round: 4 },
    { e: "phase", name: "write" },
    {
      e: "answer",
      t: "登录后的首页热门内容集中在三类:**Citywalk 路线合集**(周末短途)、**秋季穿搭**(换季清单)和**新机测评**(影像对比为主)[1]。整体以图文笔记为主,互动集中在评论区。",
    },
    {
      e: "related",
      items: ["小红书 Citywalk 笔记怎么找", "秋季穿搭的热门标签", "新机测评博主推荐"],
    },
    { e: "close", id: 5 },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      usage: {
        input: 5210,
        output: 210,
        thoughts: 260,
        cached: 1024,
        cache_write: 0,
        research: { input: 5210, output: 40 },
        write: { input: 4900, output: 170 },
        gates: { input: 500, output: 22, calls: 2 },
        rerank: null,
        decision: null,
      },
      model: "deepseek-flash",
    },
  ],
};

/** The intervention surface: a drained guide steer at the boundary, a
    preempt interrupt mid-run, and a discarded steer at the write phase
    (the guide lane's visible death). */
const STEER_STAGE: DebugScenario = {
  id: "steer",
  label: "guide (boundary injection · preempt · undelivered)",
  q: "对比主流新能源品牌 2025 年的销量与产能布局",
  mode: "balanced",
  events: [
    { e: "client.start", q: "对比主流新能源品牌 2025 年的销量与产能布局", runNo: 1, mode: "balanced", startedAt: 0 },
    { e: "phase", name: "plan" },
    { e: "open", id: 1, kind: "research", round: 1 },
    { e: "say", id: 1, t: "先并行检索全球销量榜与头部产能公告。" },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "2025 新能源车企 全球销量 排名",
        status: "ok",
        n: 8,
        ms: 1834,
        args: { query: "2025 新能源车企 全球销量 排名" },
        feed: "plan: 5 deep + 5 shallow lines [1][2]…",
      },
      {
        id: 2,
        tool: "search_web",
        q: "新能源 产能布局 工厂 2025 公告",
        status: "ok",
        n: 6,
        ms: 2210,
        args: { query: "新能源 产能布局 工厂 2025 公告" },
        feed: "plan: 4 deep + 2 shallow lines [3][4]…",
      },
    ]),
    { e: "sources", items: [SOURCES[0], SOURCES[1]] },
    { e: "close", id: 1 },
    { e: "steer", text: "重点看国内品牌,海外厂商一笔带过就行", delivery: "guide", status: "drained" },
    { e: "open", id: 2, kind: "research", round: 2 },
    { e: "say", id: 2, t: "收到引导:转向国内品牌,重查比亚迪/吉利/长安的销量与产能。" },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "比亚迪 2025 销量 同比",
        status: "ok",
        n: 7,
        ms: 1450,
        args: { query: "比亚迪 2025 销量 同比" },
        feed: "plan: 5 deep + 2 shallow lines [5][6]…",
      },
      {
        id: 2,
        tool: "record_findings",
        q: "3 条",
        status: "ok",
        ms: 640,
        args: {
          facts: [
            { text: "比亚迪 2025 年前三季度销量同比 +18%[5]", refs: [5] },
            { text: "吉利银河系列产能向西安/宝鸡基地集中[6]", refs: [6] },
          ],
        },
        feed: "ledger: +2 facts",
      },
    ]),
    { e: "close", id: 2 },
    { e: "steer", text: "别管产能了,只对比销量与同比增速", delivery: "preempt", status: "drained" },
    { e: "steer", text: "顺便加一段出口数据", delivery: "guide", status: "discarded" },
    { e: "open", id: 3, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "answer",
      t: "按最新引导,只对比**销量与同比增速**(产能布局折叠为背景):\n\n- **比亚迪**:2025 前三季度销量同比 +18%[5],规模断层领先;\n- **吉利**:银河系列放量,增速跑赢行业[6];\n- 海外品牌按引导一笔带过。\n\n出口数据与产能明细未纳入本轮(引导未送达)。",
    },
    { e: "close", id: 3 },
    { e: "related", items: ["比亚迪 2025 出口数据怎么样?", "吉利银河 vs 比亚迪 单车型对比?"] },
    { e: "title", text: "比亚迪 2025 出口数据" },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      usage: {
        input: 9210,
        output: 380,
        thoughts: 540,
        cached: 4880,
        cache_write: 0,
        research: { input: 6510, output: 210 },
        write: { input: 2700, output: 170 },
        gates: { input: 320, output: 24, calls: 2 },
        rerank: { calls: 1, tokens: 760 },
        decision: null,
      },
      model: "deepseek-flash",
    },
  ],
};

/** The SUBAGENT surface: the delegation row, the folded sub row with
    its own think/call stream (round re-opens must NOT duplicate the row),
    the digest receipt riding the delegation row's second settlement, and
    a SUBAGENT browser frame (agent-tagged -- the rail card's tab strip). */
const SUB_STAGE: DebugScenario = {
  id: "sub",
  label: "subagents (delegation row · folded sub-timeline · browser tabs)",
  q: "调研全球动力电池产业:头部厂商产能;固态电池路线;钠离子进展",
  mode: "deep",
  events: [
    { ...base },
    { e: "phase", name: "research" },
    {
      e: "browser",
      url: "https://www.bing.com/search?q=ev+battery+industry",
      title: "ev battery industry - 搜索",
      img: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA4KCw0LCQ4NDA0QDw4RFiQXFhQUFiwgIRokNC43NjMuMjI6QVNGOj1OPjIySGJJTlZYXV5dOEVmbWVabFNbXVn/2wBDAQ8QEBYTFioXFypZOzI7WVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVn/wAARCABaAKADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCKiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/9k=",
      w: 1920,
      h: 1080,
      agent: "lead",
    },
    {
      e: "calls",
      id: 1,
      items: [
        {
          id: 1,
          tool: "delegate_research",
          q: "头部厂商产能与市占率",
          status: "pending",
          args: { title: "头部厂商产能与市占率", objective: "建立 2024-2025 头部电池厂商的产能与市占率矩阵" },
        },
      ],
    },
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      ms: 120,
      label: "S1 · 头部厂商产能与市占率",
      feed: "建立 2024-2025 头部电池厂商的产能与市占率矩阵",
    },
    {
      e: "open",
      id: 10000,
      kind: "sub",
      round: 1,
      title: "S1 · 头部厂商产能与市占率",
      objective: "建立 2024-2025 头部电池厂商的产能与市占率矩阵(宁德时代/LG/比亚迪为最小集合)",
    },
    // the child's reasoning STREAMS in deltas on the real wire -- three
    // chunks that must fold into ONE inner think row (the per-delta row
    // shredding bug's regression fixture)
    { e: "think", id: 10000, t: "子代理:先宽后窄," },
    { e: "think", id: 10000, t: "先全球格局" },
    { e: "think", id: 10000, t: "再单厂产能。" },
    {
      e: "calls",
      id: 10000,
      items: [
        { id: 1, tool: "search_web", q: "global EV battery market share 2025", status: "ok", n: 6, ms: 1640, args: {} },
      ],
    },
    { e: "sources", items: [SOURCES[0], SOURCES[1]] },
    { e: "call", id: 10000, call: 1, status: "ok", n: 6, ms: 1640, feed: "plan: 5 deep + 1 shallow [1][2]" },
    // the child's browser session: an AGENT-TAGGED mirror frame (the tab strip)
    {
      e: "browser",
      url: "https://www.bing.com/search?q=battery+capacity+2025",
      title: "battery capacity 2025 - 搜索",
      img: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA4KCw0LCQ4NDA0QDw4RFiQXFhQUFiwgIRokNC43NjMuMjI6QVNGOj1OPjIySGJJTlZYXV5dOEVmbWVabFNbXVn/2wBDAQ8QEBYTFioXFypZOzI7WVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVn/wAARCABaAKADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCKiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/9k=",
      w: 1920,
      h: 1080,
      agent: "sub-10000",
    },
    { e: "close", id: 10000 },
    // the child's round re-open: MUST NOT duplicate the sub row
    { e: "open", id: 10000, kind: "sub", round: 2, title: "" },
    { e: "close", id: 10000 },
    // the digest rides the delegation row's second settlement (the
    // 【子任务 Sn】 tag is the subagent's id for the rest of the run)
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      ms: 0,
      label: "S1 · 头部厂商产能与市占率",
      chars: 320,
      feed: "[Subtask S1] 头部厂商产能与市占率\n已确认:\n- 宁德时代市占率 ~37%[1]\n- 比亚迪自供 + 外供双线[2]\n未决:\n- LG 新增产能口径",
      result:
        "[Subtask S1] 头部厂商产能与市占率\n已确认:\n- 宁德时代市占率 ~37%[1]\n- 比亚迪自供 + 外供双线[2]\n未决:\n- LG 新增产能口径",
    },
    { e: "findings", round: 2, items: [], gaps: [] },
    { e: "close", id: 1 },
    // the context compaction separator (microcompact pass at a boundary)
    { e: "compact", round: 2, trigger: "micro", pre: 148_000, post: 121_000, summarized: 0, kept: 0 },
    // the lead's FOLLOW-UP (message_subtask): the next research round
    // addresses the REGISTERED subagent, whose stream re-opens the SAME
    // sub row (id 10000 -- stable across batches, never duplicates)
    { e: "open", id: 3, kind: "research", round: 2 },
    {
      e: "calls",
      id: 3,
      items: [
        {
          id: 1,
          tool: "message_subtask",
          q: "S1 · LG 新增产能口径未决,补一个带数字的口径对比",
          status: "pending",
          args: { id: "S1", message: "LG 新增产能口径未决:补一个带数字的口径对比" },
        },
      ],
    },
    {
      e: "call",
      id: 3,
      call: 1,
      status: "ok",
      ms: 0,
      label: "S1 · follow-up",
      feed: "LG 新增产能口径未决:补一个带数字的口径对比",
    },
    // the resumed child re-opens its row (same id, back to active)
    { e: "open", id: 10000, kind: "sub", round: 1, title: "" },
    { e: "think", id: 10000, t: "跟进收到:在已入册的产能矩阵上补 LG 口径,不重开调研。" },
    {
      e: "call",
      id: 10000,
      call: 1,
      status: "ok",
      n: 3,
      ms: 1220,
      feed: "LG 新增产能口径 2025 (GWh/年) [4]",
    },
    {
      e: "call",
      id: 3,
      call: 1,
      status: "ok",
      ms: 0,
      label: "S1 · follow-up",
      chars: 180,
      feed: "[Subtask S1] 头部厂商产能与市占率\n已确认:\n- LG 新增产能口径:GWh/年,与 [1] 同口径 [4]",
      result: "[Subtask S1] 头部厂商产能与市占率\n已确认:\n- LG 新增产能口径:GWh/年,与 [1] 同口径 [4]",
    },
    { e: "findings", round: 3, items: [], gaps: [] },
    { e: "close", id: 3 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "answer",
      t: "三个子面已并行调研完毕(头部格局/固态路线/钠离子进展),综合结论以子代理回传的矩阵为骨架逐节展开——产能口径、时间表与商业化阶段各自成段,引用来自各子任务的 [n] 来源。",
    },
    { e: "close", id: 2 },
    { e: "related", items: ["固态电池量产时间表最新?", "钠离子电池装车车型有哪些?"] },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      usage: {
        input: 15200,
        output: 520,
        thoughts: 800,
        cached: 8100,
        cache_write: 0,
        research: { input: 11200, output: 300 },
        write: { input: 4000, output: 220 },
        gates: { input: 210, output: 16, calls: 2 },
        rerank: { calls: 1, tokens: 640 },
        decision: null,
      },
      model: "deepseek-flash",
    },
  ],
};

/** The ANSWER-TAIL panorama: the gallery placeholder + gallery event (the
    zjs-images fence's client contract), and every LATE event the settle
    trails -- related, title, memory (a silent fold), tags, and the
    trailing usage event's ABSOLUTE gates bucket.  Nothing else in the
    stage exercised these, which is exactly how a rendering regression
    would have shipped unnoticed. */
const PANORAMA_STAGE: DebugScenario = {
  id: "panorama",
  label: "panorama (gallery · follow-up · title · memory · tags · gates)",
  q: "全景模拟:答案尾部的每个面",
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: "全景模拟:答案尾部的每个面", mode: "balanced" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "两轮材料即可:一条检索、一条页面读取。" },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "panorama fixture answers",
        status: "ok",
        n: 6,
        ms: 1180,
        args: { query: "panorama fixture answers" },
      },
    ]),
    { e: "sources", items: [SOURCES[1]] },
    { e: "call", id: 1, call: 1, status: "ok", n: 6, ms: 1180, feed: "6 条结果进入 feed [1]" },
    { e: "close", id: 1 },
    {
      e: "open",
      id: 2,
      kind: "research",
      round: 2,
    },
    { e: "think", id: 2, t: "读取第二来源的全文,给画廊一个可引用的图源。" },
    calls([
      {
        id: 1,
        tool: "browse",
        q: "example.com/peptide-report",
        status: "ok",
        ms: 2140,
        chars: 1520,
        args: { action: "read", url: "https://example.com/peptide-report" },
      },
    ]),
    { e: "sources", items: [SOURCES[2]] },
    {
      e: "call",
      id: 2,
      call: 1,
      status: "ok",
      ms: 2140,
      chars: 1520,
      preview: "The panorama fixture's reading pane: the page's clean text, archived under its url.",
      text: "The panorama fixture's reading pane: the page's clean text, archived under its url. It is long enough to render the folded reading pane with a measurable clamp.",
    },
    { e: "close", id: 2 },
    {
      e: "findings",
      items: [
        {
          id: 9,
          text: "全景场景覆盖答案尾部的全部晚期事件 [1]。",
          refs: [1],
          tags: ["答案尾部"],
          status: "active",
          round: 2,
        },
      ],
      gaps: [],
    },
    {
      e: "plan",
      items: [
        { title: "两条材料到位", status: "done" },
        { title: "答案尾部渲染验证", status: "active" },
      ],
    },
    { e: "phase", name: "write" },
    { e: "open", id: 3, kind: "write", round: 0 },
    {
      e: "answer",
      t: "全景场景把答案尾部逐一过一遍:引用落在 [1] 与 [2],下方的画廊占位符由 gallery 事件填充。\n\n{{zjs-gallery:0}}\n\n占位符之后的正文继续流动,验证占位符两侧的文本都完好。",
    },
    {
      e: "gallery",
      items: [
        {
          u: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='640' height='360'><rect width='100%' height='100%' fill='%23222'/><text x='50%' y='50%' fill='%23c9a227' font-size='28' text-anchor='middle'>gallery fixture</text></svg>",
          n: 2,
        },
      ],
    },
    {
      e: "answer",
      t: "\n\n画廊之后的行为不受影响——这正是要守住的部分。",
    },
    { e: "close", id: 3 },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      // the GUARD HALT chip: the run footer's short inline label + the
      // full sentence on hover (the facet this scenario exists to show)
      halt_reason: "stalled",
      usage: {
        input: 3810,
        output: 210,
        thoughts: 140,
        cached: 1024,
        cache_write: 0,
        research: { input: 2600, output: 60 },
        write: { input: 1210, output: 150 },
        gates: { input: 500, output: 22, calls: 2 },
        rerank: null,
        decision: null,
      },
      model: "deepseek-flash",
    },
    { e: "related", items: ["画廊占位符两侧的文本还在吗?", "gates 用量卡片显示了吗?"] },
    { e: "title", text: "全景模拟:答案尾部面面观" },
    { e: "memory", content: "用户的审计报告偏好深色主题" },
    { e: "tags", items: ["全景模拟", "答案尾部", "画廊"] },
    {
      e: "usage",
      gates: { calls: 5, tokens: 3120 },
    },
  ],
};

/** The PAID-ENGINE confirmation loop: the model's first !bocha bang is
    HELD by the executor's paid gate (status "approval" -- the row reads
    待用户确认), the feed teaches the ask_user confirmation, the run
    settles awaiting on the ask, and the user's yes comes back as the
    clarify transcript -- the resumed round re-runs the bang with
    paid_ok: true (the sticky approval) and real results flow. */
const PAID_STAGE: DebugScenario = {
  id: "paid",
  label: "paid engine confirmation (hold · ask_user · approved re-run)",
  q: "用 bocha 查一下 2026 年的国产 GPU 新品发布",
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: "用 bocha 查一下 2026 年的国产 GPU 新品发布", mode: "balanced" },
    { ...base },
    { e: "phase", name: "plan" },
    { e: "say", id: 1, t: "用户点名 bocha(计费引擎):先发起检索,若被扣下就向用户确认计费使用。" },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "!bocha 国产 GPU 新品发布 2026",
        status: "pending",
        args: { query: "!bocha 国产 GPU 新品发布 2026" },
      },
    ]),
    {
      e: "call",
      id: 1,
      call: 1,
      status: "approval",
      n: 0,
      ms: 0,
      feed: "held: the bang targets bocha -- an API-BILLED engine (every call costs the user money) and this run has no approval yet.  Ask ONCE: call ask_user (as the ONLY call of a turn) with a short confirmation naming the engine and that it is billed per call.  When the user APPROVES, re-run this search with paid_ok: true -- the approval covers the rest of the run.  If they decline, never set paid_ok and stay on the free engines.",
    },
    {
      e: "think",
      id: 1,
      t: "bocha 是计费引擎,执行器把检索扣下了——按规则先用 ask_user 问一次用户,批准后再带 paid_ok 重跑。",
    },
    // the ask turn is its OWN entry (a turn = one open; the ask_user call
    // is the position-1 call of entry 2 -- sharing entry 1's position
    // would overwrite the held search's approval settlement)
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "research", round: 1 },
    calls(
      [
        {
          id: 1,
          tool: "ask_user",
          q: "",
          status: "pending",
          args: {
            intro: "bocha 按调用计费,本次研究是否允许使用?",
            questions: [
              { q: "允许本次研究使用计费引擎 bocha 吗?", type: "single", options: ["允许", "不用,走免费引擎"] },
            ],
          },
        },
      ],
      2,
    ),
    {
      e: "call",
      id: 2,
      call: 1,
      status: "ok",
      ms: 4,
      feed: "ask recorded -- the run continues on the user's best interpretation",
    },
    {
      e: "ask",
      intro: "bocha 按调用计费,本次研究是否允许使用?",
      questions: [{ q: "允许本次研究使用计费引擎 bocha 吗?", type: "single", options: ["允许", "不用,走免费引擎"] }],
    },
    { e: "settle", status: "awaiting", halt: "awaiting the user's direction", finish: null, usage: null, model: null },
  ],
  clarifyTail: (transcript) => [
    {
      e: "client.clarify",
      text: transcript,
      startedAt: Date.now(),
      mode: "balanced",
    },
    { ...base, id: 2, round: 1 },
    { e: "phase", name: "research" },
    { e: "say", id: 2, t: "用户已批准 bocha:带 paid_ok 重跑检索,并行一路免费引擎对照。" },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "!bocha 国产 GPU 新品发布 2026",
        status: "ok",
        n: 8,
        ms: 2140,
        args: { query: "!bocha 国产 GPU 新品发布 2026", paid_ok: true },
      },
      {
        id: 2,
        tool: "search_web",
        q: "国产 GPU 新品发布 2026",
        status: "ok",
        n: 5,
        ms: 1870,
        args: { query: "国产 GPU 新品发布 2026", category: "news" },
      },
    ]),
    {
      e: "sources",
      items: [
        {
          n: 1,
          title: "摩尔线程 MTT S4000 发布:2026 年 Q2 规模量产",
          url: "https://chip.example.com/moore-s4000",
          netloc: "chip.example.com",
          round: 1,
          id: 1,
          idx: 0,
          content: "摩尔线程发布第四代 GPU MTT S4000,FP32 算力 25 TFLOPS,宣布 2026 年 Q2 规模量产。",
        },
        {
          n: 2,
          title: "壁仞科技发布 BR100 系列训练卡",
          url: "https://semiconductor.example.com/br100",
          netloc: "semiconductor.example.com",
          round: 1,
          id: 1,
          idx: 1,
          content: "壁仞 BR100 系列面向千亿参数大模型训练,互联带宽对标国际旗舰产品。",
        },
      ],
    },
    { e: "call", id: 2, call: 1, status: "ok", n: 8, ms: 2140, feed: "plan: 5 deep + 3 shallow lines [1][2]…" },
    { e: "call", id: 2, call: 2, status: "ok", n: 5, ms: 1870, feed: "plan: 5 deep lines [2]" },
    { e: "close", id: 2 },
    { e: "open", id: 3, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "answer",
      t: "2026 年国产 GPU 新品集中在两条线:**摩尔线程 MTT S4000**(FP32 25 TFLOPS,Q2 规模量产)[1]与**壁仞 BR100 系列训练卡**(对标国际旗舰互联带宽)[2]。计费引擎 bocha 的结果与免费引擎的新闻线互相印证。",
    },
    { e: "close", id: 3 },
    { e: "related", items: ["MTT S4000 的实际游戏性能如何?", "BR100 的互联带宽对标哪款产品?"] },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      usage: {
        input: 6840,
        output: 186,
        thoughts: 140,
        cached: 2100,
        cache_write: 0,
        research: { input: 5210, output: 96 },
        write: { input: 1630, output: 90 },
        gates: { input: 380, output: 18, calls: 2 },
        rerank: null,
        decision: null,
      },
      model: "deepseek-flash",
    },
  ],
};

/** The AI Overview debug stage's fixtures: the card's RAW stream text
    split into replay chunks -- <think> wrappers, the visible markdown
    answer, and the trailing run-meta sentinel are exactly what the real
    wire carries (splitAnswerStream/extractRunMeta parse them back out
    client-side).  These pin the parts no live search can test on
    demand: the streaming mid-state, the citation chips, the fence
    splitting and the failed settle. */
export interface AiOverviewDebugScenario {
  id: string;
  label: string;
  q: string;
  /** the raw stream text, chunk by chunk (each step is a freezable
      mid-stream state; the joined text is what state.text would hold) */
  chunks: string[];
  /** favicon + domain + title per citation, in [n] order */
  sources: Array<{ favicon: string; domain: string; t: string; u: string }>;
  /** the terminal phase once every chunk has streamed */
  phase: "done" | "error";
  /** the transport error message when phase === "error" */
  error?: string;
}

const OVERVIEW_SOURCES = [
  {
    favicon: "",
    domain: "chip.example.com",
    t: "摩尔线程 MTT S4000 发布:2026 年 Q2 规模量产",
    u: "https://chip.example.com/moore-s4000",
  },
  {
    favicon: "",
    domain: "semiconductor.example.com",
    t: "壁仞科技发布 BR100 系列训练卡",
    u: "https://semiconductor.example.com/br100",
  },
];

const META_SENTINEL =
  '<<<zjs-meta:{"finish":"stop","model":"deepseek-flash","usage":{"input":4210,"output":386,"thoughts":180,"cached":1024,"cache_write":0}}>>>';

const OVERVIEW_STREAMED: AiOverviewDebugScenario = {
  id: "ov-streamed",
  label: "full stream (think · citations · tail meta)",
  q: "2026 年国产 GPU 有哪些新进展?",
  chunks: [
    "<think>用户问国产 GPU 的 2026 进展。检索材料集中在摩尔线程与壁仞两条线:",
    "摩尔线程 MTT S4000 已宣布 Q2 量产,壁仞 BR100 面向训练侧。按时间线组织,数字带引用。</think>",
    "2026 年国产 GPU 的新进展集中在两条线:\n\n",
    "- **摩尔线程**:第四代 GPU MTT S4000,FP32 算力 25 TFLOPS,宣布 2026 年 Q2 规模量产[1];\n",
    "- **壁仞科技**:BR100 系列训练卡面向千亿参数大模型训练,互联带宽对标国际旗舰[2]。\n\n",
    "整体判断:制造与封装仍是约束,但训练侧的产品空白已被补上。",
    META_SENTINEL,
  ],
  sources: OVERVIEW_SOURCES,
  phase: "done",
};

const OVERVIEW_FENCES: AiOverviewDebugScenario = {
  id: "ov-fences",
  label: "fence-dense (splitter)",
  q: "给一个对比表和 mermaid 图",
  chunks: [
    "<think>带表格与 mermaid 的回答:splitAnswerStream 不能把 fence 里的内容当 think。</think>",
    '两家的定位对比:\n\n| | 摩尔线程 | 壁仞科技 |\n|---|---|---|\n| 主战场 | 图形+AI 推理 | 训练 |\n| 旗舰 | MTT S4000[1] | BR100[2] |\n\n```mermaid\nxychart\n  title "FP32 算力 (TFLOPS)"\n  bar [25, 43]\n```\n\n```python\n# fence 内的 <think> 与 [1] 都不是标记\nprint("[1]")\n```',
    META_SENTINEL,
  ],
  sources: OVERVIEW_SOURCES,
  phase: "done",
};

const OVERVIEW_ERROR: AiOverviewDebugScenario = {
  id: "ov-error",
  label: "failed state (receipt)",
  q: "AI 回答失败了长什么样",
  chunks: ["<think>正在整理来源…"],
  sources: [],
  phase: "error",
  error: "HTTP 502: the AI stream was cut before any content",
};

export const AI_OVERVIEW_SCENARIOS: AiOverviewDebugScenario[] = [OVERVIEW_STREAMED, OVERVIEW_FENCES, OVERVIEW_ERROR];

/** The section REWRITE lane end to end: a settled report whose §2's
    stream died mid-write -- the settle's outline coalescing flips the
    stuck `writing` status to `failed` (the spinning-forever guard), the
    TOC/heading warn and the rewrite chips mount -- then the LATE
    rewrite tail (outline/section events AFTER the settle, the
    LATE_KINDS contract) re-streams the section through the reset
    replacement and re-mints it `done`. */
const REWRITE_STAGE: DebugScenario = {
  id: "rewrite",
  label: "failed section → rewrite (report, post-settle lane)",
  q: "国产 GPU 显存生态现状调研",
  mode: "report",
  events: [
    { e: "client.start", runNo: 1, q: "国产 GPU 显存生态现状调研", mode: "report" },
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "两条线:显存颗粒的国产供给,以及整机厂商的适配进度。" },
    calls([
      {
        id: 1,
        tool: "search_web",
        q: "国产 GPU 显存颗粒 供应链",
        status: "ok",
        n: 4,
        ms: 1650,
        args: { query: "国产 GPU 显存颗粒 供应链" },
      },
      {
        id: 2,
        tool: "search_web",
        q: "国产显卡 显存适配 驱动",
        status: "ok",
        n: 3,
        ms: 1490,
        args: { query: "国产显卡 显存适配 驱动" },
      },
    ]),
    { e: "sources", items: [SOURCES[1], SOURCES[2]] },
    { e: "call", id: 1, call: 1, status: "ok", n: 4, ms: 1650, feed: "plan: 5 deep lines [2]" },
    { e: "call", id: 1, call: 2, status: "ok", n: 3, ms: 1490, feed: "plan: 5 deep lines [3]" },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "think",
      id: 2,
      t: "供给线有颗粒自给率与代工节点[2],适配线有整机机型与驱动里程碑[3]。§2 的上游材料最薄,写的时候保守给数。",
    },
    {
      e: "outline",
      title: "国产 GPU 显存生态现状调研",
      subtitle: "颗粒供给与整机适配的双线评估",
      sections: [
        { id: "summary", title: "执行摘要", status: "writing" },
        { id: "s1", title: "显存颗粒的国产供给格局", status: "pending" },
        { id: "s2", title: "整机适配与驱动生态", status: "pending" },
      ],
    },
    {
      e: "section",
      id: "summary",
      t: "**基线判断.** 国产显存生态呈「颗粒端单点突破、适配端长尾未平」结构:颗粒自给覆盖中容量 GDDR6[2],整机适配集中在主流发行版与头部整机[3]。",
    },
    {
      e: "section",
      id: "s1",
      t: "国产颗粒的量产节点集中在 2024-2025 年:中容量 GDDR6 已实现稳定供货[2],高频与 HBM 档位仍在验证线。代工侧的产能爬坡决定了 2026 年的自给率上限[2]。",
    },
    {
      // §2's stream DIED mid-write: no terminal snapshot, no failed mark
      // -- the pre-guard zombie (the screenshot's stuck spinner).  The
      // settle below carries the coalescing fix.
      e: "section",
      id: "s2",
      t: "整机适配方面,主流整机厂商已经完成",
    },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      usage: {
        input: 9820,
        output: 640,
        thoughts: 260,
        cached: 4110,
        cache_write: 0,
        research: { input: 7300, output: 420 },
        write: { input: 2520, output: 220 },
        gates: null,
        rerank: { calls: 2, tokens: 1620 },
        decision: null,
      },
      model: "deepseek-flash",
    },
    // THE REWRITE TAIL (post-settle, LATE_KINDS): §2 re-streams against
    // the run's own write materials -- writing snapshot, reset-marked
    // replacement deltas, the terminal done snapshot
    {
      e: "outline",
      title: "国产 GPU 显存生态现状调研",
      subtitle: "颗粒供给与整机适配的双线评估",
      sections: [
        { id: "summary", title: "执行摘要", status: "done" },
        { id: "s1", title: "显存颗粒的国产供给格局", status: "done" },
        { id: "s2", title: "整机适配与驱动生态", status: "writing" },
      ],
    },
    {
      e: "section",
      id: "s2",
      reset: true,
      t: "整机适配方面,三家头部整机厂商的中端机型已完成国产颗粒的换装验证[3];驱动生态的长尾仍在收敛,二线发行版的适配矩阵预计 2026 年上半年补齐[3]。",
    },
    {
      e: "outline",
      title: "国产 GPU 显存生态现状调研",
      subtitle: "颗粒供给与整机适配的双线评估",
      sections: [
        { id: "summary", title: "执行摘要", status: "done" },
        { id: "s1", title: "显存颗粒的国产供给格局", status: "done" },
        { id: "s2", title: "整机适配与驱动生态", status: "done" },
      ],
    },
  ],
};

/** The BROWSER OPS scenario: the session's newer surfaces in one run --
    the ANNOTATED mirror frame (a real capture: every scanned element's
    dashed type-colored outline + its ref badge, baked into the jpeg by
    the server's capture-time overlay), the tab strip rows (new/switch),
    the targeted scroll (text= lands the action mark on the element) and
    the batched multi.  The frame carries REAL bytes (a downscaled Bing
    SERP) -- the only way the debug stage can show the annotation, which
    is server-painted and cannot be faked by the fold. */
const BROWSER_OPS_STAGE: DebugScenario = {
  id: "browser-ops",
  label: "browser ops (annotated frame × tab strip × scroll-to-text × multi)",
  q: "在浏览器里查安吉云上草原,开个新标签对比,再滚到百科条目",
  mode: "balanced",
  events: [
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "开浏览器搜索,顺便演示新的标签页、定向滚动和批量操作。" },
    calls([
      {
        id: 1,
        tool: "browse",
        q: "https://www.bing.com/search?q=安吉云上草原",
        url: "https://www.bing.com/search?q=安吉云上草原",
        status: "pending",
        args: { action: "open", url: "https://www.bing.com/search?q=安吉云上草原" },
      },
    ]),
    {
      e: "browser",
      url: "https://cn.bing.com/search?q=安吉云上草原",
      title: "安吉云上草原 - Search",
      // the REAL annotated frame: dashed outlines + ref badges painted by
      // the capture-time overlay (links green / buttons red / inputs gold /
      // the rest gray) -- the model's own screenshots stay bare
      img: BING_ANN_JPEG,
      w: 1920,
      h: 1080,
    },
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      ms: 6480,
      url: "https://cn.bing.com/search?q=安吉云上草原",
      n: 110,
      feed: "opened https://cn.bing.com/search?q=安吉云上草原 -- 安吉云上草原 - Search\n\ne111\tbutton\tSkip to content\ne114\tinput\t安吉云上草原\ne116\tbutton\t搜索\n(110 refs -- the mirror shows each one's dashed outline + ref badge)",
    },
    { ...base, id: 2, round: 2 },
    { e: "say", id: 2, t: "开一个新标签对比门票价,再回到第一页滚动到百科条目。" },
    calls(
      [
        {
          id: 1,
          tool: "browse",
          q: "",
          status: "pending",
          args: { action: "tab", op: "new", url: "https://www.bing.com/search?q=安吉云上草原+门票价格" },
        },
        {
          id: 2,
          tool: "browse",
          q: "",
          status: "pending",
          args: { action: "scroll", text: "百度百科" },
        },
      ],
      2,
    ),
    {
      e: "browser",
      url: "https://cn.bing.com/search?q=安吉云上草原",
      title: "安吉云上草原 - Search",
      img: TINY_JPEG,
      w: 1920,
      h: 1080,
      // the scroll-to-text mark: the box rides the matched element, the
      // label reads 滚动 "百度百科"
      px: 340,
      py: 706,
      pk: "scroll",
      name: "百度百科",
      box: [160, 690, 640, 34],
    },
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      ms: 5240,
      url: "https://www.bing.com/search?q=安吉云上草原+门票价格",
      n: 86,
      feed: "new tab opened and active: https://www.bing.com/search?q=安吉云上草原+门票价格 -- 安吉云上草原门票价格 - Search\n\ne1\tinput\t安吉云上草原 门票价格\n(86 refs; tab [0] sleeps beside it)",
    },
    {
      e: "call",
      id: 2,
      call: 2,
      status: "ok",
      ms: 980,
      url: "https://cn.bing.com/search?q=安吉云上草原",
      feed: "scrolled to '百度百科'. now: 安吉云上草原 - Search (https://cn.bing.com/search?q=安吉云上草原)",
      page: { url: "https://cn.bing.com/search?q=安吉云上草原", title: "安吉云上草原 - Search" },
    },
    { ...base, id: 3, round: 3 },
    { e: "say", id: 3, t: "一组机械动作打包成一次调用:滚动、点进百科、回列表。" },
    calls(
      [
        {
          id: 1,
          tool: "browse",
          q: "",
          status: "pending",
          args: {
            action: "multi",
            steps: [
              { action: "scroll", text: "百度百科" },
              { action: "click", ref: "e25" },
            ],
          },
        },
      ],
      3,
    ),
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      ms: 4120,
      url: "https://cn.bing.com/search?q=安吉云上草原",
      n: 110,
      feed: "1. scroll: scrolled to '百度百科'. now: 安吉云上草原 - Search (https://cn.bing.com/search?q=安吉云上草原)\n2. click: clicked. now: 安吉云上草原_百度百科 (https://baike.baidu.com/item/安吉云上草原)\n\n-- the action navigated: every old ref is dead, the fresh outline is below --",
      page: { url: "https://baike.baidu.com/item/安吉云上草原", title: "安吉云上草原_百度百科" },
    },
    {
      e: "sources",
      items: [
        {
          n: 1,
          round: 3,
          id: 1,
          idx: 0,
          title: "安吉云上草原 - Search",
          url: "https://cn.bing.com/search?q=安吉云上草原",
          netloc: "cn.bing.com",
          favicon: "",
          crawled: true,
        },
        {
          n: 2,
          round: 3,
          id: 2,
          idx: 1,
          title: "安吉云上草原门票价格 - Search",
          url: "https://www.bing.com/search?q=安吉云上草原+门票价格",
          netloc: "www.bing.com",
          favicon: "",
          crawled: false,
        },
      ],
    },
    {
      e: "settle",
      status: "done",
      finish: "stop",
      usage: {
        input: 24800,
        output: 1640,
        thoughts: 980,
        cached: 11200,
        cache_write: 0,
        research: { input: 19800, output: 1180 },
        write: { input: 5000, output: 460 },
        gates: { input: 900, output: 70, calls: 4 },
        rerank: { calls: 2, tokens: 1400 },
        decision: { calls: 4, tokens: 980 },
      },
      model: "deepseek-flash",
    },
  ],
};

export const DEBUG_SCENARIOS: DebugScenario[] = [
  BROWSER_OPS_STAGE,
  BROWSER_STAGE,
  FULL_STAGE,
  REWRITE_STAGE,
  PAID_STAGE,
  DECK_STAGE,
  SHAPE_FLIP_STAGE,
  MODEL_FLIP_STAGE,
  PANORAMA_STAGE,
  STEER_STAGE,
  SUB_STAGE,
  DONE_STAGE,
  STOPPED_STAGE,
  AWAITING_STAGE,
  FAILED_STAGE,
];
