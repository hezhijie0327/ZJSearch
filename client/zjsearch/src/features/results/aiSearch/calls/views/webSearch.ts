// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Search } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The web_search view (and the unknown-tool fallback via the registry):
    the query, the result count -- the body is the kernel default (the
    result-card strip). */
export const webSearchView: ToolView = {
  Icon: Search,
  label: ({ call }) => call.q,
  metric: ({ call, t }) =>
    call.status === "pending"
      ? t("ai_search_running")
      : call.status === "ok"
        ? (call.n ?? 0) > 0
          ? t("ai_search_results", { n: String(call.n ?? 0) })
          : t("ai_search_no_results")
        : null,
};
