// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The browser mirror's shared anatomy (the rail card AND the Lightbox
    takeover): the wire-frame view type, the viewport-space helpers, the
    address form, the action mark overlay, the live pulse and the session
    tab strip.  One home so the card and the takeover cannot drift. */

import { Bot, MousePointer2, VideoOff } from "lucide-react";
import type { AiSearchRun } from "@/features/results/aiSearch/runModel.ts";
import { sessionViewport } from "@/lib/browserInput.ts";
import { useT } from "@/lib/i18n.ts";
import { hostnameOf } from "@/lib/link.ts";
import { SCROLLBAR_NONE } from "@/lib/styles.ts";

export type MirrorView = NonNullable<AiSearchRun["browser"]>;

// The session viewport's LAUNCH dimensions (engine WINDOW) ride the ai
// capability at boot (browserInput.sessionViewport) -- the fallback for
// frames that carry no w/h; live coordinates always map through the
// frame's own capture dimensions.  NO local constant: a drifted one is
// exactly the 1.5x-click bug this replaced.
const viewportDims = () => sessionViewport();
export const VIEWPORT_W = () => viewportDims().w;
export const VIEWPORT_H = () => viewportDims().h;

/** The address bar's compact form: host + path (the browser-chrome anchor
    the mirror was missing -- the bare page title read as a caption, not
    an address). */
export function addressOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

/** The ACTION MARK: the session's last model action drawn ON the frame --
    the touched element's box, the drag's gesture line, and an intent
    label, plus the cursor + one-shot click ripple at the landing point
    (px/py viewport space, rendered as percentages of the displayed
    frame).  The SERVER ships the vocabulary (the action kind + the
    element's own name from its snapshot directory); the CLIENT speaks
    the sentence -- the same i18n'd action keys the timeline rows use,
    so the label names the element, never the machine ref.  A synthetic
    overlay -- viewport screenshots never contain one -- so the viewer
    sees WHAT the model did, not just where its cursor rests.  Everything
    is optional; old frames render bare. */
export function ActionMark({ view }: { view: MirrorView }) {
  const t = useT();
  const hasPoint = view.px !== undefined && view.py !== undefined;
  const box = Array.isArray(view.box) && view.box.length === 4 ? view.box : null;
  const dragLine = view.x2 !== undefined && view.y2 !== undefined && hasPoint;
  const verb =
    view.pk === "click"
      ? t("ai_browser_act_click")
      : view.pk === "type"
        ? t("ai_browser_act_type")
        : view.pk === "hover"
          ? t("ai_browser_act_hover")
          : view.pk === "select"
            ? t("ai_browser_act_select")
            : view.pk === "shot"
              ? t("ai_browser_act_screenshot")
              : view.pk === "drag"
                ? t("ai_browser_act_drag")
                : "";
  const markLabel = (() => {
    if (view.pk === "drag") {
      return hasPoint && view.x2 !== undefined && view.y2 !== undefined
        ? `${verb} ${view.px},${view.py} → ${view.x2},${view.y2}`
        : verb;
    }
    if (!verb) {
      return "";
    }
    if (view.name) {
      return view.pk === "type" ? `${verb} "${view.name}"` : `${verb} ${view.name}`;
    }
    return hasPoint ? `${verb} ${view.px},${view.py}` : verb;
  })();
  if (!hasPoint && !box && !markLabel) {
    return null;
  }
  const w = view.w || VIEWPORT_W();
  const h = view.h || VIEWPORT_H();
  const pct = (v: number, span: number) => `${Math.min(Math.max(v / span, 0), 1) * 100}%`;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 animate-fade-in">
      {box ? (
        <div
          className="absolute rounded-sm border-2 border-accent bg-accent/10"
          style={{
            left: pct(box[0] ?? 0, w),
            top: pct(box[1] ?? 0, h),
            width: pct(box[2] ?? 0, w),
            height: pct(box[3] ?? 0, h),
          }}
        />
      ) : null}
      {dragLine ? (
        <svg
          aria-hidden="true"
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          viewBox={`0 0 ${w} ${h}`}
        >
          <line
            className="text-accent"
            stroke="currentColor"
            strokeDasharray="10 8"
            strokeWidth={4}
            x1={view.px}
            x2={view.x2}
            y1={view.py}
            y2={view.y2}
          />
          <circle className="fill-accent" cx={view.px} cy={view.py} r={7} />
          <circle className="fill-accent" cx={view.x2} cy={view.y2} r={7} />
        </svg>
      ) : null}
      {hasPoint ? (
        <span
          className="absolute z-10"
          style={{
            left: pct(view.px ?? 0, w),
            top: pct(view.py ?? 0, h),
            transition: "left 250ms ease, top 250ms ease",
          }}
        >
          <MousePointer2
            aria-hidden="true"
            className="size-4 -translate-x-0.5 -translate-y-0.5 fill-ink text-ink drop-shadow-md"
          />
          {view.pk === "click" ? (
            <span
              aria-hidden="true"
              className="zjs-ripple absolute left-0 top-0 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent"
              key={`${view.px}-${view.py}`}
            />
          ) : null}
        </span>
      ) : null}
      {markLabel ? (
        <span
          className="absolute z-10 max-w-[60%] truncate rounded-md bg-accent px-1.5 py-0.5 text-xs text-accent-contrast shadow-md"
          dir="auto"
          style={{
            left: pct(box ? (box[0] ?? 0) : (view.px ?? 0), w),
            top: pct(box ? Math.max((box[1] ?? 0) - 22, 2) : (view.py ?? 0) + 14, h),
          }}
        >
          {markLabel}
        </span>
      ) : null}
    </div>
  );
}

