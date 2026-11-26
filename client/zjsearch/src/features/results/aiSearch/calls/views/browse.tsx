// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { AppWindow, Camera } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Lightbox } from "@/features/aiAnswer/AttachmentLightbox.tsx";
import type { ToolRowProps, ToolView } from "@/features/results/aiSearch/calls/types.ts";
import {
  ACTION_ICONS,
  actionOf,
  BrowserOutline,
  LocationLine,
  pageLabel,
  TabStripView,
} from "@/features/results/aiSearch/calls/views/browseParts.tsx";
import { MultiSteps } from "@/features/results/aiSearch/calls/views/browseSteps.tsx";

function BrowserShot({ call, t, hidePage }: ToolRowProps & { hidePage?: boolean }): ReactNode {
  const [zoom, setZoom] = useState(false);
  const page = call.page;
  return (
    <div className="mt-1">
      {call.img ? (
        <button
          aria-label={t("ai_browser_zoom")}
          className="mx-auto block w-fit cursor-zoom-in overflow-hidden rounded-xl border border-line bg-ink/5"
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
      {page && !hidePage ? <LocationLine page={page} /> : null}
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
      case "decode": {
        const ref = String(args?.ref ?? "").trim();
        return ref ? `${t("ai_browser_act_decode")} ${ref}` : t("ai_browser_act_decode");
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
      case "decode":
        return t("ai_browser_decode_done");
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
          {/* a batch can END on a screenshot (its settlement's img): the
            same shot card the standalone row renders, minus the location
            line (the step cards above already name the page) -- gated on
            the wire shot mark so a volatile mirror frame never renders */}
          {call.shot && call.img ? <BrowserShot call={call} hidePage results={[]} t={t} /> : null}
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
