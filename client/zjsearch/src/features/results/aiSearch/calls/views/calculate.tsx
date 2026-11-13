// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Calculator } from "lucide-react";
import { CopyValue } from "@/features/results/aiSearch/calls/bodyParts.tsx";
import { CallResults } from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The calculate view: the expression IS the row (`expr = result` on the
    shell), the result cards (when the call collided with sources) sit
    OUTSIDE the fold -- the one sanctioned always-visible body.  The fold
    carries the FULL-PRECISION result as a copyable value chip (the
    hash/ip answer vocabulary): a computed figure is a payload the reader
    takes elsewhere, and the metric slot truncates long decimals. */
export const calculateView: ToolView = {
  Icon: Calculator,
  label: ({ call }) => call.q,
  metric: ({ call, t }) =>
    call.status === "pending" ? t("ai_calc_running") : call.status === "ok" ? `= ${call.result ?? "?"}` : null,
  expandable: ({ call }) => call.status === "ok" && Boolean(call.result),
  Content: ({ call, t }) => (call.result ? <CopyValue t={t} value={call.result} /> : null),
  alwaysContent: ({ results }) => (results.length > 0 ? <CallResults results={results} /> : null),
};