/** The byte-less frame's honest placeholder: replayed browser events keep
    their meta but never the volatile jpeg bytes (the run host strips them
    on every replay line) -- the rail card and the takeover render this
    instead of a broken image, and the takeover's pointer forwarding stands
    down with the frame. */
export function FramePlaceholder({ view, className = "" }: { view: MirrorView; className?: string }) {
  const t = useT();
  return (
    <div
      aria-label={t("ai_browser_frame_live")}
      className={`grid place-items-center gap-2 bg-surface-2/40 ${className}`}
      role="img"
      style={{ aspectRatio: `${view.w || VIEWPORT_W()} / ${view.h || VIEWPORT_H()}` }}
    >
      <VideoOff aria-hidden="true" className="size-8 text-ink-3" />
      <span className="px-4 text-center text-xs leading-snug text-ink-3">{t("ai_browser_frame_live")}</span>
    </div>
  );
}

export function LivePulse() {
  return (
    <span className="relative flex size-2 shrink-0">
      <span
        aria-hidden="true"
        className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60"
      />
      <span aria-hidden="true" className="relative inline-flex size-2 rounded-full bg-accent" />
    </span>
  );
}

/** The session tabs' shared anatomy (the rail card AND the takeover):
    browser chrome at rail scale -- an identity glyph per tab (the lead's
    agent mark, a hostname letter disc for the frozen ones), the active
    tab's page title merging into the surface below (the attached-tab
    seam), background tabs as hostnames. */
export function SessionTabs({
  activeId,
  entries,
  onPick,
}: {
  activeId: string;
  entries: [string, MirrorView][];
  onPick: (id: string) => void;
}) {
  return (
    <div className={`flex items-end gap-1 bg-surface-2/60 px-1.5 pt-1.5 ${SCROLLBAR_NONE} overflow-x-auto`}>
      {entries.map(([sid, item]) => {
        const active = sid === activeId || entries.length === 1;
        const isLead = sid === "lead";
        const host = hostnameOf(item.url);
        return (
          <button
            aria-label={item.title || sid}
            aria-pressed={active}
            className={`flex min-w-0 max-w-44 shrink-0 items-center gap-1.5 rounded-t-lg px-2.5 py-1.5 text-[13px] transition-colors ${
              active ? "bg-surface font-medium text-ink" : "text-ink-3 hover:bg-surface/60 hover:text-ink-2"
            }`}
            key={sid}
            onClick={() => {
              onPick(sid);
            }}
            title={item.title || item.url}
            type="button"
          >
            {isLead ? (
              <Bot aria-hidden="true" className="size-3.5 shrink-0 text-accent" />
            ) : (
              <span
                aria-hidden="true"
                className="grid size-3.5 shrink-0 place-items-center rounded-[4px] border border-line bg-surface text-[9px] font-bold leading-none text-ink-2"
              >
                {(host.charAt(0) || "?").toUpperCase()}
              </span>
            )}
            <span className="truncate">{active ? item.title || host : host}</span>
          </button>
        );
      })}
    </div>
  );
}
