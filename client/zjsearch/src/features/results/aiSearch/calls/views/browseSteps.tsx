// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  AppWindow,
  ArrowUpRight,
  BookOpenText,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  CornerDownRight,
  Globe,
} from "lucide-react";
import { useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import { BodyRow } from "@/features/results/aiSearch/calls/bodyParts.tsx";
import type { ToolRowProps } from "@/features/results/aiSearch/calls/types.ts";
import { ACTION_ICONS, pageLabel } from "@/features/results/aiSearch/calls/views/browseParts.tsx";
import { useCopyToast } from "@/lib/clipboard.ts";
import { HOVER_CHIP, READ_PANE } from "@/lib/styles.ts";

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
    case "decode":
      return t("ai_browser_act_decode");
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

export function MultiSteps({ call, t }: { call: ToolRowProps["call"]; t: ToolRowProps["t"] }) {
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
        // a multi-index read's FAILED tabs: alert rows BESIDE the read
        // documents -- the step used to show the tabs that succeeded and
        // no trace of the others
        const failures = structured ? (d?.errors ?? []) : [];
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
              ) : failures.length ? (
                // the step succeeded only in part: the warning mark, never
                // the check, above a row that carries a failed tab
                <CircleAlert aria-hidden="true" className="size-3 shrink-0 text-warning" />
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
                  {failures.map((failure) => (
                    <div
                      className="flex min-h-6 min-w-0 items-center gap-1.5 text-xs text-danger"
                      key={`failed-${failure.index}`}
                    >
                      <CircleAlert aria-hidden="true" className="size-3 shrink-0" />
                      <span className="truncate" dir="auto" title={failure.error}>
                        {failure.url ? pageLabel(failure.url) : `[${failure.index}]`} · {failure.error}
                      </span>
                    </div>
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
                  {!failed && structured && action === "decode" && d?.label ? (
                    // a decode step's label IS its payload (the decoded
                    // text the model read in the feed) -- the one step
                    // whose product is text, so it renders right here
                    <div className="mt-0.5 truncate ps-[18px] font-mono text-xs text-ink-3" dir="auto" title={d.label}>
                      {d.label}
                    </div>
                  ) : null}
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
    around), centered as the row's figure; the click opens the shared
    image lightbox at full size.  The shot PERSISTS (the stream consumer
    keeps shot-marked bytes); mirror-frame rows and pre-marking replays
    show the honest placeholder instead.  `hidePage` drops the location
    line (the multi branch: the step cards above already name the page). */
