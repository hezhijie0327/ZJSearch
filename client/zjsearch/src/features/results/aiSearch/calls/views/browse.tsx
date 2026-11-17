// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  AppWindow,
  ArrowUpDown,
  ArrowUpRight,
  BookOpenText,
  Camera,
  Check,
  ChevronDown,
  ChevronsUpDown,
  CircleAlert,
  Copy,
  CornerDownRight,
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
  Smartphone,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { Collapse } from "@/components/Collapse.tsx";
import { Lightbox } from "@/features/results/aiSearch/AttachmentLightbox.tsx";
import { BodyRow } from "@/features/results/aiSearch/calls/bodyParts.tsx";
import type { ToolRowProps, ToolView } from "@/features/results/aiSearch/calls/types.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { HOVER_CHIP, READ_PANE } from "@/lib/styles.ts";

/** Compact label for a read row: host + trimmed path -- the url is
    what identifies the read (two pages on one site must look different);
    a malformed url shows as-is. */
function pageLabel(url: string | undefined): string {
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

function actionOf(call: ToolRowProps["call"]): string {
  return String((call.args as Record<string, unknown> | undefined)?.action ?? "");
}

/** The location line: the page a settled action left the session on --
    title + host, the browser's own address row in miniature. */
function LocationLine({ page }: { page: { url: string; title: string } }) {
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
function BrowserOutline({ snapshot, t }: { snapshot: string; t: ToolRowProps["t"] }) {
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
function TabStripView({ tabs, t }: { tabs: NonNullable<ToolRowProps["call"]["tabs"]>; t: ToolRowProps["t"] }) {
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
function stepDocs(d: NonNullable<ToolRowProps["call"]["steps"]>[number]): Array<{
  url: string;
  title: string;
  chars?: number;
  text: string;
}> {
  return d.sections?.length
    ? d.sections
    : d.text
      ? [{ url: d.url ?? "", title: d.title ?? "", chars: d.chars, text: d.text }]
      : [];
}

/** A landing-only step's grounded card (tab new / open / a
    click-through): the location line's vocabulary at step scale -- the
    landing page is the step's product.  The card spans the content
    column (the timeline's one content line -- the badge occupies the
    icon slot ahead of it).  A url-less step (a plain type/press)
    renders nothing. */
function StepLanding({ d }: { d: NonNullable<ToolRowProps["call"]["steps"]>[number] }) {
  if (!d.url) {
    return null;
  }
  return (
    <BodyRow className="mt-0.5">
      <StepLinkRow g={{ title: d.title, url: d.url }} />
    </BodyRow>
  );
}

/** The landing-page link row (the LocationLine's vocabulary at step
    scale): the title when the page carries one, host+path always. */
function StepLinkRow({ g }: { g: { title?: string; url: string } }) {
  return (
    <a
      className="flex min-w-0 items-center gap-1.5 text-xs text-ink-2 transition-colors hover:text-ink"
      dir="auto"
      href={g.url}
      rel="noreferrer"
      target="_blank"
      title={g.url}
    >
      <Globe aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate font-medium">{g.title || pageLabel(g.url)}</span>
      {g.title ? (
        <span className="hidden max-w-[45%] truncate font-mono text-xs text-ink-3 sm:block">{pageLabel(g.url)}</span>
      ) : null}
      <ArrowUpRight aria-hidden="true" className="size-3 shrink-0" />
    </a>
  );
}

/** One read step's document row: THE STANDALONE READ ROW ITSELF (the
    row-header anatomy -- book icon, host+path label, the chars metric
    on the right edge, the fold chevron -- and the reading pane hanging
    DIRECTLY off the line, no verb tier, no card).  The step's verdict
    check lives in the batch list's leading status slot, so every
    status mark in the timeline lines up on one x.  The title rides the
    tooltip and the document's own first line, exactly like the
    standalone row; the pane's corner chips carry the outbound open and
    the copy.  Its own open state -- a multi-tab read's panes open
    independently. */
function StepReadRow({
  g,
  t,
  autoOpen = false,
}: {
  g: { url: string; title: string; chars?: number; text: string };
  t: ToolRowProps["t"];
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const copyToast = useCopyToast();
  return (
    <div>
      <div className="flex min-h-6 w-full items-center gap-1.5 text-xs text-ink-3">
        <BookOpenText aria-hidden="true" className="size-3 shrink-0" />
        <button
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 transition-colors hover:text-ink"
          onClick={() => {
            setOpen(!open);
          }}
          type="button"
        >
          <span className="truncate" dir="auto" title={g.url || g.title}>
            {g.url ? pageLabel(g.url) : g.title || "?"}
          </span>
          <span className="ms-auto flex shrink-0 items-center gap-1 ps-2 font-mono text-xs tabular-nums">
            {t("ai_page_chars", { n: String(g.chars ?? g.text.length) })}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      <Collapse className={open ? "mt-1" : ""} open={open}>
        <div className="group relative">
          <div className={`relative ${READ_PANE} max-h-96 overflow-y-auto overscroll-contain`} dir="auto">
            {g.text}
          </div>
          <div className="absolute end-2 top-2 flex gap-0.5">
            <button
              aria-label={t("copy")}
              className={HOVER_CHIP}
              onClick={() => {
                copyToast(g.text);
              }}
              title={t("copy")}
              type="button"
            >
              <Copy aria-hidden="true" className="size-3.5" />
            </button>
            {g.url ? (
              <a
                aria-label={t("open_source")}
                className={HOVER_CHIP}
                href={g.url}
                rel="noreferrer"
                target="_blank"
                title={t("open_source")}
              >
                <ArrowUpRight aria-hidden="true" className="size-3.5" />
              </a>
            ) : null}
          </div>
        </div>
      </Collapse>
    </div>
  );
}

/** One multi step's localized VERB (the standalone label's vocabulary
    minus the detail: a landing-bearing step's target renders in its own
    card below the verb line, a read step's documents ARE the step's own
    rows -- the verb line never speaks for either). */
function stepVerb(action: string, step: Record<string, unknown>, t: ToolRowProps["t"]): string {
  switch (action) {
    case "open":
      return t("ai_browser_act_open");
    case "snapshot":
      return t("ai_browser_act_snapshot");
    case "click":
      return t("ai_browser_act_click");
    case "type":
      return t("ai_browser_act_type");
    case "press":
      return t("ai_browser_act_press");
    case "scroll":
      return t("ai_browser_act_scroll");
    case "screenshot":
      return t("ai_browser_act_screenshot");
    case "hover":
      return t("ai_browser_act_hover");
    case "select":
      return t("ai_browser_act_select");
    case "drag":
      return t("ai_browser_act_drag");
    case "viewport":
      return t("ai_browser_act_viewport");
    case "read":
      return t("ai_browser_act_read");
    case "upload":
      return t("ai_browser_act_upload");
    case "history":
      return t(
        String(step.op ?? "") === "reload"
          ? "ai_browser_act_reload"
          : String(step.op ?? "") === "forward"
            ? "ai_browser_act_forward"
            : "ai_browser_act_back",
      );
    case "tab":
      return t(
        String(step.op ?? "new") === "switch"
          ? "ai_browser_tab_switch"
          : String(step.op ?? "new") === "close"
            ? "ai_browser_tab_close"
            : "ai_browser_tab_new",
      );
    case "wait_user":
      return t("ai_browser_act_wait");
    case "close":
      return t("ai_browser_act_close");
    default:
      return action || "?";
  }
}

function MultiSteps({ call, t }: { call: ToolRowProps["call"]; t: ToolRowProps["t"] }) {
  const readable = (line: string) =>
    line.replace(/https?:\/\/[^\s)]+/g, (url) => {
      try {
        return decodeURI(url);
      } catch {
        return url;
      }
    });
  const raw = (call.args as Record<string, unknown> | undefined)?.steps;
  const steps = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  const lines = call.feed?.split("\n").filter((line) => /^\d+\. /.test(line)) ?? [];
  // a structured batch renders from its summaries alone (verb + link +
  // pane) -- the feed is only the legacy/pending vocabulary's source
  const structuredRenderable = steps.some((_, i) => {
    const d = call.steps?.[i];
    return (
      d !== undefined && d.status !== "error" && (Boolean(d.url) || Boolean(d.text) || Boolean(d.sections?.length))
    );
  });
  // the batch's ONLY readable document opens its pane directly (the row
  // chevron already is the disclosure -- the standalone read's depth;
  // a multi-INDEX read's sections each count as one document)
  const documentCount = (call.steps ?? [])
    .filter((s) => s.status !== "error")
    .reduce((sum, s) => sum + (s.sections?.length ?? (s.text ? 1 : 0)), 0);
  const autoOpenPane = documentCount === 1;
  if (!steps.length || (!lines.length && !structuredRenderable && call.status === "ok")) {
    return null;
  }
  return (
    <ol className="mt-1 space-y-1.5">
      {steps.map((step, i) => {
        const action = String(step.action ?? "");
        const Icon = ACTION_ICONS[action] ?? AppWindow;
        // the structured summary drives the rendering when it exists --
        // the feed line is the fallback vocabulary (legacy replays /
        // pending steps) and the failed step's error carrier
        const d = call.steps?.[i];
        const structured = d !== undefined && d.status !== "error";
        const line = readable(lines[i] ?? "");
        const cut = line.indexOf(". ");
        let tail = cut > 0 ? line.slice(cut + 2) : line;
        // a PENDING batch has no feed lines yet -- the step's own url is
        // what the reader wants to see (where this step is headed)
        if (!tail) {
          tail = String(step.url ?? "").slice(0, 120);
        }
        // the service's tail leads with the ENGLISH action name ("scroll:")
        // -- the localized verb is rendered on the step's own line
        tail = tail.replace(/^[a-z_]+: /, "");
        const failed = d?.status === "error" || tail.includes("error:");
        // the step's VERB: the localized action name, never the target
        // (the standalone label composes verb+detail because the row has
        // no second line -- a numbered step's target lives in its card
        // below, so the verb line stays the VERB; reusing the standalone
        // label rendered the read step's host where its verb belongs)
        const verb = stepVerb(action, step, t);
        // the legacy observation lines (no structured summary): the
        // destination (the feed's "now:" page) and the raw rest
        const nowAt = tail.indexOf(". now: ");
        const dest = nowAt > 0 ? tail.slice(nowAt + 7).replace(/\s*\([^)]*\)\s*$/, "") : "";
        const rest = nowAt > 0 ? tail.slice(0, nowAt) : tail;
        // a read step IS its documents: each renders as the standalone
        // read row itself (no verb tier, no card) -- the equal-treatment
        // rule taken to the row level
        const docs = structured ? stepDocs(d) : [];
        return (
          // the verdict mark lives in a LEADING slot so every status mark
          // in the timeline sits on one x, and the badge takes the tool
          // icon's slot: the content column lands exactly where the
          // sibling rows' labels start -- status, icon, content: three
          // lines through the whole timeline.  Pending steps leave the
          // slot empty (the row-level spinner owns "running", and the
          // steps run in order -- five spinners would read as parallel)
          <li className="flex min-w-0 items-start gap-1.5 ps-1 text-xs" key={i}>
            <span className="mt-px flex w-3 shrink-0 justify-center leading-4">
              {failed ? (
                <CircleAlert aria-hidden="true" className="size-3 shrink-0 text-danger" />
              ) : structured ? (
                <Check aria-hidden="true" className="size-3 shrink-0 text-ok" />
              ) : null}
            </span>
            <span
              className={`mt-px w-3 shrink-0 rounded text-center font-mono leading-4 ${
                failed ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent"
              }`}
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              {docs.length ? (
                <div className="space-y-0.5">
                  {docs.map((g, gi) => (
                    <StepReadRow autoOpen={autoOpenPane} g={g} key={gi} t={t} />
                  ))}
                </div>
              ) : (
                <>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Icon aria-hidden="true" className="size-3 shrink-0 text-ink-3" />
                    <span className={`min-w-0 flex-1 truncate font-medium ${failed ? "text-danger" : "text-ink-2"}`}>
                      {verb}
                    </span>
                  </div>
                  {failed ? (
                    <div className="mt-0.5 truncate ps-[18px] text-danger" dir="auto">
                      {tail}
                    </div>
                  ) : structured ? (
                    <StepLanding d={d} />
                  ) : dest ? (
                    <div className="mt-0.5 flex min-w-0 items-center gap-1 ps-[18px] text-ink-3">
                      <CornerDownRight aria-hidden="true" className="size-3 shrink-0" />
                      <span className="min-w-0 flex-1 truncate" dir="auto">
                        {dest}
                      </span>
                    </div>
                  ) : (
                    <div className="mt-0.5 truncate ps-[18px] text-ink-3" dir="auto">
                      {rest}
                    </div>
                  )}
                </>
              )}
            </div>
          </li>
        );
      })}
    </ol>
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
        // the landed page first (a redirect's truth), then the REQUESTED
        // url the model named -- a pending or failed open row carries it
        // in args and used to render "?" until the settle arrived
        return pageLabel(call.url || call.page?.url || String(args?.url ?? ""));
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
      case "scroll": {
        const target = String(args?.text ?? "").trim();
        return target
          ? `${t("ai_browser_act_scroll")} "${target.slice(0, 24)}${target.length > 24 ? "…" : ""}"`
          : `${t("ai_browser_act_scroll")} ${String(args?.direction ?? "") === "up" ? "↑" : "↓"}`;
      }
      case "history":
        return t(
          String(args?.op ?? "") === "forward"
            ? "ai_browser_act_forward"
            : String(args?.op ?? "") === "reload"
              ? "ai_browser_act_reload"
              : "ai_browser_act_back",
        );
      case "tab": {
        const op = String(args?.op ?? "list");
        const idx = args?.index;
        const verb =
          op === "new"
            ? t("ai_browser_tab_new")
            : op === "switch"
              ? t("ai_browser_tab_switch")
              : op === "close"
                ? t("ai_browser_tab_close")
                : t("ai_browser_tab_list");
        return idx !== undefined && (op === "switch" || op === "close") ? `${verb} [${idx}]` : verb;
      }
      case "multi":
        return t("ai_browser_act_multi");
      case "upload": {
        const name = String(args?.download ?? "").trim();
        return name ? `${t("ai_browser_act_upload")} ${name}` : t("ai_browser_act_upload");
      }
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
      case "viewport": {
        const w = args?.width;
        const h = args?.height;
        return w !== undefined && h !== undefined
          ? `${t("ai_browser_act_viewport")} ${String(w)}×${String(h)}`
          : t("ai_browser_act_viewport");
      }
      case "fetch":
        return t("ai_browser_act_fetch");
      case "read": {
        const target = call.url || call.page?.url;
        if (target) {
          return pageLabel(target);
        }
        // a pending session read has no url yet -- the generic running
        // text beats a literal "read ?"; a SETTLED row without one (an
        // interrupted read that never settled) shows the neutral verb
        return call.status === "pending" ? t("ai_browser_row_running") : t("ai_browser_act_read");
      }
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
      case "multi":
      case "click":
      case "type":
      case "press":
      case "history":
      case "tab":
      case "viewport":
        if (!call.n) {
          return null;
        }
        return t(call.n === 1 ? "ai_browser_element_one" : "ai_browser_elements", { n: String(call.n) });
      case "read":
        if (call.chars) {
          return t("ai_page_chars", { n: String(call.chars) });
        }
        return null;
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
    if (action === "tab") {
      return (
        <>
          {call.tabs?.length ? <TabStripView t={t} tabs={call.tabs} /> : null}
          {call.page ? <LocationLine page={call.page} /> : null}
        </>
      );
    }
    if (action === "multi") {
      // the landing card duplicates the LAST step's own card when the
      // batch ended on that page (an open/read step renders it) -- show
      // it only when no structured step already carries the url
      const landing = call.page?.url;
      const covered = (call.steps ?? []).some((st) => st.status !== "error" && st.url === landing);
      return (
        <>
          <MultiSteps call={call} t={t} />
          {call.page && !covered ? <LocationLine page={call.page} /> : null}
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
      action === "drag" ||
      action === "history" ||
      action === "viewport"
    ) {
      return (
        <>
          {call.page ? <LocationLine page={call.page} /> : null}
          {call.snapshot ? <BrowserOutline snapshot={call.snapshot} t={t} /> : null}
        </>
      );
    }
    // read / wait_user carry the reading pane through the DEFAULT body
    // (call.text -> CallContent); returning null falls through to it
    return null;
  },
  expandable: ({ call, results }) => {
    // a PENDING multi is expandable too: the planned steps are the one
    // thing worth reading before the batch finishes (46s of silence
    // otherwise)
    if (
      actionOf(call) === "multi" &&
      Array.isArray((call.args as Record<string, unknown> | undefined)?.steps) &&
      ((call.args as Record<string, unknown>).steps as unknown[]).length > 0
    ) {
      return true;
    }
    return Boolean(call.img || call.snapshot || call.page || call.text || call.tabs) || results.length > 0;
  },
};
