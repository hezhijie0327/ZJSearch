// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  AppWindow,
  ArrowUpDown,
  BookOpenText,
  Camera,
  ChevronsUpDown,
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
  Pointer,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { Lightbox } from "@/features/results/aiSearch/AttachmentLightbox.tsx";
import type { ToolRowProps, ToolView } from "@/features/results/aiSearch/calls/types.ts";
import { READ_PANE } from "@/lib/styles.ts";

/** Compact label for a read row: host + trimmed path -- the url is
    what identifies the read (two pages on one site must look different);
    a malformed url shows as-is. */
function pageLabel(url: string | undefined): string {
  if (!url) {
    return "?";
  }
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname + parsed.search;
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

const ACTION_ICONS: Record<string, LucideIcon> = {
  open: Globe,
  snapshot: ListTree,
  click: MousePointerClick,
  type: Keyboard,
  press: Keyboard,
  scroll: ArrowUpDown,
  screenshot: Camera,
  hover: Pointer,
  select: ChevronsUpDown,
  drag: MoveHorizontal,
  read: BookOpenText,
  history: History,
  tab: Layers,
  multi: ListChecks,
  wait_user: Hourglass,
  close: LogOut,
};

function actionOf(call: ToolRowProps["call"]): string {
  return String((call.args as Record<string, unknown> | undefined)?.action ?? "");
}

/** The location line: the page a settled action left the session on --
    title + host, the browser's own address row in miniature. */
function LocationLine({ page }: { page: { url: string; title: string } }) {
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 rounded-lg bg-surface-2/50 px-2 py-1.5 text-xs">
      <Globe aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate text-ink-2" dir="auto">
        {page.title || page.url}
      </span>
      <span className="hidden shrink-0 font-mono text-xs text-ink-3 sm:inline">{pageLabel(page.url)}</span>
    </div>
  );
}

/** The session's interactive-element outline (the model's primary read):
    one row per element -- ref chip, role, name -- so the user sees
    exactly what the model sees.  Outline text is untrusted page content:
    rendered as plain text runs, never HTML. */
