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

import { Check, Maximize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrowserLightbox } from "@/features/results/aiSearch/BrowserLightbox.tsx";
import {
  ActionMark,
  addressOf,
  FramePlaceholder,
  LivePulse,
  type MirrorView,
  SessionTabs,
  VIEWPORT_H,
  VIEWPORT_W,
} from "@/features/results/aiSearch/mirrorParts.tsx";
import { RailHeader } from "@/features/results/aiSearch/rail/RailSection.tsx";
import { postBrowserInput } from "@/lib/browserInput.ts";
import { useT } from "@/lib/i18n.ts";
import { hostnameOf } from "@/lib/link.ts";
import { SCROLLBAR_NONE } from "@/lib/styles.ts";

// The session viewport's LAUNCH dimensions (engine WINDOW) ride the ai
// capability at boot (browserInput.sessionViewport) -- the fallback for
// frames that carry no w/h; live coordinates always map through the
// frame's own capture dimensions.  NO local constant: a drifted one is
// exactly the 1.5x-click bug this replaced.

/** The rail's transient section: pinned FIRST while a session is live.
    A wait_user window auto-opens the takeover ONCE per window (the run
    blocks on the user); minimizing keeps it closed until the next
    window.  Also renders the MOBILE wait bar (fixed bottom pill, below
    lg) so the same window stays reachable from anywhere on the page.
    R3B: with PARALLEL SESSIONS (the lead + delegating subagents) the
    card grows a tab strip -- the ACTIVE tab streams, the background
    tabs freeze on their last frame with the background badge (bandwidth
    economy); the takeover stays the LEAD tab's surface (its wait_user
    is what blocks on the human). */
