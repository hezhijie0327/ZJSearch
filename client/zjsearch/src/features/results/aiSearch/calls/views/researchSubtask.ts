// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Waypoints } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The research_subtask view: the delegation row's label is the
    subtask's title; the live mini-timeline lives under the sibling
    open kind:"sub" row, so this row stays a one-liner (its settlement
    receipt carries the digest in the debug pane). */
export const researchSubtaskView: ToolView = {
  Icon: Waypoints,
  label: ({ call }) => call.label || call.q,
  metric: ({ call }) => (call.status === "pending" ? null : null),
};
