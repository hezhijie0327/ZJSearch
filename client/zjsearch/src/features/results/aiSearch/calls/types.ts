// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { ComponentType, ReactNode } from "react";
import type { AiSearchCall, AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import type { Translate } from "@/lib/i18n.ts";

/**
 * The settlement-view contract: ONE declaration per tool kind, consumed
 * by the shared `ToolRow` kernel.  A view owns exactly the per-tool
 * vocabulary -- icon, row label, the right-side metric phrase, and (when
 * the default does not fit) the expanded body -- never the row language
 * itself (status mark, fold chevron, debug panes, the metric/timing
 * cluster: that is the kernel's, identical for every row).
 */

export interface ToolRowProps {
  call: AiSearchCall;
  /** the run's [n] registry slice for this call (dupes resolved) */
  results: AiSearchSource[];
  t: Translate;
}

export interface ToolView {
  /** the row's leading lucide icon (size-3, ink-inherit) */
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** the row label (the query / url / table title / fixed verb) */
  label(props: ToolRowProps): string;
  /**
   * The right-side mono metric.  Return the phrase for whatever status
   * the call is in (pending / ok / the settled tails are kernel-fixed)
   * -- or `null` to render NO metric slot: the kernel then shows the
   * bare timing without the middot separator (an empty metric must
   * never leave an orphan `· <time>` cluster).
   */
  metric(props: ToolRowProps): string | null;
  /**
   * The chevron's expanded body.  Default (omit): the reading pane for
   * text-bearing calls, the result-card strip otherwise.  Return null
   * to fall through to that default.
   */
  Content?(props: ToolRowProps): ReactNode | null;
  /** Chevron present at all?  Default: the body would not be empty. */
  expandable?(props: ToolRowProps): boolean;
  /** Content rendered OUTSIDE the fold, unconditionally (calculator's
      `expr = result` sits on the row itself). */
  alwaysContent?(props: ToolRowProps): ReactNode | null;
}
