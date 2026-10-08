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

import { Check, ExternalLink, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AiSearchRun } from "@/features/results/aiSearch/timeline.ts";
import { postBrowserInput } from "@/lib/browserInput.ts";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { useT } from "@/lib/i18n.ts";
import { ICON_BTN } from "@/lib/styles.ts";

type MirrorView = NonNullable<AiSearchRun["browser"]>;

const VIEWPORT_W = 1280;
const VIEWPORT_H = 800;

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

/** The session page's host (the card header's second slot). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
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

/** The takeover: the live page at full size, the user's clicks/wheel/keys
    forwarded to the session.  Mobile-safe: the stage keeps the frame
    contain-fit, the keyboard bar wraps its two actions. */
export function BrowserLightbox({ onClose, view }: { onClose: () => void; view: MirrorView }) {
  const t = useT();
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const [draft, setDraft] = useState("");
  const wheelLock = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);

  // React's synthetic onWheel is passive -- the takeover must STOP the
  // page behind the fixed overlay from scrolling, so the wheel listener
  // attaches natively (non-passive) once
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const now = Date.now();
      if (now - wheelLock.current < 250) {
        return;
      }
      wheelLock.current = now;
      void postBrowserInput({ type: "wheel", deltaY: event.deltaY > 0 ? 600 : -600 });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const send = (payload: Parameters<typeof postBrowserInput>[0]) => {
    void postBrowserInput(payload);
  };

  // DIRECT TYPING: with the takeover focused, every key lands on the
  // session's page (latin keys as keypresses; the text bar below stays
  // for IME/Chinese composition, which cannot forward key-by-key).
  // Interactive targets are EXEMPT -- their keys stay client-side, or a
  // keyboard user could never activate the close/done buttons (and Tab
  // must keep traversing the dialog's own controls).
  const onDialogKeyDown = (event: React.KeyboardEvent) => {
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
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80 p-2 backdrop-blur-sm sm:p-6">
      <div aria-hidden="true" className="absolute inset-0 animate-fade-in bg-black/70" onClick={onClose} />
      <div
        aria-label={t("ai_browser_live")}
        aria-modal
        className="relative z-10 mx-auto flex h-full w-full max-w-5xl animate-fade-up flex-col rounded-2xl border border-line bg-surface p-2 shadow-card outline-none sm:p-4"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex min-h-9 items-center gap-2 pb-2">
          <LivePulse />
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2" title={view.url}>
            {view.title || view.url}
          </span>
          <a
            aria-label={t("open_source")}
            className="hidden shrink-0 text-ink-3 transition-colors hover:text-accent sm:block"
            href={view.url}
            rel="noreferrer"
            target="_blank"
            title={view.url}
          >
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
          {view.waitLeft !== undefined ? (
            <span className="shrink-0 font-mono text-xs tabular-nums text-ink-3" title={t("ai_browser_wait_hint")}>
              {t("ai_browser_wait", { s: String(view.waitLeft) })}
            </span>
          ) : null}
          <button aria-label={t("ai_browser_close")} className={ICON_BTN} onClick={onClose} type="button">
            <Minimize2 aria-hidden="true" className="size-4" />
          </button>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the takeover stage -- clicks forward as viewport coordinates; keyboard users type via the bar or direct typing */}
        <div
          className="flex min-h-0 flex-1 cursor-crosshair items-center justify-center overflow-hidden rounded-xl border border-line bg-ink/5"
          onClick={(event) => {
            const target = event.currentTarget;
            if (event.target === target) {
              const { x, y } = frameCoords({ ...event, currentTarget: target });
              send({ type: "click", x, y });
            }
            dialogRef.current?.focus();
          }}
          ref={stageRef}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the frame
              IS the interaction surface -- the click forwards as a viewport
              coordinate; keyboard users use the bar below */}
          <img
            alt={view.title || view.url}
            className="max-h-full w-auto max-w-full cursor-crosshair"
            onClick={(event) => {
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
            src={`data:image/jpeg;base64,${view.img}`}
          />
        </div>
        {/* the keyboard bar: click a field in the page, type here, Enter
            sends to the session; Done hands the page back to the model */}
        <div className="mt-2 flex items-center gap-1.5">
          <form
            className="flex min-w-0 flex-1 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim()) {
                send({ type: "type", text: draft });
                setDraft("");
              }
            }}
          >
            <input
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("ai_browser_type_hint")}
              value={draft}
            />
            <button
              aria-label={t("ai_browser_kb_esc")}
              className="min-h-9 shrink-0 rounded-lg border border-line px-2.5 text-[13px] text-ink-2 transition-colors hover:border-accent hover:text-accent"
              onClick={() => {
                send({ type: "key", key: "Escape" });
              }}
              title={t("ai_browser_kb_esc")}
              type="button"
            >
              Esc
            </button>
          </form>
          <div className="h-5 w-px shrink-0 bg-line" />
          <button
            className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong"
            onClick={finishAndClose}
            title={t("ai_browser_done_hint")}
            type="button"
          >
            <Check aria-hidden="true" className="size-4" />
            {t("ai_browser_done")}
          </button>
        </div>
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
        {multi ? (
          <div className="flex items-center gap-1 overflow-x-auto border-b border-line bg-surface px-1.5 py-1">
            {entries.map(([sid, item]) => {
              const active = sid === tab;
              const isLead = sid === "lead";
              return (
                <button
                  aria-label={item.title || sid}
                  className={`flex min-w-0 max-w-40 shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    active
                      ? "border-accent-strong/50 bg-accent-soft font-medium text-accent"
                      : "border-line text-ink-3 hover:text-ink-2"
                  }`}
                  key={sid}
                  onClick={() => {
                    setTab(sid);
                  }}
                  type="button"
                >
                  <span className="truncate">{isLead ? t("ai_browser_tab_lead") : hostOf(item.url)}</span>
                  {!active ? <span className="shrink-0 text-[11px] opacity-70">{t("ai_browser_tab_bg")}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="flex min-w-0 items-center gap-1.5 border-b border-line bg-surface px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-ink-2" title={activeView.url}>
            {activeView.title || activeView.url}
          </span>
          <span className="hidden shrink-0 font-mono text-[11px] text-ink-3 sm:inline">{hostOf(activeView.url)}</span>
        </div>
        {leadActive ? (
          <button
            aria-label={t("ai_browser_full")}
            className="block w-full cursor-zoom-in"
            onClick={() => setFull(true)}
            type="button"
          >
            <img
              alt={activeView.title || activeView.url}
              className="w-full object-contain object-top"
              src={`data:image/jpeg;base64,${activeView.img}`}
              style={{ aspectRatio: `${activeView.w || VIEWPORT_W} / ${activeView.h || VIEWPORT_H}` }}
            />
          </button>
        ) : (
          <img
            alt={activeView.title || activeView.url}
            className="w-full object-contain object-top opacity-90"
            src={`data:image/jpeg;base64,${activeView.img}`}
            style={{ aspectRatio: `${activeView.w || VIEWPORT_W} / ${activeView.h || VIEWPORT_H}` }}
          />
        )}
      </div>
      <p className="mt-2 px-1 text-xs leading-relaxed text-ink-3">{t("ai_browser_hint")}</p>
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
                  <span className="block truncate text-xs text-ink-3">{view.title || hostOf(view.url)}</span>
                </span>
                <span className="shrink-0 rounded-full bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-contrast">
                  {t("ai_browser_open")}
                </span>
              </button>
            </div>,
            document.body,
          )
        : null}
      {full && leadActive ? <BrowserLightbox onClose={() => setFull(false)} view={activeView} /> : null}
    </section>
  );
}
