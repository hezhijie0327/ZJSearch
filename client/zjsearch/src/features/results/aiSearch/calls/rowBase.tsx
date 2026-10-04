// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ArrowUpRight, Bug, Check, ChevronDown, CircleAlert, Copy, Globe, LoaderCircle, Minus } from "lucide-react";
import type { ReactNode } from "react";
import type { AiSearchCall, AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { formatMs } from "@/lib/format.ts";
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

/** The row shell: status mark + the row's tool icon, label and status
    metric behind the fold toggle (aria-expanded + the rotating chevron
    when the row can fold), and -- beside the toggle, NOT nested in it --
    the BUG chip that reveals the debug panes (raw arguments, the model's
    receipt, the timing).  The chevron shows the RENDERED result; the bug
    shows how it was made.  Each per-tool row owns both states and passes
    them in. */
export function CallRowShell({
  call,
  expandable,
  open,
  onToggle,
  icon,
  label,
  metric,
  debuggable = false,
  debugOpen = false,
  onToggleDebug,
}: {
  call: AiSearchCall;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;
  metric: string;
  debuggable?: boolean;
  debugOpen?: boolean;
  onToggleDebug?: () => void;
}) {
  const t = useT();
  return (
    <div
      className={`flex min-h-6 w-full items-center gap-1 px-1 text-xs ${
        call.status === "error" ? "text-danger" : "text-ink-3"
      }`}
    >
      <button
        aria-expanded={expandable ? open : undefined}
        className={`flex min-w-0 flex-1 items-center gap-1.5 ${expandable ? "transition-colors hover:text-ink" : ""}`}
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
        <span className="w-24 shrink-0 text-end font-mono tabular-nums opacity-70">
          {call.ms !== undefined ? formatMs(call.ms) : ""}
        </span>
        {expandable ? (
          <ChevronDown
            aria-hidden="true"
            className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        ) : null}
      </button>
      {debuggable ? (
        <button
          aria-label={t("ai_debug")}
          aria-pressed={debugOpen}
          className={`grid size-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-surface-2/50 hover:text-ink ${
            debugOpen ? "text-accent" : ""
          }`}
          onClick={onToggleDebug}
          title={t("ai_debug")}
          type="button"
        >
          <Bug aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

/** The tiny muted label above a debug pane. */
function DebugLabel({ label }: { label: string }) {
  return <div className="px-1 pb-1 text-[11px] font-medium text-ink-3">{label}</div>;
}

/** The DEBUG pane: the model's raw tool-call arguments, exactly as
    passed -- mono, scroll-capped, copyable. */
export function DebugArgs({ rawArgs }: { rawArgs: string }) {
  const t = useT();
  const copyToast = useCopyToast();
  return (
    <div className="mt-1">
      <DebugLabel label={t("ai_debug_args")} />
      <div className="group relative">
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
    </div>
  );
}

/** The model's RECEIPT pane: the head of the exact tool-result text the
    executor fed back (what the model actually saw).  Same visual language
    as the args pane -- mono, scroll-capped, copyable -- with `dir="auto"`
    (feed text is prose, often CJK). */
export function DebugFeed({ feed }: { feed: string }) {
  const t = useT();
  const copyToast = useCopyToast();
  return (
    <div className="mt-1">
      <DebugLabel label={t("ai_debug_feed")} />
      <div className="group relative">
        <div
          className="max-h-40 overflow-y-auto overscroll-contain rounded-lg bg-surface-2/50 py-2 pe-10 ps-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-ink-2"
          dir="auto"
        >
          {feed}
        </div>
        <button
          aria-label={t("copy")}
          className="absolute end-2 top-2 grid size-7 place-items-center rounded-lg bg-surface/80 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
          onClick={() => {
            copyToast(feed);
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

/** The row's debug expansion composition: the raw-arguments pane, the
    model-receipt pane and the call's wall time, in contract order.  Rows
    render it inside their fold when ANY piece exists -- the expandable
    conditions OR the pieces (rawArgs / call.feed / results). */
export function DebugPanes({ call, rawArgs }: { call: AiSearchCall; rawArgs: string | null }) {
  return (
    <>
      {rawArgs ? <DebugArgs rawArgs={rawArgs} /> : null}
      {call.feed ? <DebugFeed feed={call.feed} /> : null}
    </>
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
