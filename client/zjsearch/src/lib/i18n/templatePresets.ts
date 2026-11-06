// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// The report/deck TEMPLATE PRESET CONTENT, one table per shipped catalog
// tag (the same registry shape as the string catalogs beside it): this is
// the ONLY home of preset wording, so the picker labels and the run
// request's structural contract follow the UI locale.  The shape/ids and
// validation live in features/results/aiSearch/reportTemplates.ts; the
// SELECTED template rides the run request body as plain JSON and the
// server adapts it to the question (runs/report/outline.py's
// build_outline_from_template) -- the server stays stateless and knows
// no preset registry.  The adaptation pass re-titles every section with
// the question's actual entities in the report's language, so the preset
// briefs/questions are guidance material, never verbatim copy.

import type { ReportTemplate } from "@/lib/aicontracts.ts";

const en: readonly ReportTemplate[] = [
  {
    id: "intel",
    name: "Business Intelligence Report",
    shape: "report",
    sections: [
      {
        title: "Company Overview & Market Position",
        brief: "The subject's business, scale and market standing",
        key_questions: ["Who the company is and how revenue is structured", "The size and structure of its market"],
      },
      {
        title: "Core Products & Stage",
        brief: "Progress and key milestones across the core product lines",
        key_questions: ["What the core products or lines are", "Each line's stage and the next milestone"],
      },
      {
        title: "Regulatory & Compliance Signals",
        brief: "Approvals, policy and compliance developments",
        key_questions: ["Recent regulatory actions", "Is policy tailwind tightening or easing"],
      },
      {
        title: "Supply Chain & Operations",
        brief: "Upstream supply, capacity and manufacturing developments",
        key_questions: ["Supply-chain and capacity shifts", "Production and process partnerships"],
      },
      {
        title: "Partnerships & Licensing",
        brief: "Technology licensing, partnerships and competitive alliances",
        key_questions: ["Deals that have closed", "Deal terms and market heat"],
      },
      {
        title: "Opportunities & Recommendations",
        brief: "Actionable opportunities and recommendations for the client",
        key_questions: ["Where the client should enter", "Risks and timing"],
      },
    ],
  },
  {
    id: "dd",
    name: "Due Diligence",
    shape: "report",
    sections: [
      {
        title: "Business & Revenue Structure",
        brief: "Main business, customers and revenue mix",
        key_questions: ["What drives revenue", "Customer concentration and stickiness"],
      },
      {
        title: "Market & Competition",
        brief: "Market size, competitors and relative standing",
        key_questions: ["How large is the market", "The core competitive moats"],
      },
      {
        title: "Financial Health",
        brief: "Profitability, cash flow and leverage",
        key_questions: ["Earnings quality", "Cash-flow and debt risks"],
      },
      {
        title: "Legal & Compliance Risk",
        brief: "Litigation, regulatory penalties and compliance exposure",
        key_questions: ["Open disputes", "Compliance track record"],
      },
      {
        title: "Team & Governance",
        brief: "Core team, ownership structure and governance",
        key_questions: ["Team background and stability", "Governance red flags"],
      },
      {
        title: "Risk Matrix & Conclusion",
        brief: "Rated risk list and the diligence conclusion",
        key_questions: ["Red/yellow/green risks", "Proceed or walk-away recommendation"],
      },
    ],
  },
  {
    id: "competitor",
    name: "Competitive Comparison",
    shape: "report",
    sections: [
      {
        title: "Scope & Method",
        brief: "Player list and comparison dimensions",
        key_questions: ["Which products to compare", "What dimensions to use"],
      },
      {
        title: "Capability & Feature Matrix",
        brief: "Capability-by-capability comparison",
        key_questions: ["Where features differ", "Each side's strengths and weaknesses"],
      },
      {
        title: "Pricing & Business Model",
        brief: "Price bands and business-model comparison",
        key_questions: ["How they charge", "Model differences"],
      },
      {
        title: "Market Performance & Reputation",
        brief: "Share, growth and user sentiment",
        key_questions: ["Who is growing", "How users rate them"],
      },
      {
        title: "Differentiated Take & Recommendation",
        brief: "Conclusion: scenario-based selection advice",
        key_questions: ["Which product per scenario", "Switching costs"],
      },
    ],
  },
  {
    id: "industry",
    name: "Industry Overview",
    shape: "report",
    sections: [
      {
        title: "Definition & Boundaries",
        brief: "The industry's scope, segments and statistical basis",
        key_questions: ["What the industry includes", "How it layers"],
      },
      {
        title: "Market Size & Growth",
        brief: "Current size, growth rate and drivers",
        key_questions: ["How big is the pie", "What drives growth"],
      },
      {
        title: "Value Chain & Key Players",
        brief: "Upstream/downstream structure and main participants",
        key_questions: ["How the chain is distributed", "Who the leaders are"],
      },
      {
        title: "Technology & Regulation",
        brief: "Technology shifts and the policy environment",
        key_questions: ["How technology is moving", "Regulatory direction"],
      },
      {
        title: "Trends & Outlook",
        brief: "The 1-3 year trend judgment",
        key_questions: ["Which trends are certain", "What remains uncertain"],
      },
    ],
  },
  {
    id: "project-review",
    name: "Project Review",
    shape: "deck",
    sections: [
      {
        title: "Background & Goals",
        brief: "Why the project exists, the problem and the targets",
        key_questions: ["Why do it", "What are the goals"],
      },
      {
        title: "Progress & Milestones",
        brief: "Completed stages and key nodes",
        key_questions: ["Where things stand", "Which milestones landed"],
      },
      {
        title: "Data & Results",
        brief: "Quantified progress and outcomes",
        key_questions: ["What the data says", "How good the results are"],
      },
      {
        title: "Problems & Risks",
        brief: "Exposed issues and forward risks",
        key_questions: ["What is blocked", "What could go wrong"],
      },
      {
        title: "Next Steps",
        brief: "The plan ahead and the support needed",
        key_questions: ["What comes next", "What support is needed"],
      },
    ],
  },
  {
    id: "pitch",
    name: "Solution Pitch",
    shape: "deck",
    sections: [
      {
        title: "Background & Pain Points",
        brief: "The audience's problems and opportunities",
        key_questions: ["What hurts", "Where the opening is"],
      },
      {
        title: "Solution Overview",
        brief: "The approach and the solution framework",
        key_questions: ["How it solves it", "What the solution looks like"],
      },
      {
        title: "Core Capabilities",
        brief: "The solution's key capabilities and differentiation",
        key_questions: ["Where it is strong", "Why it wins"],
      },
      {
        title: "Cases & Validation",
        brief: "Deployed cases and evidence of effect",
        key_questions: ["Who uses it", "How well it works"],
      },
      {
        title: "Roadmap & Vision",
        brief: "The route ahead and the end-state",
        key_questions: ["The next moves", "The endgame"],
      },
    ],
  },
  {
    id: "briefing",
    name: "Industry Briefing",
    shape: "deck",
    sections: [
      {
        title: "Industry Panorama",
        brief: "The industry's scope, scale and base",
        key_questions: ["What the industry is", "How big the pie is"],
      },
      {
        title: "Landscape & Players",
        brief: "Main participants and competitive standing",
        key_questions: ["Who the players are", "How the landscape sits"],
      },
      {
        title: "Trends & Drivers",
        brief: "The shifts under way and the forces behind them",
        key_questions: ["What is changing", "Why it changes"],
      },
      {
        title: "Opportunities & Challenges",
        brief: "The openings worth entering and the walls ahead",
        key_questions: ["Where the opportunity is", "What is hard"],
      },
      {
        title: "Key Takeaways",
        brief: "The session's takeaways",
        key_questions: ["The lines to remember"],
      },
    ],
  },
];