export function BrowserMirrorSection({ view, sessions }: { view: MirrorView; sessions?: Record<string, MirrorView> }) {
  const t = useT();
  const [tab, setTab] = useState("lead");
  const [full, setFull] = useState(false);
  // the IN-SESSION tab peek: the viewer's manual look at a page the
  // model parked -- one captured frame overlaid locally, superseded by
  // the model's next wire frame (the fold replaces run.browser)
  const [peek, setPeek] = useState<MirrorView | null>(null);
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
  // any wire frame supersedes the peek (the fold replaces the view) --
  // activeView is the TRIGGER (a new object identity per frame), not a read
  // biome-ignore lint/correctness/useExhaustiveDependencies: the derived view's identity IS the change signal
  useEffect(() => {
    setPeek(null);
  }, [activeView]);
  const sessionTabs = leadActive ? (activeView.tabs ?? []) : [];
  const shown = peek ?? activeView;
  const peekTo = (index: number) => {
    void postBrowserInput({ type: "peek", index })
      .then((frame) => {
        if (frame) {
          setPeek({ ...activeView, ...frame, tabs: activeView.tabs });
        }
      })
      .catch(() => {
        // a cold engine's first peek can outlive the fetch budget (the
        // launch runs on) -- the strip stays live, a second click succeeds
      });
  };
  return (
    <section aria-label={t("ai_browser_live")} className="mb-5">
      <RailHeader
        icon={LivePulse}
        title={t("ai_browser_live")}
        trailing={
          waiting ? (
            <>
              <span className="shrink-0 font-mono text-xs tabular-nums text-ink-3" title={t("ai_browser_wait_hint")}>
                {t("ai_browser_wait", { s: String(view.waitLeft) })}
              </span>
              {/* the operation window's DONE affordance at the card level:
                the takeover holds the primary button, but the takeover is
                minimizable -- a viewer who closed it must not wait out the
                countdown to tell the model the page is ready */}
              <button
                className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded-full bg-accent-strong px-2.5 py-0.5 text-xs font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
                onClick={() => {
                  void postBrowserInput({ type: "done" });
                }}
                title={t("ai_browser_done_hint")}
                type="button"
              >
                <Check aria-hidden="true" className="size-3" />
                {t("ai_browser_done")}
              </button>
            </>
          ) : null
        }
      />
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
        {leadActive && sessionTabs.length > 1 ? (
          // the IN-SESSION tab strip: the pages the MODEL holds -- the
          // viewer may peek a parked one (a captured frame overlaid
          // locally); the model's next frame returns the card to live
          <div
            className={`flex items-center gap-1 overflow-x-auto border-b border-line bg-surface-2/40 px-1.5 py-1 ${SCROLLBAR_NONE}`}
          >
            {sessionTabs.map((t2) => {
              const peeking = peek !== null && peek.url === t2.url;
              const chipActive = peeking || (t2.active && peek === null);
              return (
                <span
                  className={`inline-flex min-w-0 max-w-44 shrink-0 items-center gap-0.5 rounded-md border ps-1.5 text-xs transition-colors ${
                    chipActive
                      ? "border-accent-strong bg-accent-soft font-medium text-accent"
                      : "border-line text-ink-3"
                  }`}
                  key={t2.index}
                >
                  <button
                    aria-pressed={chipActive}
                    className={`flex min-w-0 items-center gap-1 py-0.5 transition-colors ${chipActive ? "" : "hover:text-ink"}`}
                    onClick={() => {
                      if (t2.active) {
                        setPeek(null);
                      } else {
                        peekTo(t2.index);
                      }
                    }}
                    title={t2.title || t2.url}
                    type="button"
                  >
                    <span className="shrink-0 font-mono leading-none">[{t2.index}]</span>
                    <span className="truncate">{t2.title || t2.url}</span>
                  </button>
                  <button
                    aria-label={t("ai_browser_tab_close")}
                    className="shrink-0 rounded p-0.5 transition-colors hover:bg-danger/10 hover:text-danger"
                    onClick={() => {
                      void postBrowserInput({ type: "close_tab", index: t2.index })
                        .then((frame) => {
                          if (frame) {
                            // the fresh frame carries the UPDATED strip --
                            // overlaid like a peek until the next wire
                            // frame supersedes it
                            setPeek({ ...activeView, ...frame, tabs: frame.tabs ?? activeView.tabs });
                          }
                        })
                        .catch(() => {});
                    }}
                    title={t("ai_browser_tab_close")}
                    type="button"
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </span>
              );
            })}
            {peek ? (
              <span className="shrink-0 rounded-md bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-contrast">
                {t("ai_browser_tab_peek")}
              </span>
            ) : null}
          </div>
        ) : null}
        {leadActive ? (
          shown.img ? (
            <button
              aria-label={t("ai_browser_full")}
              className="relative block w-full cursor-zoom-in"
              onClick={() => setFull(true)}
              type="button"
            >
              <img
                alt={shown.title || shown.url}
                className="w-full object-contain object-top"
                src={`data:image/jpeg;base64,${shown.img}`}
                style={{ aspectRatio: `${shown.w || VIEWPORT_W()} / ${shown.h || VIEWPORT_H()}` }}
              />
              <ActionMark view={shown} />
            </button>
          ) : (
            <FramePlaceholder className="w-full" view={shown} />
          )
        ) : (
          <div className="relative">
            {activeView.img ? (
              <img
                alt={activeView.title || activeView.url}
                className="w-full object-contain object-top opacity-90"
                src={`data:image/jpeg;base64,${activeView.img}`}
                style={{ aspectRatio: `${activeView.w || VIEWPORT_W()} / ${activeView.h || VIEWPORT_H()}` }}
              />
            ) : (
              <FramePlaceholder className="w-full opacity-90" view={activeView} />
            )}
            <ActionMark view={activeView} />
          </div>
        )}
      </div>
      {waiting
        ? createPortal(
            <div className="fixed inset-x-4 bottom-4 z-40 flex animate-fade-up justify-center gap-2 lg:hidden">
              <button
                className="flex min-w-0 max-w-md flex-1 items-center gap-2.5 rounded-2xl border border-accent-strong/40 bg-surface px-4 py-3 text-start shadow-card transition-colors hover:border-accent"
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
              {/* the bar's own DONE chip: finishing the window must not
                  require opening the takeover -- the same signal the rail
                  header carries on desktop, one tap from anywhere */}
              <button
                aria-label={t("ai_browser_done_hint")}
                className="flex shrink-0 items-center gap-1.5 self-center rounded-2xl bg-accent px-3.5 py-3 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong"
                onClick={() => {
                  void postBrowserInput({ type: "done" });
                }}
                title={t("ai_browser_done_hint")}
                type="button"
              >
                <Check aria-hidden="true" className="size-4" />
                {t("ai_browser_done")}
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
          initialOverride={peek}
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
