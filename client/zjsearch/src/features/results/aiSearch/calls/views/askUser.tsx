// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { MessageCircleQuestion } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The ask_user view: the question's intro folds open with the ask spec
    (each question + its options); the settled row shows the bare timing
    (the answer lives in the clarify archive, not the metric slot). */
export const askUserView: ToolView = {
  Icon: MessageCircleQuestion,
  label: ({ call, t }) => call.q || t("ai_ask_row"),
  metric: ({ call, t }) => (call.status === "pending" ? t("ai_ask_awaiting") : null),
  Content: ({ call }) => {
    const intro = String(call.args?.intro ?? "").trim();
    const questions = (Array.isArray(call.args?.questions) ? call.args.questions : []) as Array<{
      q?: unknown;
      options?: unknown;
    }>;
    if (!intro && !questions.length) {
      return null;
    }
    return (
      <div className="space-y-1.5 rounded-lg bg-surface-2/50 px-2.5 py-2">
        {intro ? (
          <p className="break-words text-[13px] leading-relaxed text-ink-2" dir="auto">
            {intro}
          </p>
        ) : null}
        {questions.map((question, index) => (
          <div key={index}>
            <p className="break-words text-[13px] text-ink" dir="auto">
              {String(question.q ?? "")}
            </p>
            <p className="break-words text-xs text-ink-3" dir="auto">
              {(Array.isArray(question.options) ? question.options : []).map(String).join("  ·  ")}
            </p>
          </div>
        ))}
      </div>
    );
  },
  expandable: ({ call }) =>
    Boolean(String(call.args?.intro ?? "").trim()) ||
    (Array.isArray(call.args?.questions) && call.args.questions.length > 0),
};
