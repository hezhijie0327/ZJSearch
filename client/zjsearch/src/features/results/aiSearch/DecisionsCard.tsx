// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronDown, Scale } from "lucide-react";
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

/** Noul 概率行:是 X% / 否 Y%(过半绿,不过半灰)。 */
function NoulLine({ label, value }: { label: string; value: number }) {
  const yes = Math.round(value * 100);
  return (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 flex-1 break-words text-ink-2" dir="auto">
        {label}
      </span>
      <span className={`shrink-0 font-mono tabular-nums ${yes >= 50 ? "text-ok" : "text-ink-3"}`}>
        {yes >= 50 ? "是" : "否"} {yes}%
      </span>
    </div>
  );
}

/** 按用途结构化解析已知形状(noul / 逐候选四值 / 逐子课题 / 审计计数);
    未知形状回退原始 JSON。 */
function DecisionBody({ decision }: { decision: AiDecision }) {
  const t = useT();
  const record = (decision.record ?? {}) as Record<string, unknown>;
  const asObject =
    decision.answer && typeof decision.answer === "object" ? (decision.answer as Record<string, unknown>) : null;

  // ── sources_gate: raw = 逐候选四值 ──
  if (decision.purpose === "sources_gate" && Array.isArray(decision.answer)) {
    return (
      <div className="mt-1.5 space-y-1.5">
        {(decision.answer as Record<string, unknown>[]).map((candidate, i) => (
          <div className="border-t border-line/60 pt-1 first:border-0 first:pt-0" key={i}>
            <p className="truncate text-ink-2" dir="auto">
              {String(candidate.title ?? "")}
            </p>
            <div className="mt-0.5 grid grid-cols-2 gap-x-3">
              <NoulLine label={t("ai_dec_rel")} value={Number(candidate.is_relevant) || 0} />
              <NoulLine label={t("ai_dec_evidence")} value={Number(candidate.contains_answer_evidence) || 0} />
              <NoulLine label={t("ai_dec_contra")} value={Number(candidate.contradicts_query_premise) || 0} />
              <NoulLine label={t("ai_dec_inject")} value={Number(candidate.contains_prompt_injection) || 0} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  // ── plan_review: answers = task_i noul,target = 标题列表 ──
  if (decision.purpose === "plan_review" && asObject) {
    const titles = (decision.target ?? "").split(" / ");
    return (
      <div className="mt-1.5 space-y-1">
        {Object.entries(asObject).map(([key, value]) => {
          const idx = Number(key.replace("task_", ""));
          const noul =
            typeof value === "object" && value
              ? Number((value as Record<string, unknown>).noul) || 0
              : Number(value) || 0;
          return <NoulLine key={key} label={titles[idx] ?? key} value={noul} />;
        })}
      </div>
    );
  }
  // ── read_gate / 单 noul 答案 ──
  if (asObject && "noul" in asObject) {
    return (
      <div className="mt-1.5">
        <NoulLine label={t("ai_dec_inject")} value={Number(asObject.noul) || 0} />
      </div>
    );
  }
  // ── audit: verdict counts ──
  if (decision.purpose === "audit" && record.verdicts && typeof record.verdicts === "object") {
    const counts = record.verdicts as Record<string, number>;
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-ink-2">
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
        className="mt-1.5 max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-[11px] text-ink-2"
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
                    <p className="break-words text-ink-2" dir="auto">
                      <span className="text-ink-3">{t("ai_dec_question")}: </span>
                      {decision.question}
                    </p>
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
