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
    decision card, sources, learnings, tasks -- the whole surface. */
const FULL_STAGE: DebugScenario = {
  id: "full",
  label: "全部工具行 × 状态(报告进行中)",
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
    { ...base },
    { e: "phase", name: "plan" },
    { e: "say", id: 1, t: "拆解为竞争格局、产能对比与深圳价格矩阵三条线,先做行业面,再落到片区数据。" },
    { e: "think", id: 1, t: "先并行三组检索:行业规模、头部供应商、深圳分片区价格;读页留给承载关键数字的来源。" },
    calls([
      {
        id: 1,
        tool: "web_search",
        q: "多肽原料药 全球市场规模 2025",
        status: "pending",
        args: { query: "多肽原料药 全球市场规模 2025" },
      },
      {
        id: 2,
        tool: "web_search",
        q: "深圳 新房成交均价 分片区 2025",
        status: "pending",
        args: { query: "深圳 新房成交均价 分片区 2025", category: "general" },
      },
      {
        id: 3,
        tool: "web_search",
        q: "peptide API CDMO capacity share",
        status: "error",
        ms: 3210,
        args: { query: "peptide API CDMO capacity share" },
        feed: "error: the search failed",
      },
      {
        id: 4,
        tool: "task_write",
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
        feed: "plan written: 1/4 subtasks covered. Search each subtask's keywords; when a subtask's evidence is in, mark it done yourself via task_write (the card only tracks which sources landed where).",
      },
    ]),
    { e: "sources", items: [SOURCES[0], SOURCES[1], SOURCES[2]] },
    { e: "call", id: 1, call: 1, status: "ok", n: 5, ms: 2395, feed: "plan: 5 deep + 5 shallow lines [1][2]…" },
    { e: "call", id: 1, call: 2, status: "ok", n: 8, ms: 1870, feed: "plan: 5 deep + 5 shallow lines [3]…" },
    { e: "call", id: 1, call: 3, status: "error", ms: 3210, feed: "error: the search failed" },
    { e: "call", id: 1, call: 4, status: "ok", ms: 412, feed: "plan written: 1/4 subtasks covered." },
    {
      e: "tasks",
      items: [
        { title: "全球竞争格局与头部玩家", status: "active", sources: [1, 2] },
        { title: "产能与投资对比", status: "active", sources: [] },
        { title: "深圳分片区价格矩阵", status: "done", sources: [3] },
        { title: "风险与机会评估", status: "pending" },
      ],
    },
    {
      e: "learnings",
      items: [
        {
          id: 1,
          text: "全球多肽原料药市场 2025 年规模 41.2 亿美元,CAGR 8.6%[1]。",
          refs: [1],
          status: "active",
          round: 1,
        },
        { id: 2, text: "中国 CDMO 产能占全球多肽原料药供给的 28%[4]。", refs: [4], status: "active", round: 1 },
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
          tool: "web_reader",
          q: "",
          url: "https://example.com/peptide-report",
          status: "ok",
          chars: 12480,
          ms: 8420,
          args: { url: "https://example.com/peptide-report" },
          feed: 'Opened https://example.com/peptide-report (title: "多肽原料药行业深度报告"; source [1]):\n\n# 多肽原料药行业深度报告\n全球多肽原料药市场…',
        },
        {
          id: 2,
          tool: "web_reader",
          q: "",
          url: "https://dead.example.com/404",
          status: "error",
          ms: 15200,
          args: { url: "https://dead.example.com/404" },
          feed: "error: page reader HTTP 404: not found",
        },
        {
          id: 3,
          tool: "calculator",
          q: "41.2 * 1.086",
          result: "44.7432",
          status: "ok",
          ms: 3,
          args: { expression: "41.2 * 1.086", precision: 4 },
          feed: '{"expression": "41.2 * 1.086", "result": "44.7432"}',
        },
        {
          id: 4,
          tool: "judge",
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
          tool: "learnings",
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
          tool: "past_research",
          q: "深圳 房地产 政策",
          status: "ok",
          n: 3,
          ms: 12,
          args: { query: "深圳 房地产 政策" },
          feed: "matched 3 past sources; heads follow",
        },
        {
          id: 7,
          tool: "user_memory",
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
          name: "amap_maps_geo",
          q: "深圳湾",
          status: "ok",
          ms: 460,
          text: '{"country":"中国","province":"广东省","city":"深圳市","district":"南山区"}',
          args: { address: "深圳湾" },
          feed: "geocode result: 深圳 南山",
        },
        {
          id: 9,
          tool: "extract_table",
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
          tool: "view_image",
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
          tool: "extract_table",
          q: "",
          status: "error",
          ms: 2,
          args: { title: "残缺表" },
          feed: "error: extract_table needs a title, 2+ columns and at least one row -- a table the writer can cite.",
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
    { e: "call", id: 2, call: 11, status: "error", ms: 2, feed: "error: extract_table needs a title…" },
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
          purpose: "judge",
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
          answer: { verdicts: [{ claim: "中国 CDMO 产能占全球 28%[4]", p: 0.87 }], passed: true },
          ms: 640,
        },
      ],
    },
    { e: "close", id: 1 },
    { e: "close", id: 2 },
    { e: "open", id: 3, kind: "write", round: 0 },
    { e: "phase", name: "write" },
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
        { id: "method", title: "研究方法与数据说明", status: "pending" },
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
      t: "全球供给由欧洲老牌 CDMO 与中国新锐共同主导。Novo Nordisk 的肽类原料药长期供应商包括 Polypeptide 与 Bachem[2];中国企业以成本与响应速度切入,翰宇药业多肽原料药业务收入 4.7 亿元,同比增长 32%[5]。",
    },
    {
      e: "related",
      items: [
        "GLP-1 供应瓶颈会持续到何时?",
        "深圳前海 vs 光明:哪个片区性价比更高?",
        "中国 CDMO 的 EHS 合规风险有哪些?",
      ],
    },
  ],
};

