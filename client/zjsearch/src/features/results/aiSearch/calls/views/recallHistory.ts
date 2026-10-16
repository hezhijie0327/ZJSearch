// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookMarked } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The recall_history view: the query and its match count. */
export const recallHistoryView: ToolView = {
  Icon: BookMarked,
  label: ({ call }) => call.q,
  metric: ({ call, t }) =>
    call.status === "pending"
      ? t("ai_recall_running")
      : call.status === "ok"
        ? (call.n ?? 0) > 0
          ? t("ai_recall_hits", { n: String(call.n ?? 0) })
          : null
        : null,
};
