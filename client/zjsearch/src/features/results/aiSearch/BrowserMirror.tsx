// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The interactive browser session's mirror: the rail's transient card
    (live frames while a ``web_browser`` call is pending) plus the
    Lightbox takeover (the user's clicks/wheel/keys forwarded to the
    session's page).  The frames ride the run's ``browser`` wire events;
    the bytes never persist. */

import { AppWindow, Check, Minimize2 } from "lucide-react";
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

function LiveFrame({ onOpen, view }: { onOpen: () => void; view: MirrorView }) {
  const t = useT();
  return (
    <button
      aria-label={t("ai_browser_full")}
      className="block w-full cursor-zoom-in overflow-hidden rounded-xl border border-line bg-ink/5"
      onClick={onOpen}
      type="button"
    >
      <img
        alt={view.title || view.url}
        className="aspect-[16/10] w-full object-contain object-top"
        src={`data:image/jpeg;base64,${view.img}`}
      />
    </button>
  );
}

/** The rail's transient section: pinned FIRST while a session is live. */
export function BrowserMirrorSection({ view }: { view: MirrorView }) {
  const t = useT();
  const [full, setFull] = useState(false);
  return (
    <section aria-label={t("ai_browser_live")} className="mb-5">
      <div className="flex items-center gap-2 px-1">
        <span className="relative flex size-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex size-2.5 rounded-full bg-accent" />
        </span>
        <h3 className="text-base font-semibold text-ink">{t("ai_browser_live")}</h3>
        {view.waitLeft !== undefined ? (
          <span className="shrink-0 text-xs tabular-nums text-ink-3">
            {t("ai_browser_wait").replace("{s}", String(view.waitLeft))}
          </span>
        ) : null}
      </div>
      <div className="mt-3">
        <LiveFrame onOpen={() => setFull(true)} view={view} />
        <p className="mt-2 px-1 text-xs leading-relaxed text-ink-3">{t("ai_browser_hint")}</p>
      </div>
      {full ? <BrowserLightbox onClose={() => setFull(false)} view={view} /> : null}
    </section>
  );
}

/** The takeover: the live page at full size, the user's clicks/wheel/keys
    forwarded to the session. */
function BrowserLightbox({ onClose, view }: { onClose: () => void; view: MirrorView }) {
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
  // for IME/Chinese composition, which cannot forward key-by-key)
  const onDialogKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      return; // the keyboard bar's own field composes locally
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return; // client-side shortcuts stay client-side
    }
    if (event.key.length === 1) {
      event.preventDefault();
      send({ type: "type", text: event.key });
    } else if (
      ["Enter", "Backspace", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"].includes(event.key)
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
    <div
      aria-modal
      className="fixed inset-0 z-50 flex flex-col bg-black/80 p-3 outline-none backdrop-blur-sm sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      onKeyDown={onDialogKeyDown}
      role="dialog"
    >
      <div
        className="mx-auto flex h-full w-full max-w-5xl flex-col rounded-2xl border border-line bg-surface p-3 shadow-card outline-none sm:p-4"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="flex min-h-9 items-center gap-2 pb-2">
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-accent" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2" title={view.url}>
            {view.title || view.url}
          </span>
          {view.waitLeft !== undefined ? (
            <span className="shrink-0 font-mono text-xs tabular-nums text-ink-3" title={t("ai_browser_wait_hint")}>
              {t("ai_browser_wait").replace("{s}", String(view.waitLeft))}
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
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-[13px] text-ink placeholder:text-ink-3"
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("ai_browser_type_hint")}
              value={draft}
            />
            <button
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

/** The rail section's own AppWindow export (the header icon). */
export { AppWindow as BrowserMirrorIcon };
