// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// The report/deck TEMPLATE PRESETS: fixed outline skeletons the run's
// outline gate must honor ("按照模板生成" -- the structure is the user's
// contract, the wording is the desk's).  Presets live HERE (picker
// material); the SELECTED template rides the run request body as plain
// JSON and the server adapts it to the question (runs/report/outline.py's
// build_outline_from_template) -- the server stays stateless and knows
// no preset registry.  The preset skeletons are written in Chinese; the
// adaptation pass re-titles every section with the question's actual
// entities in the report's language, so en runs get en structures.
//
// SHAPE SPLIT: a preset's `shape` fixes the output format it is offered
// for -- "report" sections are document sections, "deck" sections are
// PRESENTATION CHAPTERS (each renders as 1-4 model-authored slides, the
// sub-page content is the model's).  User templates carry the same
// field (set in the manager); legacy rows read as "report".

import { FileText, Presentation } from "lucide-react";
import type { ReportTemplate, ReportTemplateSection, TemplateShape } from "@/lib/aicontracts.ts";

export type { ReportTemplate, ReportTemplateSection, TemplateShape };

/** The locked report/deck ICON split -- every template surface (the
    run rail's picker, the manager's rows and editor) draws the shape
    from HERE so a template never changes icon between surfaces. */
export const TEMPLATE_SHAPE_ICONS = { report: FileText, deck: Presentation } as const;

const intel: ReportTemplate = {
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
};

const dd: ReportTemplate = {
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
};

const competitor: ReportTemplate = {
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
};

const industry: ReportTemplate = {
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
};

// -- the DECK presets: sections are CHAPTER titles in presentation
//    cadence; each chapter's 1-4 slides stay the model's ---------------

const projectReview: ReportTemplate = {
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
};

const pitch: ReportTemplate = {
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
};

const briefing: ReportTemplate = {
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
};

/** The picker order: within a shape, the presets; the manager's list
    appends the user's own. */
export const TEMPLATE_PRESETS: readonly ReportTemplate[] = [
  intel,
  dd,
  competitor,
  industry,
  projectReview,
  pitch,
  briefing,
];

/** Validate an arbitrary parsed JSON against the template shape: 2-10
    titled sections; returns the normalized template (a fresh user- id)
    or null.  The structured editor and a pasted JSON both land here. */
export function validateTemplate(value: unknown, name: string, shape: TemplateShape = "report"): ReportTemplate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const rawSections = (value as { sections?: unknown }).sections;
  if (!Array.isArray(rawSections)) {
    return null;
  }
  const sections: ReportTemplateSection[] = [];
  for (const raw of rawSections.slice(0, 10)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const title = String((raw as { title?: unknown }).title ?? "").trim();
    if (!title) {
      continue;
    }
    sections.push({
      title: title.slice(0, 120),
      brief: String((raw as { brief?: unknown }).brief ?? "")
        .trim()
        .slice(0, 300),
      key_questions: Array.isArray((raw as { key_questions?: unknown }).key_questions)
        ? (raw as { key_questions: unknown[] }).key_questions
            .map((q) => String(q).trim().slice(0, 200))
            .filter(Boolean)
            .slice(0, 3)
        : [],
      optional: Boolean((raw as { optional?: unknown }).optional),
    });
  }
  if (sections.length < 2) {
    return null;
  }
  return {
    id: `user-${Date.now().toString(36)}`,
    name: name.trim().slice(0, 40) || "模板",
    shape,
    sections,
  };
}