const zhCn: readonly ReportTemplate[] = [
  {
    id: "intel",
    name: "商业情报报告",
    shape: "report",
    sections: [
      {
        title: "公司概况与市场定位",
        brief: "研究对象的业务、规模与所处市场位置",
        key_questions: ["公司是谁、做什么、收入结构如何", "所处市场的规模与格局"],
      },
      {
        title: "核心产品与发展阶段",
        brief: "核心产品/业务线的进展与关键节点",
        key_questions: ["有哪些核心产品或业务线", "各自处于什么阶段、下一步里程碑"],
      },
      {
        title: "监管与合规信号",
        brief: "审批、政策与合规层面的动向",
        key_questions: ["近期有哪些监管动作", "政策趋势利好还是收紧"],
      },
      {
        title: "供应链与生产动态",
        brief: "上游供应、产能与生产制造层面的动向",
        key_questions: ["供应链与产能有何变化", "生产/工艺合作动向"],
      },
      {
        title: "合作与授权格局",
        brief: "技术授权、合作与竞争联盟",
        key_questions: ["有哪些已达成的交易", "交易条款与市场热度"],
      },
      {
        title: "机会与建议",
        brief: "面向委托方的可执行机会与建议",
        key_questions: ["委托方切入点在哪", "风险与时机判断"],
      },
    ],
  },
  {
    id: "dd",
    name: "尽职调查",
    shape: "report",
    sections: [
      {
        title: "业务与收入结构",
        brief: "主营业务、客户与收入构成",
        key_questions: ["收入靠什么", "客户集中度与粘性"],
      },
      {
        title: "市场与竞争",
        brief: "市场空间、竞争对手与自身站位",
        key_questions: ["市场还有多大", "核心竞争壁垒是什么"],
      },
      { title: "财务健康度", brief: "盈利能力、现金流与负债水平", key_questions: ["盈利质量如何", "现金流与负债风险"] },
      { title: "法务与合规风险", brief: "诉讼、监管处罚与合规隐患", key_questions: ["有哪些未决纠纷", "合规记录如何"] },
      {
        title: "团队与治理",
        brief: "核心团队、股权结构与治理安排",
        key_questions: ["团队背景与稳定性", "治理结构是否有隐患"],
      },
      {
        title: "风险矩阵与结论",
        brief: "分级风险清单与尽调结论",
        key_questions: ["红黄绿风险各有哪些", "推进/终止建议"],
      },
    ],
  },
  {
    id: "competitor",
    name: "竞品对比",
    shape: "report",
    sections: [
      { title: "对比范围与方法", brief: "入局者清单与对比维度", key_questions: ["对比哪些产品", "用什么维度"] },
      { title: "能力与功能矩阵", brief: "各产品的能力对照矩阵", key_questions: ["功能差异在哪", "各自强弱势"] },
      { title: "定价与商业模式", brief: "价格带与商业模式对照", key_questions: ["怎么收费", "模式差异"] },
      { title: "市场表现与口碑", brief: "市场份额、增长与用户评价", key_questions: ["谁在增长", "用户怎么评价"] },
      {
        title: "差异化总结与选型建议",
        brief: "结论：按场景给出选型建议",
        key_questions: ["什么场景选谁", "转换成本如何"],
      },
    ],
  },
  {
    id: "industry",
    name: "行业综述",
    shape: "report",
    sections: [
      { title: "行业定义与边界", brief: "行业的范围、细分与统计口径", key_questions: ["行业包含什么", "如何分层"] },
      { title: "市场规模与增长", brief: "当前规模、增速与驱动因素", key_questions: ["盘子多大", "增长靠什么"] },
      { title: "产业链与关键玩家", brief: "上下游结构与主要参与者", key_questions: ["链条怎么分布", "头部玩家是谁"] },
      { title: "技术与监管动态", brief: "技术演进与政策环境", key_questions: ["技术在怎么变", "监管风向"] },
      { title: "趋势与展望", brief: "未来 1-3 年的趋势判断", key_questions: ["哪些趋势确定", "有哪些变数"] },
    ],
  },
  {
    id: "project-review",
    name: "项目汇报",
    shape: "deck",
    sections: [
      { title: "背景与目标", brief: "项目缘起、要解决的问题与既定目标", key_questions: ["为什么做", "目标是什么"] },
      { title: "关键进展与里程碑", brief: "已完成的阶段与关键节点", key_questions: ["走到哪一步", "有哪些里程碑"] },
      { title: "数据与成效", brief: "能量化的进展与成效", key_questions: ["数据怎么说", "成色如何"] },
      { title: "问题与风险", brief: "暴露的问题与前行风险", key_questions: ["卡在哪里", "有哪些风险"] },
      { title: "下一步计划", brief: "后续安排与所需支持", key_questions: ["接下来做什么", "需要什么"] },
    ],
  },
  {
    id: "pitch",
    name: "方案介绍",
    shape: "deck",
    sections: [
      { title: "背景与痛点", brief: "面向受众的问题与机会", key_questions: ["痛点是什么", "机会在哪"] },
      { title: "方案总览", brief: "整体思路与方案框架", key_questions: ["怎么解决", "方案长什么样"] },
      { title: "核心能力", brief: "方案的关键能力与差异化", key_questions: ["强在哪", "凭什么赢"] },
      { title: "案例与验证", brief: "落地案例与效果佐证", key_questions: ["谁在用", "效果如何"] },
      { title: "规划与展望", brief: "路线图与愿景", key_questions: ["下一步怎么走", "终局是什么"] },
    ],
  },
  {
    id: "briefing",
    name: "行业分享",
    shape: "deck",
    sections: [
      { title: "行业全景", brief: "行业的范围、规模与基本盘", key_questions: ["行业是什么", "盘子多大"] },
      { title: "格局与玩家", brief: "主要参与者与竞争站位", key_questions: ["玩家有谁", "格局如何"] },
      { title: "趋势与驱动", brief: "正在发生的变局与背后推力", key_questions: ["什么在变", "为什么变"] },
      { title: "机会与挑战", brief: "值得入场的机会与绕不开的坎", key_questions: ["机会在哪", "难在哪里"] },
      { title: "要点回顾", brief: "整场分享的 takeaway", key_questions: ["记住哪几句话"] },
    ],
  },
];

/** Catalog tag -> preset library.  Adding a language = one more row here
    (mirroring the CATALOGS registry in lib/i18n.ts). */
export const TEMPLATE_PRESETS_BY_TAG: Record<"en" | "zh-CN", readonly ReportTemplate[]> = {
  en,
  "zh-CN": zhCn,
};
