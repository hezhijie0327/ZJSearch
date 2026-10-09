// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronDown, CircleHelp, CornerDownRight, Scale } from "lucide-react";
import { useState } from "react";
import { CAP_CHIP_CLASS, CapChip } from "@/components/CapChip.tsx";
import { Collapse } from "@/components/Collapse.tsx";
import { RailHeader } from "@/features/results/aiSearch/rail/RailSection.tsx";
import type { AiDecision } from "@/features/results/aiSearch/timeline.ts";
import { formatMs, formatScore } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { useCapExpand } from "@/lib/useCapExpand.ts";

const PURPOSE_LABELS: Record<string, string> = {
  read_gate: "ai_dec_read_gate",
  plan_review: "ai_dec_plan_review",
  judge: "ai_dec_judge",
  evidence: "ai_dec_evidence_check",
  coverage: "ai_dec_coverage",
  depth_probe: "ai_dec_depth_probe",
  entity_coverage: "ai_dec_entity_coverage",
  outline: "ai_dec_outline",
  clarify_gate: "ai_dec_clarify_gate",
};

/** 概率条:label + 轨道填充 + 百分比(选中/过半用强调色)。 */
function ProbBar({ label, pct, highlight = false }: { label: string; pct: number; highlight?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`min-w-0 flex-1 truncate ${highlight ? "font-medium text-ink" : "text-ink-2"}`} dir="auto">
        {label}
      </span>
      <span aria-hidden="true" className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-ink-3/20">
        <span
          className={`block h-full rounded-full ${highlight ? "bg-accent" : "bg-ink-3/50"}`}
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      </span>
      <span className={`w-9 shrink-0 text-end font-mono tabular-nums ${highlight ? "text-accent" : "text-ink-3"}`}>
        {Math.round(pct * 100)}%
      </span>
    </div>
  );
}

/** 三原语答案渲染器(决策模型只有 choice / score / noul 三种返回):
    choice = 选项分布条 + 选中高亮;score = 档位分布 + 加权值;
    noul = 是/否概率条;未知形状回退原始 JSON。 */
export function AnswerValue({ answer }: { answer: unknown }) {
  const t = useT();
  if (!answer || typeof answer !== "object") {
    return (
      <pre className="mt-1 overflow-x-auto text-[11px] text-ink-2" dir="ltr">
        {JSON.stringify(answer)}
      </pre>
    );
  }
  const record = answer as Record<string, unknown>;
  if (record.type === "noul" || "noul" in record) {
    const yes = Number(record.noul) || 0;
    return (
      <div className="mt-0.5 space-y-0.5">
        <ProbBar highlight={yes >= 0.5} label={t("ai_dec_yes")} pct={yes} />
        <ProbBar label={t("ai_dec_no")} pct={1 - yes} />
      </div>
    );
  }
  if (record.type === "choice") {
    const probabilities = (record.probabilities ?? {}) as Record<string, unknown>;
    const chosen = String(record.choice ?? "");
    return (
      <div className="mt-0.5 space-y-0.5">
        {Object.entries(probabilities).map(([option, p]) => (
          <ProbBar highlight={option === chosen} key={option} label={option} pct={Number(p) || 0} />
        ))}
        {record.confidence !== undefined ? (
          <p className="text-[11px] text-ink-3">
            {t("ai_dec_confidence")}: {pctOf(Number(record.confidence))}
          </p>
        ) : null}
      </div>
    );
  }
  if (record.type === "score") {
    const probabilities = (record.probabilities ?? {}) as Record<string, unknown>;
    const legend = (record.legend ?? {}) as Record<string, string>;
    return (
      <div className="mt-0.5 space-y-0.5">
        {Object.entries(probabilities).map(([level, p]) => (
          <ProbBar
            highlight={Number(level) === Math.round(Number(record.score) || 0)}
            key={level}
            label={legend[level] ?? level}
            pct={Number(p) || 0}
          />
        ))}
        <p className="text-[11px] text-ink-3">
          {t("ai_dec_score")}: {formatScore(Number(record.score ?? 0))}
          {record.confidence !== undefined ? ` · ${t("ai_dec_confidence")}: ${pctOf(Number(record.confidence))}` : ""}
        </p>
      </div>
    );
  }
  return (
    <pre className="mt-1 overflow-x-auto text-[11px] text-ink-2" dir="ltr">
      {JSON.stringify(answer)}
    </pre>
  );
}

