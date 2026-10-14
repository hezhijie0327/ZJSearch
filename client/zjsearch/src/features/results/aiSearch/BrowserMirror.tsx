// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The interactive browser session's mirror: the rail's live card (the
    model-driven page, streamed frame by frame) plus the Lightbox
    takeover (the user's clicks/wheel/keys forwarded to the session's
    page) and the MOBILE wait bar (below lg the rail stacks under the
    answer -- a fixed bottom pill keeps the operation window reachable
    from anywhere on the page).  A wait_user window AUTO-OPENS the
    takeover once: the run blocks on the user, so hiding the prompt
    behind a rail card would stall the run silently.  The frames ride
    the run's ``browser`` wire events; the bytes never persist. */

import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ExternalLink,
  Keyboard,
  Maximize2,
  Minimize2,
  MousePointer2,
  RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AiSearchRun } from "@/features/results/aiSearch/timeline.ts";
import { postBrowserInput } from "@/lib/browserInput.ts";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { useT } from "@/lib/i18n.ts";
import { hostnameOf } from "@/lib/link.ts";
import { ICON_BTN, SCROLLBAR_NONE } from "@/lib/styles.ts";

type MirrorView = NonNullable<AiSearchRun["browser"]>;

const VIEWPORT_W = 1280;
const VIEWPORT_H = 800;

/** The address bar's compact form: host + path (the browser-chrome anchor
    the mirror was missing -- the bare page title read as a caption, not
    an address). */
function addressOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

/** The MODEL POINTER: the session's cursor at the landing point of the
    last ref-targeted action (px/py viewport space, rendered as a
    percentage of the displayed frame), gliding there with a short
    transform transition, with a one-shot click ripple when the tracked
    action was a click.  A synthetic cursor -- viewport screenshots never
    contain one -- so the user can FOLLOW the model's hands between
    snapshots. */
function ModelPointer({ view }: { view: MirrorView }) {
  if (view.px === undefined || view.py === undefined) {
    return null;
  }
  const w = view.w || VIEWPORT_W;
  const h = view.h || VIEWPORT_H;
  const clamp = (v: number, span: number) => `${Math.min(Math.max(v / span, 0), 1) * 100}%`;
  return (
    <span
      className="pointer-events-none absolute z-10"
      style={{ left: clamp(view.px, w), top: clamp(view.py, h), transition: "left 250ms ease, top 250ms ease" }}
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
  );
}

/** Map a click on the DISPLAYED frame to the session's viewport space. */
function frameCoords(event: {
  clientX: number;
  clientY: number;
  currentTarget: { getBoundingClientRect(): DOMRect };
}): { x: number; y: number } {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.round(((event.clientX - rect.left) / rect.width) * VIEWPORT_W),
    y: Math.round(((event.clientY - rect.top) / rect.height) * VIEWPORT_H),
  };
}

