// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { FileText } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";
import { TEMPLATE_SHAPE_ICONS } from "@/features/results/aiSearch/reportTemplates.ts";

/** The set_deliverable view: the committed shape wears its own icon and
    the metric names it (report / deck) -- the run's structure card picks up
    the flip through the mode fold, so this row stays a one-line marker
    (no expansion; the raw args live on the BUG chip like every row). */
export const setDeliverableView: ToolView = {
  Icon: FileText,
  iconFor: ({ call }) => {
    const Icon = TEMPLATE_SHAPE_ICONS[String(call.args?.shape) === "deck" ? "deck" : "report"];
    return <Icon aria-hidden="true" className="size-3 shrink-0" />;
  },
  label: ({ t }) => t("ai_deliverable_row"),
  metric: ({ call, t }) => {
    if (call.status === "pending") {
      return t("ai_deliverable_pending");
    }
    if (call.status !== "ok") {
      return null;
    }
    return String(call.args?.shape) === "deck" ? t("ai_deliverable_deck") : t("ai_deliverable_report");
  },
};
