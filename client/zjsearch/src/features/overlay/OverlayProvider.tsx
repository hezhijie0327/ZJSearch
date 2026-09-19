// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Slide-in overlay panel: About / Stats / Preferences open as a right-side
 * drawer on top of the current page (URL unchanged, search state kept).
 * The panel fetches the target URL; which page component renders which
 * payload is decided by the `renderPage` callback the app injects — this
 * module only knows the panel chrome and the data plumbing, never the
 * pages themselves.
 */

import { X } from "lucide-react";
import { createContext, type ReactNode, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { fetchText } from "@/lib/http.ts";
import { useT } from "@/lib/i18n.ts";
import { isModifiedClick } from "@/lib/link.ts";
import { extractPageData } from "@/lib/pageData.ts";
import { ICON_BTN } from "@/lib/styles.ts";
import type { AnyPageData } from "@/lib/types.ts";

/** Panels the app can render inside the drawer. Returning null means "this
    payload is not panel-able" and shows the fallback with an escape link. */
interface OverlayPanels {
  renderPage: (data: AnyPageData, hint?: string) => ReactNode;
}

interface OverlayState {
  url: string;
  title: string;
  /** "document" panels fetch plain text (LICENSE.txt); "page" panels fetch page-data */
  mode: "page" | "document";
  data: AnyPageData | null;
  text: string | null;
  loading: boolean;
  error: string | null;
  /** free-form render hint forwarded to renderPage (e.g. the info tab to open) */
  hint?: string;
}

interface OverlayContextValue {
  openOverlay: (url: string, title: string, hint?: string) => void;
  /** open a plain-text document (LICENSE.txt ...) rendered inside the panel */
  openDocument: (title: string, url: string) => void;
  closeOverlay: () => void;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

export function useOverlay(): OverlayContextValue {
  const ctx = useContext(OverlayContext);
  if (!ctx) {
    throw new Error("useOverlay outside of OverlayProvider");
  }
  return ctx;
}

export function OverlayProvider({ panels, children }: { panels: OverlayPanels; children: ReactNode }) {
  const t = useT();
  const [state, setState] = useState<OverlayState | null>(null);
  // the drawer element is rendered by this always-mounted provider: pass the
  // open flag so the focus effect runs when the dialog actually appears
  const dialogRef = useDialogFocus<HTMLDivElement>(state !== null);

  const closeOverlay = useCallback(() => {
    setState(null);
  }, []);

  const openOverlay = useCallback((url: string, title: string, hint?: string) => {
    setState({ url, title, mode: "page", data: null, text: null, loading: true, error: null, hint });
  }, []);

  const openDocument = useCallback((title: string, url: string) => {
    setState({ url, title, mode: "document", data: null, text: null, loading: true, error: null });
  }, []);

  // navigate the panel to another URL, keeping it open
  const openPanel = useCallback((url: string, title: string) => {
    setState((prev) => ({
      url,
      title: title || prev?.title || "",
      mode: "page",
      data: null,
      text: null,
      loading: true,
      error: null,
    }));
  }, []);

  // fetch the payload when a panel is requested
  useEffect(() => {
    if (!state?.loading) {
      return;
    }
    const controller = new AbortController();
    const isDocument = state.mode === "document";
    void fetchText(state.url, {
      headers: { Accept: isDocument ? "text/plain" : "text/html" },
      signal: controller.signal,
    })
      .then(async (body) => {
        if (isDocument) {
          setState((prev) => (prev && prev.url === state.url ? { ...prev, text: body, loading: false } : prev));
          return;
        }
        const data = extractPageData(body);
        setState((prev) => (prev && prev.url === state.url ? { ...prev, data, loading: false } : prev));
      })
      .catch((err) => {
        if (controller.signal.aborted) {
          return;
        }
        // not an app page (e.g. a static file) — fall back to a full load
        if (!isDocument && String(err).includes("page-data missing")) {
          window.location.assign(state.url);
          return;
        }
        setState((prev) => (prev && prev.url === state.url ? { ...prev, loading: false, error: String(err) } : prev));
      });
    return () => {
      controller.abort();
    };
  }, [state]);

  const onKeyDown = useCallback((event: globalThis.KeyboardEvent) => {
    if (event.key === "Escape") {
      setState(null);
    }
  }, []);

  useEffect(() => {
    if (!state) {
      return;
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [state, onKeyDown]);

  // stable context value: the callbacks are useCallback'd, and without the
  // useMemo every open/close would re-render every useOverlay() consumer
  // (Shell header actions, footer, DebugPanels) even while idle
  const contextValue = useMemo(
    () => ({ openOverlay, openDocument, closeOverlay }),
    [openOverlay, openDocument, closeOverlay],
  );

  return (
    <OverlayContext.Provider value={contextValue}>
      {children}
      {state ? (
        <div
          aria-label={state.title}
          aria-modal="true"
          className="fixed inset-0 z-50"
          ref={dialogRef}
          role="dialog"
          tabIndex={-1}
        >
          <button
            aria-label={t("close")}
            className="absolute inset-0 cursor-default bg-black/60 animate-fade-in"
            onClick={closeOverlay}
            type="button"
          />
          {/* data-zjs-overlay-panel: flashToast hosts floating feedback here
              so pills center in the drawer instead of the viewport (the
              entrance animation's residual transform contains `fixed`) */}
          <div
            className="absolute inset-y-0 end-0 flex w-full max-w-3xl flex-col bg-bg shadow-pop animate-slide-in-right"
            data-zjs-overlay-panel=""
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 className="text-lg font-semibold text-ink">{state.title}</h2>
              <button
                aria-label={t("close")}
                className={ICON_BTN}
                data-dialog-close=""
                onClick={closeOverlay}
                type="button"
              >
                <X className="size-4.5" />
              </button>
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto pt-4"
              onClickCapture={(event) => {
                const anchor = (event.target as HTMLElement).closest("a");
                const href = anchor?.getAttribute("href");
                if (
                  !anchor ||
                  !href?.startsWith("/") ||
                  anchor.target === "_blank" ||
                  anchor.hasAttribute("download") ||
                  // /static/ holds files (LICENSE.txt...), not SPA pages
                  href.startsWith("/static/") ||
                  isModifiedClick(event)
                ) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                openPanel(href, state?.title ?? "");
              }}
            >
              {state.loading ? (
                <PanelSkeleton />
              ) : state.error ? (
                <p className="p-6 text-sm text-danger">{state.error}</p>
              ) : state.mode === "document" ? (
                <article className="px-5 pb-8">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-2">
                    {state.text}
                  </pre>
                </article>
              ) : state.data ? (
                <Suspense fallback={<PanelSkeleton />}>
                  {panels.renderPage(state.data, state.hint) ?? <PanelFallback data={state.data} />}
                </Suspense>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </OverlayContext.Provider>
  );
}

const PanelSkeleton = () => (
  <div aria-busy="true" className="space-y-3 p-6">
    {Array.from({ length: 6 }, (_, i) => (
      <div className="zjs-skeleton h-12" key={i} />
    ))}
  </div>
);

function PanelFallback({ data }: { data: AnyPageData }) {
  const t = useT();
  return (
    <p className="p-6 text-sm text-ink-2">
      {t("panel_unavailable")}{" "}
      <a className="text-accent" href={data.globals.about_url || "/"}>
        {t("open_here")}
      </a>
      .
    </p>
  );
}
