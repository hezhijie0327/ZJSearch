// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { DatabaseSearch } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The engine_info view: a fixed row label; the settlement's preview
    (the deployment's category + engine inventory) renders in the shared
    reading pane, n carries the enabled-engine count. */
export const engineInfoView: ToolView = {
  Icon: DatabaseSearch,
  label: ({ t }) => t("ai_engine_info_row"),
  metric: ({ call, t }) =>
    call.status === "pending"
      ? t("ai_engine_info_running")
      : call.status === "ok"
        ? t("ai_engine_info_done", { n: String(call.n ?? 0) })
        : null,
};
