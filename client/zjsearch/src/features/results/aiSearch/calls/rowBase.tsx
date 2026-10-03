// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ArrowUpRight, Check, ChevronDown, CircleAlert, Copy, Globe, LoaderCircle, Minus } from "lucide-react";
import type { ReactNode } from "react";
import type { AiSearchCall, AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { type Translate, useT } from "@/lib/i18n.ts";
import { HOVER_CHIP, READ_PANE, SCROLLBAR_NONE } from "@/lib/styles.ts";

/**
 * The shared tool-call row skeleton: every per-tool row in this directory
 * composes its row from these pieces so the rows can only drift in their
 * own icon/label/metric/body, never in the row language (status mark,
 * fold chevron, debug-args pane, reading pane, result-card strip).
 */

/** The model's raw tool-call arguments as the debug pane's text (null
    when the call carries no arguments). */
export function rawArgsOf(call: AiSearchCall): string | null {
  return call.args && Object.keys(call.args).length > 0 ? JSON.stringify(call.args, null, 2) : null;
}

/** The row-leading status mark: the pending spinner, the settled check,
    the interrupted/duplicate minus, the error alert. */
export function CallStatusIcon({ call }: { call: AiSearchCall }) {
  return call.status === "pending" ? (
    <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin" />
  ) : call.status === "ok" ? (
    <Check aria-hidden="true" className="size-3 shrink-0 text-ok" />
  ) : call.status === "interrupted" || call.status === "duplicate" ? (
    <Minus aria-hidden="true" className="size-3 shrink-0" />
  ) : (
    <CircleAlert aria-hidden="true" className="size-3 shrink-0 text-danger" />
  );
}

/** The row's settled-state text (interrupted / duplicate / failed) -- the
    shared tail of every row's status-metric slot. */
export function settledCallText(call: AiSearchCall, t: Translate): string {
  return call.status === "interrupted"
    ? t("ai_search_row_interrupted")
    : call.status === "duplicate"
      ? t("ai_search_row_duplicate")
      : t("ai_search_row_failed");
}

/** The `<button>` row shell: status mark + the row's tool icon, label and
    status metric, aria-expanded + the rotating chevron when the row can
    fold.  Each per-tool row owns its `open` state and passes it in. */
export function CallRowShell({
  call,
  expandable,
  open,
  onToggle,
  icon,
  label,
  metric,
}: {
  call: AiSearchCall;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;
  metric: string;
}) {
  return (
    <button
      aria-expanded={expandable ? open : undefined}
      className={`flex min-h-6 w-full items-center gap-1.5 px-1 text-xs ${
        call.status === "error" ? "text-danger" : "text-ink-3"
      } ${expandable ? "transition-colors hover:text-ink" : ""}`}
      onClick={() => {
        if (expandable) {
          onToggle();
        }
      }}
      type="button"
    >
      <CallStatusIcon call={call} />
      {icon}
      <span className="truncate" dir="auto">
        {label}
      </span>
      <span className="ms-auto shrink-0 ps-2 font-mono tabular-nums">{metric}</span>
      {expandable ? (
        <ChevronDown
          aria-hidden="true"
          className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      ) : null}
    </button>
  );
}

/** The DEBUG pane: the model's raw tool-call arguments, exactly as
    passed -- mono, scroll-capped, copyable. */
export function DebugArgs({ rawArgs }: { rawArgs: string }) {
  const t = useT();
  const copyToast = useCopyToast();
  return (
    <div className="group relative mt-1">
      <div
        className="max-h-40 overflow-y-auto overscroll-contain rounded-lg bg-surface-2/50 py-2 pe-10 ps-3 text-xs leading-relaxed whitespace-pre-wrap break-words text-ink-2"
        dir="ltr"
      >
        {rawArgs}
      </div>
      <button
        aria-label={t("copy")}
        className="absolute end-2 top-2 grid size-7 place-items-center rounded-lg bg-surface/80 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
        onClick={() => {
          copyToast(rawArgs);
        }}
        title={t("copy")}
        type="button"
      >
        <Copy aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

/** A tool row's content pane (the web_reader page markdown, an MCP
    result) under PROGRESSIVE DISCLOSURE: a fixed-height preview first --
    bottom-faded, one 展开全文 pill -- expanding into the scroll-capped
    full text on demand.  Short content skips the staging entirely.
    The corner chips (hover, the CodeBlock pattern) carry the
    external-open and copy paths. */
export function CallContent({ call }: { call: AiSearchCall }) {
  const t = useT();
  const copyToast = useCopyToast();
  const text = call.text ?? "";
  // NO progressive disclosure: the pane is the row's point and it scrolls
  // INTERNALLY (max-h-96) -- a preview-then-expand second fold is friction
  // the internal scroll already solves
  return (
    <div className="group relative mt-1">
      <div className={`relative ${READ_PANE} max-h-96 overflow-y-auto overscroll-contain`} dir="auto">
        {text}
      </div>
      <div className="absolute end-2 top-2 flex gap-0.5">
        {call.url ? (
          <a
            aria-label={t("open_source")}
            className={`${HOVER_CHIP} hover:text-accent`}
            href={call.url}
            rel="noreferrer"
            target="_blank"
            title={t("open_source")}
          >
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </a>
        ) : null}
        <button
          aria-label={t("copy")}
          className={HOVER_CHIP}
          onClick={() => {
            copyToast(text);
          }}
          title={t("copy")}
          type="button"
        >
          <Copy aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** One settled search's result cards (DeltaV's expandable tool row): a
    swipe strip of small title + favicon + domain cards, each opening the
    result page.  Fed from the run's [n] registry slice for that call --
    the DEFAULT expansion body (every row whose content is neither a
    reading pane nor a bare args pane falls through to it). */
export function CallResults({ results }: { results: AiSearchSource[] }) {
  return (
    <div className={`mt-1 flex gap-2 overflow-x-auto pb-1 ${SCROLLBAR_NONE} [&>*]:shrink-0`}>
      {results.map((source) => (
        <a
          className="w-44 rounded-lg bg-surface-2/70 p-2 transition-colors hover:bg-surface-2"
          href={source.url}
          key={source.n}
          rel="noreferrer"
          target="_blank"
        >
          <p className="line-clamp-2 text-xs font-medium leading-snug text-ink" dir="auto">
            {source.title}
          </p>
          <span className="mt-1.5 flex min-w-0 items-center gap-1">
            {source.favicon ? (
              <img alt="" aria-hidden="true" className="size-3.5 rounded object-contain" src={source.favicon} />
            ) : (
              <Globe aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
            )}
            <span className="truncate text-xs text-ink-3">{source.netloc}</span>
          </span>
        </a>
      ))}
    </div>
  );
}
