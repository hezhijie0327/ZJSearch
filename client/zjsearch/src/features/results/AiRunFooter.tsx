// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { AlertTriangle, ArrowDown, ArrowUp, Brain, BrainCircuit, Database, DatabaseZap } from "lucide-react";
import { formatTokens } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";

/** The run's consolidated token usage -- the shape every dialect's usage
    capture produces (AI Search's finish wire event and the AI Overview's
    trailing meta sentinel both carry it). */
export interface AiUsage {
  input: number;
  output: number;
  thoughts: number | null;
  cached: number;
  cache_write: number;
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
  let note: { text: string; warn: boolean } | null = null;
  if (finish === "length") {
    note = { text: t("ai_finish_length"), warn: true };
  } else if (finish === "content_filter") {
    note = { text: t("ai_finish_content_filter"), warn: true };
  } else if (finish === "refusal") {
    note = { text: t("ai_finish_refusal"), warn: true };
  } else if (finish === "tool_calls") {
    note = { text: t("ai_finish_tool_calls"), warn: false };
  } else if (finish && finish !== "stop") {
    note = { text: t("ai_finish_other", { reason: finish }), warn: true };
  } else if (finish === "stop") {
    note = { text: t("ai_finish_stop"), warn: false };
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
      {model ? (
        <span
          className="inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-full bg-surface-2 px-2.5"
          title={t("ai_run_model_title")}
        >
          <BrainCircuit aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{model}</span>
        </span>
      ) : null}
      {segments.length ? (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
          {segments.map(({ icon: Icon, title, value }) => (
            <span className="inline-flex min-h-6 items-center gap-1" key={title} title={title}>
              <Icon aria-hidden="true" className="size-3 shrink-0" />
              {value}
            </span>
          ))}
        </span>
      ) : null}
      {note ? (
        <span
          className={`ms-auto inline-flex min-h-6 items-center gap-1 ${note.warn ? "text-accent" : ""}`}
          title={note.text}
        >
          {note.warn ? <AlertTriangle aria-hidden="true" className="size-3 shrink-0" /> : null}
          <span className="truncate">{note.text}</span>
        </span>
      ) : null}
    </div>
  );
}
