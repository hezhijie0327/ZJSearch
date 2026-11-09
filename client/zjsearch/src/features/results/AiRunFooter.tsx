// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Ban,
  Brain,
  BrainCircuit,
  CircleCheck,
  Database,
  DatabaseZap,
  Flag,
  Network,
  Scale,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { haltLabelText, haltReasonText } from "@/features/results/aiSearch/halts.ts";
import { formatTokens } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { SCROLLBAR_NONE } from "@/lib/styles.ts";

/** The run's consolidated token usage -- the shape every dialect's usage
    capture produces (AI Search's finish wire event and the AI Overview's
    trailing meta sentinel both carry it). */
interface AiUsagePhase {
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
  /** the ranking cascade's endpoint spend (NOT LLM tokens) */
  rerank?: { calls: number; tokens: number };
  /** the decision model's judgments (input-only) */
  decision?: { calls: number; tokens: number };
  /** the server-side embedding spend (input-only) */
  embedding?: { calls: number; tokens: number };
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
  haltReason,
}: {
  finish?: string | null;
  model?: string | null;
  usage?: AiUsage | null;
  /** the settle's machine key for a guard-caused early end of the
      research (stalled / time_budget / round_budget / loop_detected) --
      an honest guard note the user must see, never silently swallowed */
  haltReason?: string | null;
}) {
  const t = useT();
  if (!finish && !usage && !model && !haltReason) {
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
        // the non-generating endpoints' input-only buckets (each shows its
        // TOKENS; the tooltip names the model class)
        ...(usage.rerank
          ? [{ icon: ArrowUpDown, title: t("ai_usage_rerank_title"), value: formatTokens(usage.rerank.tokens) }]
          : []),
        ...(usage.decision
          ? [{ icon: Scale, title: t("ai_usage_decision_title"), value: formatTokens(usage.decision.tokens) }]
          : []),
        ...(usage.embedding
          ? [{ icon: Network, title: t("ai_usage_embedding_title"), value: formatTokens(usage.embedding.tokens) }]
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
      {haltReason
        ? (() => {
            // the SHORT label inline, the full sentence on hover (the row's
            // tooltip language -- a guard note must not stretch the meta
            // row); unknown/legacy values degrade to the verbatim string on
            // both surfaces
            const label = haltLabelText(haltReason, t);
            const detail = haltReasonText(haltReason, t);
            return (
              <span
                className="inline-flex min-h-6 items-center gap-1 text-accent"
                title={label === detail ? undefined : detail}
              >
                <Flag aria-hidden="true" className="size-3 shrink-0" />
                <span>{label}</span>
              </span>
            );
          })()
        : null}
      {note ? (
        <span className={`ms-auto inline-flex min-h-6 items-center gap-1 ${note.cls}`} title={note.text}>
          <note.icon aria-hidden="true" className="size-3 shrink-0" />
          <span>{note.text}</span>
        </span>
      ) : null}
    </div>
  );
}
