// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  ArrowUpDown,
  ArrowUpRight,
  BookOpenText,
  Camera,
  Check,
  ChevronsUpDown,
  Copy,
  FileDown,
  Globe,
  History,
  Hourglass,
  Keyboard,
  Layers,
  ListChecks,
  ListTree,
  LogOut,
  type LucideIcon,
  MousePointerClick,
  MoveHorizontal,
  Paperclip,
  Pointer,
  QrCode,
  Smartphone,
} from "lucide-react";
import type { ToolRowProps } from "@/features/results/aiSearch/calls/types.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { HOVER_CHIP, READ_PANE } from "@/lib/styles.ts";

/** Compact label for a read row: host + trimmed path -- the url is
    what identifies the read (two pages on one site must look different);
    a malformed url shows as-is. */
export function pageLabel(url: string | undefined): string {
  if (!url) {
    return "?";
  }
  try {
    const parsed = new URL(url);
    const raw = parsed.pathname === "/" ? "" : parsed.pathname + parsed.search;
    // the raw path is percent-encoded mojibake for CJK queries -- decode
    // for the human eye (a malformed sequence keeps the raw form)
    let path = raw;
    try {
      path = decodeURIComponent(raw);
    } catch {
      /* keep the raw form */
    }
    return parsed.hostname + path;
  } catch {
    return url;
  }
}

/** The interactive browser session's row: one row per ACTION, each with
    its own icon, label and rendered result -- the screenshot shows its
    shot (click to zoom), open/snapshot render the session's interactive
    element outline, click/type/press/scroll render the page they left
    the session on, read/wait_user render the reading pane.  The frame
    images are VOLATILE (never persisted): a replay keeps the trail's
    text, the live run shows everything. */

export const ACTION_ICONS: Record<string, LucideIcon> = {
  open: Globe,
  snapshot: ListTree,
  click: MousePointerClick,
  type: Keyboard,
  press: Keyboard,
  scroll: ArrowUpDown,
  screenshot: Camera,
  decode: QrCode,
  hover: Pointer,
  select: ChevronsUpDown,
  drag: MoveHorizontal,
  viewport: Smartphone,
  read: BookOpenText,
  fetch: FileDown,
  history: History,
  tab: Layers,
  multi: ListChecks,
  upload: Paperclip,
  wait_user: Hourglass,
  close: LogOut,
};

export function actionOf(call: ToolRowProps["call"]): string {
  return String((call.args as Record<string, unknown> | undefined)?.action ?? "");
}

/** The location line: the page a settled action left the session on --
    title + host, the browser's own address row in miniature. */
export function LocationLine({ page }: { page: { url: string; title: string } }) {
  // the standalone open/snapshot row carries the page the model landed
  // on as a REAL outbound link (the batch step's link row already did --
  // the same action, the same affordance)
  const outbound = /^https?:\/\//.test(page.url);
  const body = (
    <>
      <Globe aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate font-medium text-ink-2" dir="auto">
        {page.title || pageLabel(page.url)}
      </span>
      <span className="hidden max-w-[45%] truncate font-mono text-xs text-ink-3 sm:block">{pageLabel(page.url)}</span>
      {outbound ? <ArrowUpRight aria-hidden="true" className="size-3 shrink-0" /> : null}
    </>
  );
  if (!outbound) {
    return (
      <div className="mt-1 flex min-w-0 items-center gap-1.5 rounded-lg bg-surface-2/50 px-2 py-1.5 text-xs">
        {body}
      </div>
    );
  }
  return (
    <a
      className="mt-1 flex min-w-0 items-center gap-1.5 rounded-lg bg-surface-2/50 px-2 py-1.5 text-xs transition-colors hover:text-ink"
      href={page.url}
      rel="noreferrer"
      target="_blank"
      title={page.url}
    >
      {body}
    </a>
  );
}

/** The session's interactive-element outline (the model's primary read):
    one row per element -- ref chip, role, name -- so the user sees
    exactly what the model sees.  Outline text is untrusted page content:
    rendered as plain text runs, never HTML.  The corner copy chip (the
    reading panes' vocabulary) -- an outline is feed material the user
    may carry elsewhere. */
export function BrowserOutline({ snapshot, t }: { snapshot: string; t: ToolRowProps["t"] }) {
  const copyToast = useCopyToast();
  const lines = snapshot.split("\n");
  const rows = lines.filter((line) => /^(?:f\d+)?e\d+\t/.test(line));
  if (!rows.length) {
    return <p className="mt-1 px-1 text-xs text-ink-3">{t("ai_browser_outline_empty")}</p>;
  }
  return (
    <div className="group relative">
      <div className={`${READ_PANE} mt-1 max-h-56 space-y-0.5 overflow-y-auto overscroll-contain p-1.5`}>
        {lines.map((line, i) => {
          if (line.startsWith("-- frame ")) {
            return (
              <p className="px-1 pt-1 font-mono text-xs text-ink-3" dir="auto" key={`f${i}`}>
                {line.trim()}
              </p>
            );
          }
          const parts = line.split("\t");
          if (parts.length < 3 || !/^(?:f\d+)?e\d+$/.test(parts[0] ?? "")) {
            return null;
          }
          const ref = parts[0] ?? "";
          const role = parts[1] ?? "";
          return (
            <div className="flex min-w-0 items-center gap-1.5 text-xs" key={`${ref}-${i}`}>
              <span className="shrink-0 rounded bg-accent-soft px-1 font-mono text-xs leading-4 text-accent">
                {ref}
              </span>
              <span className="w-16 shrink-0 truncate font-mono text-xs text-ink-3">{role}</span>
              <span className="min-w-0 flex-1 truncate text-ink-2" dir="auto">
                {parts.slice(2).join(" ")}
              </span>
            </div>
          );
        })}
      </div>
      <button
        aria-label={t("copy")}
        className={`absolute end-2 top-2 ${HOVER_CHIP}`}
        onClick={() => {
          copyToast(snapshot);
        }}
        title={t("copy")}
        type="button"
      >
        <Copy aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

/** The tab action's rendered result: the session's tab strip as chips --
    the mirror tab bar's vocabulary at row scale (index badge, title,
    the active tab in accent). */
export function TabStripView({ tabs, t }: { tabs: NonNullable<ToolRowProps["call"]["tabs"]>; t: ToolRowProps["t"] }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {tabs.map((tab) => (
        <span
          className={`inline-flex min-w-0 max-w-56 items-center gap-1 rounded-md border px-1.5 py-1 text-xs ${
            tab.active ? "border-accent-strong bg-accent-soft text-accent" : "border-line text-ink-3"
          }`}
          key={tab.index}
          title={tab.url}
        >
          <span className="shrink-0 font-mono leading-none">[{tab.index}]</span>
          <span className="truncate">{tab.title || tab.url}</span>
          {tab.active ? <Check aria-hidden="true" className="size-3 shrink-0" /> : null}
        </span>
      ))}
      <span className="sr-only">{t("ai_browser_act_tab")}</span>
    </div>
  );
}

/** One step summary's DOCUMENT groups: a multi-index read's per-tab
    sections, or the single-document shape (url + text) every other step
    speaks.  Empty unless the step carries readable documents. */
