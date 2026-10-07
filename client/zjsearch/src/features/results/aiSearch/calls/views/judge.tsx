// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Scale } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";
import { AnswerValue } from "@/features/results/aiSearch/DecisionsCard.tsx";

/** The judge (SystemOne decision) view: the settled one-line verdict on the
    shell; the chevron opens the SAME structured probability bars the rail's
    decision card renders (one judgment, one rendering -- not a text dump).
    Legacy settlements without `answers` fall through to the kernel default
    (reading pane of the text preview). */
export const judgeView: ToolView = {
  Icon: Scale,
  label: ({ call, t }) => call.q || t("ai_decision_row"),
  metric: ({ call, t }) =>
    call.status === "pending" ? t("ai_decision_running") : call.status === "ok" ? (call.result ?? null) : null,
  Content: ({ call }) => {
    const questions = (Array.isArray(call.args?.questions) ? call.args.questions : []) as Array<{
      name?: unknown;
      instructions?: unknown;
    }>;
    const answers = call.answers;
    if (!answers || !questions.length) {
      return null;
    }
    return (
      <div className="mt-1 space-y-2 rounded-lg bg-surface-2/50 px-2.5 py-2 text-[13px]">
        {questions.map((question, index) => {
          const name = String(question.name ?? `q${index}`);
          return (
            <div key={name}>
              <p className="break-words text-[13px] text-ink-2" dir="auto">
                {String(question.instructions ?? name)}
              </p>
              {answers[name] !== undefined ? <AnswerValue answer={answers[name]} /> : null}
            </div>
          );
        })}
      </div>
    );
  },
  expandable: ({ call, results }) => Boolean(call.answers || call.text) || results.length > 0,
};
