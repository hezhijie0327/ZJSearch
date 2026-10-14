// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Reply } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The message_subtask view: the follow-up row's label is the addressed
    subagent's id + the message head; the resumed child's timeline
    RE-OPENS its existing kind:"sub" row, so this row stays a one-liner
    (the fresh digest arrives as the settlement receipt's debug pane). */
export const messageSubtaskView: ToolView = {
  Icon: Reply,
  label: ({ call }) => call.label || call.q,
  metric: () => null,
};
