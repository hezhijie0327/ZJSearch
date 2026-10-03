// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronDown, CircleHelp, CornerDownRight, Scale } from "lucide-react";
import { useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import type { AiDecision } from "@/features/results/aiSearch/timeline.ts";
import { useT } from "@/lib/i18n.ts";

const PURPOSE_LABELS: Record<string, string> = {
  sources_gate: "ai_dec_sources_gate",
  read_gate: "ai_dec_read_gate",
  plan_review: "ai_dec_plan_review",
  judge: "ai_dec_judge",
  audit: "ai_dec_audit",
};

function auditLabelOf(verdict: string): string {
  return verdict === "verified"
    ? "ai_audit_verified"
    : verdict === "contradicted"
      ? "ai_audit_contradicted"
      : verdict === "unsupported"
        ? "ai_audit_unsupported"
        : "ai_audit_unverified";
}

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
function AnswerValue({ answer }: { answer: unknown }) {
  const t = useT();
  if (!answer || typeof answer !== "object") {
    return (
      <pre className="mt-1 overflow-x-auto text-[11px] text-ink-2" dir="ltr">
        {JSON.stringify(answer)}
      </pre>
    );
  }
  const record = answer as Record<string, unknown>;
  if (record.type === "noul") {
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
        {record.confidence !== undefined ? (
          <p className="text-[11px] text-ink-3">
            {t("ai_dec_score")}: {Number(record.score).toFixed(2)} · {t("ai_dec_confidence")}:{" "}
            {pctOf(Number(record.confidence))}
          </p>
        ) : null}
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

/** 决策条目按用途展开成 Q&A 行(问 = 判据,答 = 原语渲染):
    sources_gate 逐候选四问 / plan_review 逐子课题 / judge 逐问题 /
    read_gate 单问 / audit 判定计数。 */
function DecisionBody({ decision }: { decision: AiDecision }) {
  const t = useT();
  const record = (decision.record ?? {}) as Record<string, unknown>;
  const asObject =
    decision.answer && typeof decision.answer === "object" ? (decision.answer as Record<string, unknown>) : null;

  // ── judge(模型判定): questions × answers 逐行 Q&A ──
  if (decision.purpose === "judge" && Array.isArray(decision.record?.questions)) {
    const questions = decision.record.questions as Array<{ name: string; instructions?: string }>;
    const answers = asObject ?? {};
    return (
      <div className="mt-1.5 space-y-2">
        {questions.map((question) => (
          <div key={question.name}>
            <div className="flex items-start gap-1.5">
              <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-accent" />
              <p className="min-w-0 flex-1 break-words text-ink-2" dir="auto">
                {question.instructions ?? question.name}
              </p>
            </div>
            {answers[question.name] ? (
              <div className="flex items-start gap-1.5">
                <CornerDownRight aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <AnswerValue answer={answers[question.name]} />
                </div>
              </div>
            ) : (
              <p className="ps-5 text-ink-3">—</p>
            )}
          </div>
        ))}
      </div>
    );
  }
  // ── plan_review: 逐子课题 noul ──
  if (decision.purpose === "plan_review" && asObject) {
    const titles = (decision.target ?? "").split(" / ");
    return (
      <div className="mt-1.5 space-y-1.5">
        {Object.entries(asObject).map(([key, value]) => {
          const idx = Number(key.replace("task_", ""));
          const noulValue =
            typeof value === "object" && value ? (value as Record<string, unknown>).noul : Number(value) || 0;
          return (
            <div key={key}>
              <div className="flex items-start gap-1.5">
                <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-accent" />
                <p className="min-w-0 flex-1 break-words text-ink-2" dir="auto">
                  {titles[idx] ?? key}
                </p>
              </div>
              <AnswerValue answer={{ type: "noul", noul: noulValue }} />
            </div>
          );
        })}
      </div>
    );
  }
  // ── sources_gate: 逐候选四问 ──
  if (decision.purpose === "sources_gate" && Array.isArray(decision.answer)) {
    return (
      <div className="mt-1.5 space-y-2">
        {(decision.answer as Record<string, unknown>[]).map((candidate, i) => (
          <div className="border-t border-line/60 pt-1.5 first:border-0 first:pt-0" key={i}>
            <p className="truncate text-ink-2" dir="auto">
              {String(candidate.title ?? "")}
            </p>
            <div className="mt-0.5 grid grid-cols-2 gap-x-3">
              <AnswerValue answer={{ type: "noul", noul: Number(candidate.is_relevant) || 0 }} />
              <AnswerValue answer={{ type: "noul", noul: Number(candidate.contains_answer_evidence) || 0 }} />
              <AnswerValue answer={{ type: "noul", noul: Number(candidate.contradicts_query_premise) || 0 }} />
              <AnswerValue answer={{ type: "noul", noul: Number(candidate.contains_prompt_injection) || 0 }} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  // ── read_gate / 单 noul ──
  if (asObject && "noul" in asObject) {
    return <AnswerValue answer={asObject} />;
  }
  // ── audit: 判定计数 ──
  if (decision.purpose === "audit" && record.verdicts && typeof record.verdicts === "object") {
    const counts = record.verdicts as Record<string, number>;
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2 text-ink-2">
        <span className="tabular-nums">{t("ai_dec_audit_cited", { n: String(record.citations ?? 0) })}</span>
        {Object.entries(counts).map(([key, n]) => (
          <span className="tabular-nums" key={key}>
            {t(auditLabelOf(key) as "ai_audit_verified")} {n}
          </span>
        ))}
      </div>
    );
  }
  // ── fallback: raw JSON ──
  if (decision.answer !== undefined) {
    return (
      <pre
        className="mt-1 max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-[11px] text-ink-2"
        dir="ltr"
      >
        {JSON.stringify(decision.answer, null, 2)}
      </pre>
    );
  }
  return null;
}

/**
 * The run's DECISION RESULTS card (决策结果): EVERY decision-model call --
 * loop gates (feed 4-noul / read gate / plan review) and the model's own
 * judge tool -- one row each.  A row shows purpose + target + ms; CLICK
 * expands the structured result (per-question nouls with probabilities /
 * verdict counts), unknown shapes fall back to the raw JSON -- 问题与结果
 * 都可溯源.
 */
export function DecisionsCard({ decisions }: { decisions: AiDecision[] }) {
  const t = useT();
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  if (decisions.length === 0) {
    return null;
  }
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2">
        <Scale aria-hidden="true" className="size-4.5 shrink-0 text-ink-3" />
        <h3 className="text-base font-semibold text-ink">{t("ai_decisions_card")}</h3>
        <span className="shrink-0 text-xs tabular-nums text-ink-3">{decisions.length}</span>
      </div>
      <ul className="mt-3 space-y-1">
        {decisions.map((decision, index) => {
          const label = PURPOSE_LABELS[decision.purpose] ?? "ai_decisions_card";
          const expanded = openIdx === index;
          return (
            <li key={index}>
              <button
                aria-expanded={expanded}
                className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-xs transition-colors hover:bg-surface-2/50"
                onClick={() => {
                  setOpenIdx(expanded ? null : index);
                }}
                type="button"
              >
                <span className="shrink-0 rounded-md bg-accent-soft px-1.5 text-[11px] leading-4 text-accent">
                  {t(label as "ai_dec_judge")}
                </span>
                <span className="min-w-0 flex-1 truncate text-start text-ink-2" dir="auto">
                  {decision.target || decision.question || decision.purpose}
                </span>
                {decision.ms ? (
                  <span className="shrink-0 font-mono tabular-nums text-ink-3">{decision.ms}ms</span>
                ) : null}
                <ChevronDown
                  aria-hidden="true"
                  className={`size-3 shrink-0 text-ink-3 transition-transform ${expanded ? "rotate-180" : ""}`}
                />
              </button>
              <Collapse className={expanded ? "mt-1" : ""} open={expanded}>
                <div className="rounded-lg bg-surface-2/50 px-2.5 py-2 text-xs leading-relaxed">
                  {decision.question ? (
                    <div className="flex items-start gap-1.5">
                      <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-accent" />
                      <p className="min-w-0 flex-1 break-words text-ink-2" dir="auto">
                        {decision.question}
                      </p>
                    </div>
                  ) : null}
                  <DecisionBody decision={decision} />
                </div>
              </Collapse>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
