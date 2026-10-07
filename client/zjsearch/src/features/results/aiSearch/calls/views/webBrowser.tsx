// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { AppWindow } from "lucide-react";
import type { ReactNode } from "react";

import { CallContent } from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";
import { pageLabel } from "@/features/results/aiSearch/calls/views/webReader.tsx";

/** The interactive browser session's row: per-action labels (the opened
    page, the human's operation window, the visual capture), the extracted
    reading text as the foldable content (the reader's reading pane). */
export const webBrowserView: ToolView = {
  Icon: AppWindow,
  label: ({ call }) => {
    const action = String((call.args as Record<string, unknown> | undefined)?.action ?? "");
    if (call.url) {
      return pageLabel(call.url);
    }
    if (action === "wait_user") {
      return "wait_user";
    }
    if (action === "screenshot") {
      return "screenshot";
    }
    return action || "web_browser";
  },
  metric: ({ call, t }) => {
    if (call.status === "pending") {
      return t("ai_browser_row_pending");
    }
    const action = String((call.args as Record<string, unknown> | undefined)?.action ?? "");
    if (action === "wait_user" && call.status === "ok") {
      return t("ai_browser_row_waited");
    }
    if (call.status === "ok") {
      return t("ai_browser_row_ok");
    }
    return null;
  },
  Content: ({ call }): ReactNode => (call.text ? <CallContent call={call} /> : null),
  expandable: ({ call }) => Boolean(call.text),
};
