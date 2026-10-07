// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Calculator } from "lucide-react";
import { CallResults } from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The calculator view: the expression IS the row (`expr = result` on the
    shell), the result cards (when the call collided with sources) sit
    OUTSIDE the fold -- the one sanctioned always-visible body. */
export const calculatorView: ToolView = {
  Icon: Calculator,
  label: ({ call }) => call.q,
  metric: ({ call, t }) =>
    call.status === "pending" ? t("ai_calc_running") : call.status === "ok" ? `= ${call.result ?? "?"}` : null,
  expandable: () => false,
  alwaysContent: ({ results }) => (results.length > 0 ? <CallResults results={results} /> : null),
};
