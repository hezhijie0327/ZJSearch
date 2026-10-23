// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookMarked } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** host of a match url (the identity row's right slot; a malformed url
    shows the raw tail). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 30);
  }
}

/** The recall_history view: the query + its match count, and the matches
    themselves as identity rows (title + host) -- the past research this
    call dug up, the source card's own vocabulary at row scale.  The
    fold stores the settlement's preview lines in ``call.text``. */
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
  Content: ({ call }) => {
    const lines = (call.text ?? "").split("\n").filter((line) => line.trim());
    if (!lines.length) {
      return null;
    }
    return (
      <div className="mt-1 space-y-0.5">
        {lines.map((line, i) => {
          const cut = line.lastIndexOf(" -- ");
          const title = cut > 0 ? line.slice(0, cut) : line;
          const url = cut > 0 ? line.slice(cut + 4) : "";
          return (
            <div
              className="flex min-w-0 items-center gap-1.5 rounded-md bg-surface-2/50 px-1.5 py-1 text-xs"
              key={`${i}-${line.slice(0, 24)}`}
            >
              <BookMarked aria-hidden="true" className="size-3 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-ink-2" dir="auto">
                {title}
              </span>
              {url ? (
                <span className="hidden max-w-[45%] truncate font-mono text-xs text-ink-3 sm:block">{hostOf(url)}</span>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  },
  expandable: ({ call }) => (call.text ?? "").split("\n").some((line) => line.trim()),
};
