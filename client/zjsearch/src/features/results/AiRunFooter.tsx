// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Ban,
  Brain,
  BrainCircuit,
  CircleCheck,
  Database,
  DatabaseZap,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { formatTokens } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { SCROLLBAR_NONE } from "@/lib/styles.ts";

/** The run's consolidated token usage -- the shape every dialect's usage
    capture produces (AI Search's finish wire event and the AI Overview's
    trailing meta sentinel both carry it). */
export interface AiUsagePhase {
  input: number;
  output: number;
  thoughts?: number;
  cached?: number;
  cache_write?: number;
}

export interface AiUsage {
  input: number;
  output: number;
  thoughts: number | null;
  cached: number;
  cache_write: number;
  /** the PER-PHASE split (the loop's research turns vs the writer) and the
      gates' account (the small completions: research gate, clarify,
      standalone rewrite, related fallback, memory extraction) -- the row
      shows the totals; every segment toggles ITS metric's distribution */
  research?: AiUsagePhase | null;
  write?: AiUsagePhase | null;
  gates?: (AiUsagePhase & { calls: number }) | null;
}

/** The run's quiet meta line at the END of the answer (lobehub's message
    footer): the model the API response reported on the left, the token
    cluster next to it (labels ride the tooltips -- numbers only inline),
    the transport outcome on the right.  EVERY finish reason gets a
    visible state (truncation "length" and friends are warnings the user
    must see, never silently swallowed).  Mount it once the run settles. */
export function AiRunFooter({
  finish,
  model,
  usage,
}: {
  finish?: string | null;
  model?: string | null;
  usage?: AiUsage | null;
}) {
  const t = useT();
  if (!finish && !usage && !model) {
    return null;
  }
  // every finish state carries its own icon and tone: ok = green check,
  // truncation = amber triangle, filter/refusal = red block, the rare
  // tool_calls tail = a neutral wrench
  let note: { text: string; icon: typeof CircleCheck; cls: string } | null = null;
  if (finish === "length") {
    note = { text: t("ai_finish_length"), icon: AlertTriangle, cls: "text-accent" };
  } else if (finish === "content_filter") {
    note = { text: t("ai_finish_content_filter"), icon: ShieldAlert, cls: "text-danger" };
  } else if (finish === "refusal") {
    note = { text: t("ai_finish_refusal"), icon: Ban, cls: "text-danger" };
  } else if (finish === "tool_calls") {
    note = { text: t("ai_finish_tool_calls"), icon: Wrench, cls: "" };
  } else if (finish && finish !== "stop") {
    note = { text: t("ai_finish_other", { reason: finish }), icon: AlertTriangle, cls: "text-accent" };
  } else if (finish === "stop") {
    note = { text: t("ai_finish_stop"), icon: CircleCheck, cls: "text-ok" };
  }
  const segments: { icon: typeof ArrowUp; title: string; value: string }[] = usage
    ? [
        { icon: ArrowUp, title: t("ai_usage_input_title"), value: formatTokens(usage.input) },
        { icon: ArrowDown, title: t("ai_usage_output_title"), value: formatTokens(usage.output) },
        ...(usage.thoughts
          ? [{ icon: Brain, title: t("ai_usage_thinking_title"), value: formatTokens(usage.thoughts) }]
          : []),
        ...(usage.cached
          ? [{ icon: Database, title: t("ai_usage_cached_title"), value: formatTokens(usage.cached) }]
          : []),
        ...(usage.cache_write
          ? [{ icon: DatabaseZap, title: t("ai_usage_cache_write_title"), value: formatTokens(usage.cache_write) }]
          : []),
      ]
    : [];
  return (
    // one line that SWIPES horizontally on narrow screens (the meta-row
    // language: overflow-x + hidden scrollbar + shrink-0 children) --
    // wrapping a token cluster reads as broken layout
    <div
      className={`zjs-print-hide flex items-center gap-x-3 overflow-x-auto whitespace-nowrap text-xs text-ink-3 ${SCROLLBAR_NONE} [&>*]:shrink-0`}
    >
      {model ? (
        <span
          className="inline-flex min-h-6 items-center gap-1.5 rounded-full bg-surface-2 px-2.5"
          title={t("ai_run_model_title")}
        >
          <BrainCircuit aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{model}</span>
        </span>
      ) : null}
      {segments.length ? (
        <span className="inline-flex items-center gap-x-3 tabular-nums">
          {segments.map(({ icon: Icon, title, value }) => (
            <span className="inline-flex min-h-6 items-center gap-1" key={title} title={title}>
              <Icon aria-hidden="true" className="size-3 shrink-0" />
              {value}
            </span>
          ))}
        </span>
      ) : null}
      {note ? (
        <span className={`ms-auto inline-flex min-h-6 items-center gap-1 ${note.cls}`} title={note.text}>
          <note.icon aria-hidden="true" className="size-3 shrink-0" />
          <span>{note.text}</span>
        </span>
      ) : null}
    </div>
  );
}
