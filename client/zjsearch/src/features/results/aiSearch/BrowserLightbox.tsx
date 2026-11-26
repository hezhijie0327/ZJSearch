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

import { ArrowLeft, ArrowRight, Check, ExternalLink, Keyboard, Minimize2, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ActionMark,
  addressOf,
  FramePlaceholder,
  LivePulse,
  SessionTabs,
  VIEWPORT_H,
  VIEWPORT_W,
} from "@/features/results/aiSearch/mirrorParts.tsx";
import type { AiSearchRun } from "@/features/results/aiSearch/runModel.ts";
import { postBrowserInput } from "@/lib/browserInput.ts";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { useT } from "@/lib/i18n.ts";
import { ICON_BTN } from "@/lib/styles.ts";

type MirrorView = NonNullable<AiSearchRun["browser"]>;

// The session viewport's LAUNCH dimensions (engine WINDOW) ride the ai
// capability at boot (browserInput.sessionViewport) -- the fallback for
// frames that carry no w/h; live coordinates always map through the
// frame's own capture dimensions.  NO local constant: a drifted one is
// exactly the 1.5x-click bug this replaced.

/** The takeover: the live page at full size, the user's clicks/wheel/keys
    forwarded to the session.  Mobile-safe: the stage keeps the frame
    contain-fit, the keyboard bar wraps its two actions.  The session tabs
    ride along (switch context without leaving the takeover), but a
    BACKGROUND tab is a READ-ONLY snapshot there: the input channel is
    bound to the lead's serialized session, so forwarding a click onto a
    frozen frame would operate a page the frame does not show. */
/** Map a click on the DISPLAYED frame to the session's viewport space.
    The space comes from the FRAME's own capture dimensions -- the
    viewport is whatever the session launched with, never a constant. */
function frameCoords(
  event: {
    clientX: number;
    clientY: number;
    currentTarget: { getBoundingClientRect(): DOMRect };
  },
  spaceW?: number,
  spaceH?: number,
): { x: number; y: number } {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.round(((event.clientX - rect.left) / rect.width) * (spaceW || VIEWPORT_W())),
    y: Math.round(((event.clientY - rect.top) / rect.height) * (spaceH || VIEWPORT_H())),
  };
}

export function BrowserLightbox({
  onClose,
  sessions,
  tab,
  onTab,
  view,
  initialOverride,
}: {
  onClose: () => void;
  sessions?: Record<string, MirrorView>;
  tab: string;
  onTab: (id: string) => void;
  view: MirrorView;
  /** the card's peek frame -- enlarging while a strip peek is up must
      open on THAT tab's frame, not the last wire frame. */
  initialOverride?: MirrorView | null;
}) {
  const t = useT();
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const [draft, setDraft] = useState("");
  const wheelLock = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // the takeover's DRAG gesture: pointerdown stores the viewport-space
  // start, move updates the trail, up lands the slide (>=8px move; a
  // smaller gesture stays a tap).  The endpoint click is suppressed --
  // the pointerup's synthetic click must not also fire a tap.
  const dragStartRef = useRef<{ x1: number; y1: number } | null>(null);
  const [dragTrail, setDragTrail] = useState<{ x1: number; y1: number; x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
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
  const [override, setOverride] = useState<MirrorView | null>(initialOverride ?? null);
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
      // the gesture's own axis rides: a pure horizontal wheel (shift+wheel,
      // sideways trackpad swipe, carousels) maps to deltaX -- mapping it
      // to a vertical -600 scrolled the page the wrong way
      if (event.deltaY === 0) {
        if (event.deltaX !== 0) {
          sendRef.current({ type: "wheel", deltaX: event.deltaX > 0 ? 600 : -600, deltaY: 0 });
        }
        return;
      }
      sendRef.current({
        type: "wheel",
        deltaX: 0,
        deltaY: event.deltaY > 0 ? 600 : -600,
      });
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
        className="relative z-10 mx-auto my-auto flex h-auto w-full max-w-5xl animate-fade-up flex-col overflow-y-auto rounded-2xl border border-line bg-surface p-2 shadow-card outline-none sm:p-4 sm:max-h-[calc(100vh-3rem)]"
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
              const { x, y } = frameCoords({ ...event, currentTarget: target }, shown.w, shown.h);
              send({ type: "click", x, y });
            }
            dialogRef.current?.focus();
          }}
          ref={stageRef}
        >
          <div
            className="relative w-full overflow-hidden rounded-lg"
            style={{ aspectRatio: `${shown.w || VIEWPORT_W()} / ${shown.h || VIEWPORT_H()}` }}
          >
            {shown.img ? (
              <img
                alt={shown.title || shown.url}
                className={`h-full w-full touch-none object-contain ${isLead ? "cursor-crosshair" : ""}`}
                onClick={(event) => {
                  if (!isLead) {
                    return;
                  }
                  if (suppressClickRef.current) {
                    // a drag just landed -- the pointerup's synthetic click
                    // must not also fire a tap at the endpoint
                    suppressClickRef.current = false;
                    return;
                  }
                  event.stopPropagation();
                  const { x, y } = frameCoords(event, shown.w, shown.h);
                  send({ type: "click", x, y });
                  // clicking a non-focusable element blurs the takeover -- pull
                  // focus back so direct typing keeps flowing
                  dialogRef.current?.focus();
                }}
                onPointerDown={(event) => {
                  if (!isLead || event.button !== 0) {
                    return;
                  }
                  const { x, y } = frameCoords(event, shown.w, shown.h);
                  dragStartRef.current = { x1: x, y1: y };
                  setDragTrail({ x1: x, y1: y, x, y });
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (!dragStartRef.current) {
                    return;
                  }
                  const { x, y } = frameCoords(event, shown.w, shown.h);
                  setDragTrail({ x1: dragStartRef.current.x1, y1: dragStartRef.current.y1, x, y });
                }}
                onPointerUp={(event) => {
                  const start = dragStartRef.current;
                  dragStartRef.current = null;
                  setDragTrail(null);
                  if (!start || !isLead) {
                    return;
                  }
                  const { x, y } = frameCoords(event, shown.w, shown.h);
                  if (Math.abs(x - start.x1) + Math.abs(y - start.y1) < 8) {
                    return; // a tap -- the click handler owns it
                  }
                  suppressClickRef.current = true;
                  send({ type: "drag", x1: start.x1, y1: start.y1, x2: x, y2: y });
                }}
                role="presentation"
                src={`data:image/jpeg;base64,${shown.img}`}
              />
            ) : (
              <FramePlaceholder className="h-full w-full" view={shown} />
            )}
            {dragTrail ? (
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-10 h-full w-full"
                preserveAspectRatio="none"
                viewBox={`0 0 ${shown.w || VIEWPORT_W()} ${shown.h || VIEWPORT_H()}`}
              >
                <line
                  className="text-accent"
                  stroke="currentColor"
                  strokeDasharray="10 8"
                  strokeWidth={4}
                  x1={dragTrail.x1}
                  x2={dragTrail.x}
                  y1={dragTrail.y1}
                  y2={dragTrail.y}
                />
                <circle className="fill-accent" cx={dragTrail.x1} cy={dragTrail.y1} r={7} />
                <circle className="fill-accent" cx={dragTrail.x} cy={dragTrail.y} r={7} />
              </svg>
            ) : null}
            <ActionMark view={shown} />
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