function pctOf(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/** 决策条目的展开:「命名裁决映射」形状(judge / plan_review / coverage /
    read_gate / evidence / citation_gate …—— 任何答案为 {名字: 原语裁决}
    的决策)统一走通用逐行渲染器,标签按 record_questions 题文 → target
    标题序列 → 键名 解析,卡内题文行只在行标签退化为裸键名时兜底(协议
    原文对用户是机器噪音);单答案原语直接渲染;真正未知的形状才退到原始
    JSON。新增 decision 用途时,只要答案遵守 {名字: choice|score|noul}
    协议就自动获得结构化渲染,零分支。*/
/** 单答案原语:noul / choice / score 之一(顶层直接渲染的形状)。 */
function isPrimitiveAnswer(value: Record<string, unknown>): boolean {
  return "noul" in value || value.type === "noul" || value.type === "choice" || value.type === "score";
}

function DecisionBody({ decision }: { decision: AiDecision }) {
  const asObject =
    decision.answer && typeof decision.answer === "object" ? (decision.answer as Record<string, unknown>) : null;
  // 题文行(卡内上下文):仅当展开内容自身带不给出处时兜底 ——
  // 映射形状的行标签已解析(题文/标题)时协议原文是机器噪音,不渲染;
  // 原语与原始 JSON 没有行标签,题文行始终渲染。
  const questionLine =
    decision.question && asObject && !isPrimitiveAnswer(asObject) ? null : decision.question ? (
      <div className="flex items-start gap-1.5">
        <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-accent" />
        <p className="min-w-0 flex-1 break-words text-ink-2" dir="auto">
          {decision.question}
        </p>
      </div>
    ) : null;

  // ── 命名裁决映射(万能形态): judge / plan_review / coverage /
  //    read_gate 的答案都是同一种形状 —— {名字: choice|score|noul 裁决}。
  //    一个渲染器覆盖全部现有与未来的这类决策:逐条渲染「标签 + 概率条」,
  //    标签按 最佳可用来源 解析 —— record_questions 的题文映射、target 的
  //    " / " 标题序列(task_N 约定)、退回键名本身;裸键名行在题文行在场时
  //    隐藏(题文已是上下文,键名只是噪音)。裸数值归一为 noul。 ──
  if (asObject && !isPrimitiveAnswer(asObject)) {
    const questions = Array.isArray(decision.record_questions) ? decision.record_questions : [];
    const titles = typeof decision.target === "string" && decision.target ? decision.target.split(" / ") : [];
    const rows = Object.entries(asObject).map(([key, value]) => {
      const byQuestion = questions.find((q) => String(q.name ?? "") === key);
      const idx = Number(key.replace("task_", ""));
      const label = byQuestion?.instructions ? String(byQuestion.instructions) : (titles[idx] ?? key);
      const value2 = typeof value === "object" && value ? value : { type: "noul", noul: Number(value) || 0 };
      return { key, label, value: value2 };
    });
    const bareKeys = rows.some((row) => row.label === row.key);
    return (
      <div className="rounded-lg bg-surface-2/50 px-2.5 py-2 text-[13px] leading-relaxed">
        {bareKeys ? questionLine : null}
        <div className="mt-1.5 space-y-2">
          {rows.map((row) => (
            <div key={row.key}>
              {row.label === row.key && bareKeys ? null : (
                <p className="break-words font-medium text-ink" dir="auto">
                  {row.label}
                </p>
              )}
              <div className="mt-0.5 flex items-start gap-1.5">
                <CornerDownRight aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <AnswerValue answer={row.value} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  // ── 单答案原语(noul / choice / score)直接渲染 ──
  if (asObject && isPrimitiveAnswer(asObject)) {
    return (
      <div className="rounded-lg bg-surface-2/50 px-2.5 py-2 text-[13px] leading-relaxed">
        {questionLine}
        <AnswerValue answer={asObject} />
      </div>
    );
  }
  // ── fallback: raw JSON ──
  if (decision.answer !== undefined) {
    return (
      <div className="rounded-lg bg-surface-2/50 px-2.5 py-2 text-[13px] leading-relaxed">
        {questionLine}
        <pre
          className="mt-1 max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-[11px] text-ink-2"
          dir="ltr"
        >
          {JSON.stringify(decision.answer, null, 2)}
        </pre>
      </div>
    );
  }
  return null;
}

/**
 * The run's DECISION RESULTS card (决策结果): EVERY decision-model call --
 * loop gates (depth probe / plan review / coverage referee / read gate /
 * pre-write evidence) and the model's own judge tool -- one row each.
 * A row shows purpose + target + ms; CLICK expands the structured result
 * (per-question nouls with probabilities / verdict counts), unknown shapes
 * fall back to the raw JSON -- 问题与结果都可溯源.  The list reads
 * NEWEST-FIRST and caps at four rows (cap-and-expand), so a long run's
 * latest verdicts lead and the history stays one click away.
 */
/** ONE decision row (the shared row language: purpose chip + target +
    the 11px mono timing on the same token the tool rows use): the open
    state is the decision's index in the ORIGINAL array -- new verdicts
    append at the end, so an open row keeps its identity while the list
    streams (the reversed VIEW only changes order). */
function DecisionRow({ decision, open, onToggle }: { decision: AiDecision; open: boolean; onToggle: () => void }) {
  const t = useT();
  const label = PURPOSE_LABELS[decision.purpose] ?? "ai_decisions_card";
  return (
    <li>
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-xs transition-colors hover:bg-surface-2/50"
        onClick={onToggle}
        type="button"
      >
        <span className="shrink-0 rounded-md bg-accent-soft px-1.5 text-[11px] leading-4 text-accent">
          {t(label as "ai_dec_judge")}
        </span>
        <span className="min-w-0 flex-1 truncate text-start text-[13px] text-ink-2" dir="auto">
          {decision.target || decision.question || decision.purpose}
        </span>
        {decision.ms ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-3">{formatMs(decision.ms)}</span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className={`size-3 shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <Collapse className={open ? "mt-1" : ""} open={open}>
        <DecisionBody decision={decision} />
      </Collapse>
    </li>
  );
}

export function DecisionsCard({ decisions }: { decisions: AiDecision[] }) {
  const t = useT();
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const { expanded, toggle, hidden } = useCapExpand(decisions.length, 4);
  if (decisions.length === 0) {
    return null;
  }
  // the newest four lead; the OLDER tail sits inside a Collapse so the
  // +N reveal (and the 收起) plays as a height animation
  const view = [...decisions.slice(-4)].reverse();
  const extraView = [...decisions.slice(0, Math.max(0, decisions.length - 4))].reverse();
  return (
    <div className="mb-5">
      <RailHeader count={decisions.length} icon={Scale} title={t("ai_decisions_card")} />
      <ul className="mt-3 space-y-1 px-1">
        {view.map((decision) => {
          const label = PURPOSE_LABELS[decision.purpose] ?? "ai_decisions_card";
          // openIdx is the decision's index in the ORIGINAL array: new
          // verdicts append at the end, so an open row keeps its identity
          // while the list streams (the reversed VIEW only changes order)
          const idx = decisions.indexOf(decision);
          const expandedRow = openIdx === idx;
          return (
            <li key={idx}>
              <button
                aria-expanded={expandedRow}
                className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-xs transition-colors hover:bg-surface-2/50"
                onClick={() => {
                  setOpenIdx(expandedRow ? null : idx);
                }}
                type="button"
              >
                <span className="shrink-0 rounded-md bg-accent-soft px-1.5 text-[11px] leading-4 text-accent">
                  {t(label as "ai_dec_judge")}
                </span>
                <span className="min-w-0 flex-1 truncate text-start text-[13px] text-ink-2" dir="auto">
                  {decision.target || decision.question || decision.purpose}
                </span>
                {decision.ms ? (
                  <span className="shrink-0 font-mono tabular-nums text-ink-3">{formatMs(decision.ms)}</span>
                ) : null}
                <ChevronDown
                  aria-hidden="true"
                  className={`size-3 shrink-0 text-ink-3 transition-transform ${expandedRow ? "rotate-180" : ""}`}
                />
              </button>
              <Collapse className={expandedRow ? "mt-1" : ""} open={expandedRow}>
                <DecisionBody decision={decision} />
              </Collapse>
            </li>
          );
        })}
      </ul>
      <Collapse className={expanded && extraView.length > 0 ? "mt-1" : ""} open={expanded && extraView.length > 0}>
        <ul className="space-y-1">
          {extraView.map((decision) => {
            const idx = decisions.indexOf(decision);
            return (
              <DecisionRow
                decision={decision}
                key={idx}
                onToggle={() => setOpenIdx(openIdx === idx ? null : idx)}
                open={openIdx === idx}
              />
            );
          })}
        </ul>
      </Collapse>
      <CapChip className={CAP_CHIP_CLASS} expanded={expanded} hidden={hidden} onToggle={toggle} />
    </div>
  );
}
