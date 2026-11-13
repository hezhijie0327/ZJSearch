// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Table } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The build_table view (the report mode's structured-evidence
    channel): the table's caption is the row, the recorded matrix folds
    open as a real table with per-row citation refs.  The refs column
    only mounts when at least one row carries refs, and then renders
    for EVERY row (a headed column, no ragged borders); each ref wears
    the house [n] chip vocabulary. */
export const buildTableView: ToolView = {
  Icon: Table,
  label: ({ call }) => call.q || String(call.args?.title ?? ""),
  metric: ({ call, t }) =>
    call.status === "pending"
      ? t("ai_extract_running")
      : call.status === "ok"
        ? t("ai_extract_done", { n: String(call.n ?? (Array.isArray(call.args?.rows) ? call.args.rows.length : 0)) })
        : null,
  Content: ({ call, t }) => {
    const columns = (Array.isArray(call.args?.columns) ? call.args.columns : []) as string[];
    const rows = (Array.isArray(call.args?.rows) ? call.args.rows : []) as Array<{
      cells?: unknown[];
      refs?: unknown[];
    }>;
    if (!columns.length || !rows.length) {
      return null;
    }
    const withRefs = rows.some((row) => (row.refs ?? []).length > 0);
    return (
      <div className="mt-1 overflow-x-auto rounded-lg bg-surface-2/50 p-2">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th className="border-b border-line px-2 py-1 text-start font-medium text-ink-3" key={i}>
                  {String(col)}
                </th>
              ))}
              {withRefs ? (
                <th className="border-b border-line px-2 py-1 text-start font-medium text-ink-3">
                  {t("ai_search_sources")}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {(row.cells ?? []).map((cell, ci) => (
                  <td className="border-b border-line/50 px-2 py-1 text-ink" dir="auto" key={ci}>
                    {String(cell ?? "")}
                  </td>
                ))}
                {withRefs ? (
                  <td className="border-b border-line/50 px-2 py-1">
                    {(row.refs ?? []).length > 0 ? (
                      <span className="flex flex-wrap items-center gap-1">
                        {(row.refs ?? []).map(String).map((ref) => (
                          <span
                            className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-accent-soft px-1 text-xs font-medium leading-4 text-accent"
                            key={ref}
                          >
                            [{ref}]
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {typeof call.args?.note === "string" && call.args.note ? (
          <p className="mt-1 px-2 text-xs text-ink-3" dir="auto">
            {call.args.note}
          </p>
        ) : null}
      </div>
    );
  },
  expandable: ({ call }) =>
    Array.isArray(call.args?.rows) && call.args.rows.length > 0 && Array.isArray(call.args?.columns),
};
