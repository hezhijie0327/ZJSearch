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
      // the action mark: the touched element's viewport box + the intent
      // label -- the mirror draws the highlight, not just a cursor dot
      box: [560, 130, 160, 52],
      label: "clicked e3",
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

export const DEBUG_SCENARIOS: DebugScenario[] = [
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