function LivePulse() {
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
function SessionTabs({
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

/** The takeover: the live page at full size, the user's clicks/wheel/keys
    forwarded to the session.  Mobile-safe: the stage keeps the frame
    contain-fit, the keyboard bar wraps its two actions.  The session tabs
    ride along (switch context without leaving the takeover), but a
    BACKGROUND tab is a READ-ONLY snapshot there: the input channel is
    bound to the lead's serialized session, so forwarding a click onto a
    frozen frame would operate a page the frame does not show. */
function BrowserLightbox({
  onClose,
  sessions,
  tab,
  onTab,
  view,
}: {
  onClose: () => void;
  sessions?: Record<string, MirrorView>;
  tab: string;
  onTab: (id: string) => void;
  view: MirrorView;
}) {
  const t = useT();
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const [draft, setDraft] = useState("");
  const wheelLock = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const entries = Object.entries(sessions ?? {}).filter(([, item]) => item.img);
  const multi = entries.length > 1;
  const activeView = (multi ? sessions?.[tab] : undefined) ?? view;
  const isLead = !multi || tab === "lead";
  const leadRef = useRef(isLead);
  leadRef.current = isLead;
  /** the POST-ACTION frame the input route returns -- the takeover sees
      its own effect immediately (the model's settlements only update the
      mirror on their own beat); the next wire frame or tab switch clears
      it back to the streamed truth. */
  const [override, setOverride] = useState<MirrorView | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab/view are the TRIGGER, not reads -- a new wire frame or a tab switch clears the local overlay back to the streamed truth
  useEffect(() => {
    setOverride(null);
  }, [tab, view]);
  const shown = override ?? activeView;

  // React's synthetic onWheel is passive -- the takeover must STOP the
  // page behind the fixed overlay from scrolling, so the wheel listener
  // attaches natively (non-passive) once.  On a background tab the wheel
  // only scrolls the overlay's own stage -- nothing to forward.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!leadRef.current) {
        return;
      }
      const now = Date.now();
      if (now - wheelLock.current < 250) {
        return;
      }
      wheelLock.current = now;
      sendRef.current({ type: "wheel", deltaY: event.deltaY > 0 ? 600 : -600 });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  /** Forward one input and overlay the returned post-action frame (the
      wheel listener reads this through sendRef -- its effect is
      mount-once).  A failed forward keeps the live frame as the truth. */
  const send = (payload: Parameters<typeof postBrowserInput>[0]) => {
    void postBrowserInput(payload).then((frame) => {
      if (frame) {
        setOverride({ ...activeView, ...frame });
      }
    });
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // DIRECT TYPING: with the takeover focused, every key lands on the
  // session's page (latin keys as keypresses; the text bar below stays
  // for IME/Chinese composition, which cannot forward key-by-key).
  // Interactive targets are EXEMPT -- their keys stay client-side, or a
  // keyboard user could never activate the close/done buttons (and Tab
  // must keep traversing the dialog's own controls).  A background tab
  // forwards nothing.
  const onDialogKeyDown = (event: React.KeyboardEvent) => {
    if (!isLead) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, button, a")) {
      return; // the takeover's own controls compose/activate locally
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return; // client-side shortcuts stay client-side
    }
    if (event.key.length === 1) {
      event.preventDefault();
      send({ type: "type", text: event.key });
    } else if (
      ["Enter", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      send({ type: "key", key: event.key });
    }
  };

  const finishAndClose = () => {
    send({ type: "done" });
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-black/60 p-2 backdrop-blur-sm sm:p-6">
      <div aria-hidden="true" className="absolute inset-0 animate-fade-in" onClick={onClose} />
      <div
        aria-label={t("ai_browser_live")}
        aria-modal
        className="relative z-10 mx-auto my-auto flex h-auto w-full max-w-5xl animate-fade-up flex-col rounded-2xl border border-line bg-surface p-2 shadow-card outline-none sm:p-4 landscape:h-full"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        {multi ? <SessionTabs activeId={tab} entries={entries} onPick={onTab} /> : null}
        <div className="flex min-h-9 items-center gap-2 pb-2">
          {isLead ? (
            // the takeover's chrome: history back/forward at the address
            // row's start (reload rides with the outbound cluster)
            <>
              <button
                aria-label={t("ai_browser_back")}
                className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2/60 hover:text-ink"
                onClick={() => {
                  send({ type: "back" });
                }}
                title={t("ai_browser_back")}
                type="button"
              >
                <ArrowLeft aria-hidden="true" className="size-3.5" />
              </button>
              <button
                aria-label={t("ai_browser_forward")}
                className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2/60 hover:text-ink"
                onClick={() => {
                  send({ type: "forward" });
                }}
                title={t("ai_browser_forward")}
                type="button"
              >
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </button>
            </>
          ) : null}
          <LivePulse />
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2" title={shown.url}>
            {addressOf(shown.url)}
          </span>
          {isLead ? (
            <button
              aria-label={t("ai_browser_reload")}
              className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2/60 hover:text-ink"
              onClick={() => {
                send({ type: "reload" });
              }}
              title={t("ai_browser_reload")}
              type="button"
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}
          <a
            aria-label={t("open_source")}
            className="hidden shrink-0 text-ink-3 transition-colors hover:text-accent sm:block"
            href={shown.url}
            rel="noreferrer"
            target="_blank"
            title={shown.url}
          >
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
          {isLead && view.waitLeft !== undefined ? (
            <span className="shrink-0 font-mono text-xs tabular-nums text-ink-3" title={t("ai_browser_wait_hint")}>
              {t("ai_browser_wait", { s: String(view.waitLeft) })}
            </span>
          ) : null}
          <button aria-label={t("ai_browser_close")} className={ICON_BTN} onClick={onClose} type="button">
            <Minimize2 aria-hidden="true" className="size-4" />
          </button>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the takeover stage -- clicks forward as viewport coordinates (LEAD ONLY); keyboard users type via the bar or direct typing */}
        <div
          className={`flex min-h-0 items-start justify-center overflow-hidden rounded-xl border border-line bg-ink/5 landscape:flex-1 landscape:items-center ${isLead ? "cursor-crosshair" : ""}`}
          onClick={(event) => {
            if (!isLead) {
              return;
            }
            const target = event.currentTarget;
            if (event.target === target) {
              const { x, y } = frameCoords({ ...event, currentTarget: target });
              send({ type: "click", x, y });
            }
            dialogRef.current?.focus();
          }}
          ref={stageRef}
        >
          <div className="relative">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: the frame
                IS the interaction surface -- the click forwards as a viewport
                coordinate; keyboard users use the bar below */}
            <img
              alt={shown.title || shown.url}
              className={`w-full landscape:h-auto landscape:max-h-full landscape:w-auto ${isLead ? "cursor-crosshair" : ""}`}
              onClick={(event) => {
                if (!isLead) {
                  return;
                }
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                send({
                  type: "click",
                  x: Math.round(((event.clientX - rect.left) / rect.width) * VIEWPORT_W),
                  y: Math.round(((event.clientY - rect.top) / rect.height) * VIEWPORT_H),
                });
                // clicking a non-focusable element blurs the takeover -- pull
                // focus back so direct typing keeps flowing
                dialogRef.current?.focus();
              }}
              role="presentation"
              src={`data:image/jpeg;base64,${shown.img}`}
            />
            <ModelPointer view={shown} />
          </div>
        </div>
        {isLead ? (
          /* the keyboard bar: click a field in the page, type here, Enter
              sends to the session; the keycap forwards Escape; Done hands
              the page back to the model */
          <div className="mt-2 flex items-center gap-2">
            <form
              className="relative flex min-w-0 flex-1 items-center"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft.trim()) {
                  send({ type: "type", text: draft });
                  setDraft("");
                }
              }}
            >
              <Keyboard aria-hidden="true" className="pointer-events-none absolute left-2.5 size-3.5 text-ink-3" />
              <input
                className="h-9 w-full rounded-lg border border-line bg-surface pe-14 ps-8 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t("ai_browser_type_hint")}
                value={draft}
              />
              <button
                aria-label={t("ai_browser_kb_esc")}
                className="absolute end-1.5 flex h-6 items-center rounded-[5px] border border-line bg-surface-2 px-1.5 font-mono text-xs leading-none text-ink-3 transition-colors hover:border-accent hover:text-accent"
                onClick={() => {
                  send({ type: "key", key: "Escape" });
                }}
                title={t("ai_browser_kb_esc")}
                type="button"
              >
                Esc
              </button>
            </form>
            <button
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong"
              onClick={finishAndClose}
              title={t("ai_browser_done_hint")}
              type="button"
            >
              <Check aria-hidden="true" className="size-4" />
              {t("ai_browser_done")}
            </button>
          </div>
        ) : (
          <div className="mt-2 flex min-h-9 items-center justify-center rounded-lg border border-line bg-surface-2/40 px-3 text-center text-xs leading-snug text-ink-3">
            {t("ai_browser_bg_readonly")}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The rail's transient section: pinned FIRST while a session is live.
    A wait_user window auto-opens the takeover ONCE per window (the run
    blocks on the user); minimizing keeps it closed until the next
    window.  Also renders the MOBILE wait bar (fixed bottom pill, below
    lg) so the same window stays reachable from anywhere on the page.
    R3B: with PARALLEL SESSIONS (the lead + delegating subagents) the
    card grows a tab strip -- the ACTIVE tab streams, the background
    tabs freeze on their last frame with the 后台 badge (bandwidth
    economy); the takeover stays the LEAD tab's surface (its wait_user
    is what blocks on the human). */
export function BrowserMirrorSection({ view, sessions }: { view: MirrorView; sessions?: Record<string, MirrorView> }) {
  const t = useT();
  const [tab, setTab] = useState("lead");
  const [full, setFull] = useState(false);
  const windowOpen = useRef(false);
  useEffect(() => {
    if (view.waitLeft === undefined) {
      windowOpen.current = false;
      return;
    }
    if (!windowOpen.current) {
      windowOpen.current = true;
      setFull(true);
    }
  }, [view.waitLeft]);
  const entries = Object.entries(sessions ?? {}).filter(([, item]) => item.img);
  const multi = entries.length > 1;
  const activeView = (multi ? sessions?.[tab] : undefined) ?? view;
  const leadActive = tab === "lead" || !multi;
  const waiting = leadActive && view.waitLeft !== undefined;
  return (
    <section aria-label={t("ai_browser_live")} className="mb-5">
      <div className="flex items-center gap-2 px-1">
        <LivePulse />
        <h3 className="text-base font-semibold text-ink">{t("ai_browser_live")}</h3>
        {waiting ? (
          <span className="shrink-0 font-mono text-xs tabular-nums text-ink-3" title={t("ai_browser_wait_hint")}>
            {t("ai_browser_wait", { s: String(view.waitLeft) })}
          </span>
        ) : null}
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-ink/5">
        {entries.length > 0 ? (
          // the session tabs: ALWAYS at least the lead's own tab (a browser
          // never hides its only tab -- and the page title lives on the
          // tab, not the address row); shared anatomy with the takeover
          <SessionTabs activeId={tab} entries={entries} onPick={setTab} />
        ) : null}
        {/* the ADDRESS ROW: the browser's identity bar -- live pulse, the
            session's current address, and (lead only) the takeover
            affordance / the background freeze badge */}
        <div className="flex min-w-0 items-center gap-2 border-b border-line bg-surface px-2.5 py-1.5">
          <LivePulse />
          <span className="min-w-0 flex-1 truncate text-xs text-ink-2" title={activeView.url}>
            {addressOf(activeView.url)}
          </span>
          {leadActive ? (
            <button
              aria-label={t("ai_browser_full")}
              className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2/60 hover:text-ink"
              onClick={() => {
                setFull(true);
              }}
              title={t("ai_browser_full")}
              type="button"
            >
              <Maximize2 aria-hidden="true" className="size-3.5" />
            </button>
          ) : (
            <span className="shrink-0 rounded-full bg-surface-2/80 px-2 py-0.5 text-xs leading-none text-ink-3">
              {t("ai_browser_tab_bg")}
            </span>
          )}
        </div>
        {leadActive ? (
          <button
            aria-label={t("ai_browser_full")}
            className="relative block w-full cursor-zoom-in"
            onClick={() => setFull(true)}
            type="button"
          >
            <img
              alt={activeView.title || activeView.url}
              className="w-full object-contain object-top"
              src={`data:image/jpeg;base64,${activeView.img}`}
              style={{ aspectRatio: `${activeView.w || VIEWPORT_W} / ${activeView.h || VIEWPORT_H}` }}
            />
            <ModelPointer view={activeView} />
          </button>
        ) : (
          <div className="relative">
            <img
              alt={activeView.title || activeView.url}
              className="w-full object-contain object-top opacity-90"
              src={`data:image/jpeg;base64,${activeView.img}`}
              style={{ aspectRatio: `${activeView.w || VIEWPORT_W} / ${activeView.h || VIEWPORT_H}` }}
            />
            <ModelPointer view={activeView} />
          </div>
        )}
      </div>
      {waiting
        ? createPortal(
            <div className="fixed inset-x-4 bottom-4 z-40 flex justify-center lg:hidden">
              <button
                className="flex w-full max-w-md items-center gap-2.5 rounded-2xl border border-accent-strong/40 bg-surface px-4 py-3 text-start shadow-card transition-colors hover:border-accent"
                onClick={() => setFull(true)}
                type="button"
              >
                <LivePulse />
                <span className="min-w-0 flex-1 leading-snug">
                  <span className="block text-[13px] font-medium text-ink">{t("ai_browser_wait_bar")}</span>
                  <span className="block truncate text-xs text-ink-3">{view.title || hostnameOf(view.url)}</span>
                </span>
                <span className="shrink-0 rounded-full bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-contrast">
                  {t("ai_browser_open")}
                </span>
              </button>
            </div>,
            document.body,
          )
        : null}
      {full ? (
        // the takeover opens from the LEAD's affordances only, but stays
        // open across the session tabs (a background tab inside it is the
        // read-only snapshot view)
        <BrowserLightbox
          onClose={() => {
            setFull(false);
          }}
          onTab={setTab}
          sessions={sessions}
          tab={tab}
          view={activeView}
        />
      ) : null}
    </section>
  );
}