function BrowserOutline({ snapshot, t }: { snapshot: string; t: ToolRowProps["t"] }) {
  const lines = snapshot.split("\n");
  const rows = lines.filter((line) => /^(?:f\d+)?e\d+\t/.test(line));
  if (!rows.length) {
    return <p className="mt-1 px-1 text-xs text-ink-3">{t("ai_browser_outline_empty")}</p>;
  }
  return (
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
            <span className="shrink-0 rounded bg-accent-soft px-1 font-mono text-xs leading-4 text-accent">{ref}</span>
            <span className="w-16 shrink-0 truncate font-mono text-xs text-ink-3">{role}</span>
            <span className="min-w-0 flex-1 truncate text-ink-2" dir="auto">
              {parts.slice(2).join(" ")}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The screenshot action's rendered result: the shot as a FIXED-HEIGHT
    thumb (a viewport shot and an element close-up read at the same scale
    -- a full-width render let a tall close-up shove the whole timeline
    around), the page line under it; the click opens the shared image
    lightbox at full size.  The shot PERSISTS (the stream consumer keeps
    shot-marked bytes); mirror-frame rows and pre-marking replays show
    the honest placeholder instead. */
function BrowserShot({ call, t }: ToolRowProps): ReactNode {
  const [zoom, setZoom] = useState(false);
  const page = call.page;
  return (
    <div className="mt-1">
      {call.img ? (
        <button
          aria-label={t("ai_browser_zoom")}
          className="block w-fit cursor-zoom-in overflow-hidden rounded-xl border border-line bg-ink/5"
          onClick={() => {
            setZoom(true);
          }}
          type="button"
        >
          <img
            alt={page?.title || page?.url || t("ai_browser_act_screenshot")}
            className="h-40 w-auto object-contain"
            src={call.img}
          />
        </button>
      ) : (
        <p className="flex items-center gap-1.5 rounded-lg bg-surface-2/50 px-2 py-2 text-xs text-ink-3">
          <Camera aria-hidden="true" className="size-3.5 shrink-0" />
          {t("ai_browser_shot_volatile")}
        </p>
      )}
      {page ? <LocationLine page={page} /> : null}
      {zoom && call.img ? (
        <Lightbox
          initialIndex={0}
          items={[{ alt: page?.title || page?.url || t("ai_browser_act_screenshot"), kind: "img", src: call.img }]}
          onClose={() => {
            setZoom(false);
          }}
        />
      ) : null}
    </div>
  );
}

export const browseView: ToolView = {
  Icon: AppWindow,
  iconFor: ({ call }) => {
    const Icon = ACTION_ICONS[actionOf(call)] ?? AppWindow;
    return <Icon aria-hidden="true" className="size-3 shrink-0" />;
  },
  label: ({ call, t }) => {
    const action = actionOf(call);
    const args = call.args as Record<string, unknown> | undefined;
    switch (action) {
      case "open":
        return pageLabel(call.url || call.page?.url);
      case "snapshot":
        return t("ai_browser_act_snapshot");
      case "click": {
        const ref = String(args?.ref ?? "").trim();
        if (ref) {
          return `${t("ai_browser_act_click")} ${ref}`;
        }
        const cx = args?.x;
        const cy = args?.y;
        return cx !== undefined || cy !== undefined
          ? `${t("ai_browser_act_click")} ${cx ?? "?"},${cy ?? "?"}`
          : t("ai_browser_act_click");
      }
      case "type": {
        const text = String(args?.text ?? "").trim();
        return text
          ? `${t("ai_browser_act_type")} "${text.slice(0, 24)}${text.length > 24 ? "…" : ""}"`
          : t("ai_browser_act_type");
      }
      case "press":
        return `${t("ai_browser_act_press")} ${String(args?.key ?? "").trim()}`.trim();
      case "scroll":
        return `${t("ai_browser_act_scroll")} ${String(args?.direction ?? "") === "up" ? "↑" : "↓"}`;
      case "screenshot": {
        const ref = String(args?.ref ?? "").trim();
        return ref ? `${t("ai_browser_act_screenshot")} ${ref}` : t("ai_browser_act_screenshot");
      }
      case "hover": {
        const ref = String(args?.ref ?? "").trim();
        return ref ? `${t("ai_browser_act_hover")} ${ref}` : t("ai_browser_act_hover");
      }
      case "select": {
        const ref = String(args?.ref ?? "").trim();
        return ref ? `${t("ai_browser_act_select")} ${ref}` : t("ai_browser_act_select");
      }
      case "drag": {
        const x2 = args?.x2;
        const y2 = args?.y2;
        return x2 !== undefined || y2 !== undefined
          ? `${t("ai_browser_act_drag")} → ${x2 ?? "?"},${y2 ?? "?"}`
          : t("ai_browser_act_drag");
      }
      case "read":
        return pageLabel(call.url || call.page?.url);
      case "wait_user":
        return t("ai_browser_act_wait");
      case "close":
        return t("ai_browser_act_close");
      default:
        return call.label || action || "browse";
    }
  },
  metric: ({ call, t }) => {
    if (call.status === "pending") {
      return actionOf(call) === "wait_user" ? t("ai_browser_row_pending") : t("ai_browser_row_running");
    }
    if (call.status !== "ok") {
      return null;
    }
    switch (actionOf(call)) {
      case "open":
      case "snapshot":
        if (!call.n) {
          return null;
        }
        return t(call.n === 1 ? "ai_browser_element_one" : "ai_browser_elements", { n: String(call.n) });
      case "read":
        return t("ai_page_chars", { n: String(call.chars ?? 0) });
      case "screenshot":
        return t("ai_browser_shot_done");
      case "wait_user":
        return t("ai_browser_row_waited");
      default:
        return null;
    }
  },
  Content: ({ call, t }): ReactNode => {
    const action = actionOf(call);
    if (action === "screenshot") {
      return <BrowserShot call={call} results={[]} t={t} />;
    }
    if (action === "open" || action === "snapshot") {
      return (
        <>
          {call.page ? <LocationLine page={call.page} /> : null}
          {call.snapshot ? <BrowserOutline snapshot={call.snapshot} t={t} /> : null}
        </>
      );
    }
    if (
      action === "click" ||
      action === "type" ||
      action === "press" ||
      action === "scroll" ||
      action === "hover" ||
      action === "select" ||
      action === "drag"
    ) {
      return call.page ? <LocationLine page={call.page} /> : null;
    }
    // read / wait_user carry the reading pane through the DEFAULT body
    // (call.text -> CallContent); returning null falls through to it
    return null;
  },
  expandable: ({ call, results }) => Boolean(call.img || call.snapshot || call.page || call.text) || results.length > 0,
};
