// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookOpen } from "lucide-react";
import type { ReactNode } from "react";
import { CallContent, CallResults } from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** Compact label for a web_reader row: host + trimmed path -- the url is
    what identifies the read (two pages on one site must look different);
    a malformed url shows as-is. */
function pageLabel(url: string | undefined): string {
  if (!url) {
    return "?";
  }
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname + parsed.search;
    return parsed.hostname + path;
  } catch {
    return url;
  }
}

/** The web_reader view: the reading pane AND the colliding result cards
    share the chevron (a long read must not push the timeline around
    uninvited); the row's icon leads with the page's favicon when the
    read's source card carries one. */
export const webReaderView: ToolView = {
  Icon: BookOpen,
  label: ({ call }) => pageLabel(call.url),
  metric: ({ call, t }) =>
    call.status === "pending"
      ? t("ai_page_reading")
      : call.status === "ok"
        ? t("ai_page_chars", { n: String(call.chars ?? 0) })
        : null,
  Content: ({ call, results }): ReactNode => (
    <>
      {call.text ? <CallContent call={call} /> : null}
      <CallResults results={results} />
    </>
  ),
  expandable: ({ call, results }) => Boolean(call.text) || results.length > 0,
};