const AWAITING_STAGE: DebugScenario = {
  id: "awaiting",
  label: "澄清门(awaiting)",
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
          tool: "web_search",
          q: "三元锂 固态电池 车型 2025 对比",
          status: "pending",
          args: { query: "三元锂 固态电池 车型 2025 对比" },
        },
        {
          id: 2,
          tool: "web_search",
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
      e: "learnings",
      items: [
        { id: 1, text: "2025 年购置税减免延续,单车免税额上限 3 万元[4]。", refs: [4], status: "active", round: 2 },
      ],
      gaps: [],
    },
    {
      e: "tasks",
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

const FAILED_STAGE: DebugScenario = {
  id: "failed",
  label: "失败态(receipt + 继续)",
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
        tool: "web_search",
        q: "CDMO FDA 483 warning letters",
        status: "ok",
        n: 6,
        ms: 2100,
        args: { query: "CDMO FDA 483 warning letters" },
      },
      {
        id: 2,
        tool: "web_reader",
        q: "",
        url: "https://fda.example.com/letters",
        status: "ok",
        chars: 8210,
        ms: 6100,
        args: { url: "https://fda.example.com/letters" },
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
  label: "单写完成(balanced)",
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
        tool: "web_search",
        q: "Kimi K3 context length",
        status: "ok",
        n: 4,
        ms: 1420,
        args: { query: "Kimi K3 context length" },
      },
      {
        id: 2,
        tool: "web_search",
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

/** The browser session's login collaboration: the reader hits a sign-in
    wall, the model opens the page in the browser, the mirror streams
    frames while the user operates the Lightbox, and the post-operation
    read hands the page back.  Frames are 1x1 stand-ins (the real wire
    carries jpeg bytes; the event log strips them). */
const TINY_JPEG =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

const BROWSER_STAGE: DebugScenario = {
  id: "browser",
  label: "浏览器登录协作(镜像帧 × 等待用户 × 截图)",
  q: "打开小红书的探索页,登录后看看首页热门内容",
  mode: "balanced",
  events: [
    { ...base },
    { e: "phase", name: "research" },
    { e: "say", id: 1, t: "先读一次目标页;被登录墙挡住就开浏览器,页面交给你来登录。" },
    {
      e: "think",
      id: 1,
      t: "web_reader 先行:返回内容若明显是登录表单,用 web_browser 打开同一页并 wait_user,把操作交给人。",
    },
    calls([
      {
        id: 1,
        tool: "web_reader",
        q: "",
        url: "https://www.xiaohongshu.com/explore",
        status: "pending",
        args: { url: "https://www.xiaohongshu.com/explore" },
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
          tool: "web_browser",
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
      w: 1280,
      h: 800,
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
          tool: "web_browser",
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
      w: 1280,
      h: 800,
      wait_left: 174,
    },
    {
      e: "browser",
      url: "https://www.xiaohongshu.com/login",
      title: "扫码登录",
      img: TINY_JPEG,
      w: 1280,
      h: 800,
      wait_left: 170,
    },
    {
      e: "browser",
      url: "https://www.xiaohongshu.com/explore",
      title: "小红书 - 你的生活指南",
      img: TINY_JPEG,
      w: 1280,
      h: 800,
      wait_left: 149,
    },
    {
      e: "browser",
      url: "https://www.xiaohongshu.com/explore",
      title: "小红书 - 你的生活指南",
      img: TINY_JPEG,
      w: 1280,
      h: 800,
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
          tool: "web_browser",
          q: "",
          status: "pending",
          args: { action: "screenshot" },
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
  label: "引导(边界注入 · 抢占 · 未送达)",
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
        tool: "web_search",
        q: "2025 新能源车企 全球销量 排名",
        status: "ok",
        n: 8,
        ms: 1834,
        args: { query: "2025 新能源车企 全球销量 排名" },
        feed: "plan: 5 deep + 5 shallow lines [1][2]…",
      },
      {
        id: 2,
        tool: "web_search",
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
        tool: "web_search",
        q: "比亚迪 2025 销量 同比",
        status: "ok",
        n: 7,
        ms: 1450,
        args: { query: "比亚迪 2025 销量 同比" },
        feed: "plan: 5 deep + 2 shallow lines [5][6]…",
      },
      {
        id: 2,
        tool: "learnings",
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
  label: "子代理(委派行 · 折叠子时间线 · 浏览器多标签)",
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
      w: 1280,
      h: 800,
      agent: "lead",
    },
    {
      e: "calls",
      id: 1,
      items: [
        {
          id: 1,
          tool: "research_subtask",
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
      label: "头部厂商产能与市占率",
      feed: "建立 2024-2025 头部电池厂商的产能与市占率矩阵",
    },
    {
      e: "open",
      id: 10000,
      kind: "sub",
      round: 1,
      title: "头部厂商产能与市占率",
      objective: "建立 2024-2025 头部电池厂商的产能与市占率矩阵(宁德时代/LG/比亚迪为最小集合)",
    },
    { e: "think", id: 10000, t: "子代理:先宽后窄,先全球格局再单厂产能。" },
    {
      e: "calls",
      id: 10000,
      items: [
        { id: 1, tool: "web_search", q: "global EV battery market share 2025", status: "ok", n: 6, ms: 1640, args: {} },
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
      w: 1280,
      h: 800,
      agent: "sub-10000",
    },
    { e: "close", id: 10000 },
    // the child's round re-open: MUST NOT duplicate the sub row
    { e: "open", id: 10000, kind: "sub", round: 2, title: "" },
    { e: "close", id: 10000 },
    // the digest rides the delegation row's second settlement
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      ms: 0,
      label: "头部厂商产能与市占率",
      chars: 320,
      feed: "【子任务】头部厂商产能与市占率\n已确认:\n- 宁德时代市占率 ~37%[1]\n- 比亚迪自供 + 外供双线[2]\n未决:\n- LG 新增产能口径",
      result:
        "【子任务】头部厂商产能与市占率\n已确认:\n- 宁德时代市占率 ~37%[1]\n- 比亚迪自供 + 外供双线[2]\n未决:\n- LG 新增产能口径",
    },
    { e: "learnings", round: 2, items: [], gaps: [] },
    { e: "close", id: 1 },
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

export const DEBUG_SCENARIOS: DebugScenario[] = [
  BROWSER_STAGE,
  FULL_STAGE,
  STEER_STAGE,
  SUB_STAGE,
  DONE_STAGE,
  AWAITING_STAGE,
  FAILED_STAGE,
];
