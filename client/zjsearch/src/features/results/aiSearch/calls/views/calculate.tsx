// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Calculator, Copy } from "lucide-react";
import { CallResults } from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { CHIP_HOVER, MONO_CHIP } from "@/lib/styles.ts";

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
  Content: ({ call, t }) => {
    const copyToast = useCopyToast();
    const result = call.result ?? "";
    if (!result) {
      return null;
    }
    return (
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="min-w-0 break-all font-mono text-sm text-ink" dir="auto">
          {result}
        </span>
        <button
          aria-label={t("copy")}
          className={`${MONO_CHIP} cursor-pointer ${CHIP_HOVER}`}
          onClick={() => {
            copyToast(result);
          }}
          title={t("copy")}
          type="button"
        >
          <Copy aria-hidden="true" className="size-3" />
        </button>
      </div>
    );
  },
  alwaysContent: ({ results }) => (results.length > 0 ? <CallResults results={results} /> : null),
};
