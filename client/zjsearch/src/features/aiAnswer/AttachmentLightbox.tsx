// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
// The body-figure lightbox (bitmaps / inline SVG charts, the ZJBlog family
// mechanism): a native <dialog> top layer -- Esc closes natively and focus
// is trapped inside while modal.  Fixed-size stage (does not follow the
// content or the zoom), content centered with object-contain; 0.5x-5x zoom
// (wheel / +- keys / buttons, double-click or 0 resets), drag-to-pan while
// zoomed; backplate click closes.  Zero dependencies.
// SVG items (mermaid chart cards) MUST be inline-cloned, not <img src>:
// mermaid flowcharts default to htmlLabels with node text living in
// <foreignObject>, and SVG-as-image secure static mode does not render
// foreignObject -- the image would be bare boxes and arrows.  Inline SVG
// zooms as vectors.

import { ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { useT } from "@/lib/i18n.ts";
import { ICON_BTN } from "@/lib/styles.ts";
import { useZoomPan, ZOOM_MAX, ZOOM_MIN } from "@/lib/zoomPan.ts";

export type LightboxItem =
  | { alt: string; kind: "img"; src: string }
  // html is the trusted SVG serialized at click time (a mermaid
  // securityLevel product, same origin as the body injection); the inline
  // max-width (natural size) is kept -- small figures never upscale
  | { alt: string; html: string; kind: "svg" };

export function Lightbox({
  items,
  initialIndex,
  onClose,
}: {
  items: LightboxItem[];
  initialIndex: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(initialIndex);
  const t = useT();
  const item = items[index];
  const { contentProps, pct, resetZoom, stageRef, zoom, zoomBy, zoomed } = useZoomPan();

  // Modal on mount; every close path funnels through the native close()
  // (Esc does naturally), the parent syncs state off the close event --
  // close the dialog FIRST (releases the top layer, focus can move out),
  // then unmount the component; unmounting while focused would yank focus
  // back to body, never returning it to the trigger image.
  // Guard open: re-running the effect under HMR/remount on an already-open
  // dialog makes showModal throw.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    dialog.addEventListener("close", onClose);
    return () => dialog.removeEventListener("close", onClose);
  }, [onClose]);

  const step = (delta: number) => {
    setIndex((current) => (current + delta + items.length) % items.length);
    resetZoom();
  };

  /** Close the panel (backplate / close button): hand off to the native
      close(); the close event drives the parent's unmount. */
  const close = () => dialogRef.current?.close();

  const onDialogClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.clientX === 0 && event.clientY === 0) {
      return;
    }
    const rect = dialogRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      close();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "ArrowLeft" || event.key === "-") {
      event.preventDefault();
      if (event.key === "ArrowLeft" && items.length > 1) {
        step(-1);
      } else if (event.key === "-") {
        zoomBy(-1);
      }
      return;
    }
    if (event.key === "ArrowRight" || event.key === "+" || event.key === "=") {
      event.preventDefault();
      if (event.key === "ArrowRight" && items.length > 1) {
        step(1);
      } else {
        zoomBy(1);
      }
      return;
    }
    if (event.key === "0") {
      resetZoom();
    }
  };

  if (!item) {
    return null;
  }

  return (
    <dialog
      {...(item.alt ? { "aria-label": item.alt } : {})}
      className={cn(
        "rounded-2xl border border-line bg-surface shadow-card",
        "lightbox fixed inset-0 m-auto flex h-[min(92dvh,44rem)] w-[min(94vw,56rem)] flex-col p-4 sm:p-5",
      )}
      onClick={onDialogClick}
      onKeyDown={onKeyDown}
      ref={dialogRef}
    >
      {/* Toolbar: counter + zoom controls + close */}
      <div className="flex min-h-9 items-center justify-end gap-2 pb-2">
        {items.length > 1 && (
          <span className="me-auto font-mono text-xs text-ink-3">
            {index + 1} / {items.length}
          </span>
        )}
        <button
          aria-label={t("lightbox.zoomOut")}
          className={ICON_BTN}
          disabled={zoom <= ZOOM_MIN}
          onClick={() => zoomBy(-1)}
          type="button"
        >
          <Minus aria-hidden="true" className="size-4.5" />
        </button>
        {/* Click the percentage to reset to 100% */}
        <button
          className="min-h-6 min-w-12 rounded px-2 font-mono text-xs text-ink-2 transition-colors hover:text-ink"
          onClick={resetZoom}
          type="button"
        >
          {pct}%
        </button>
        <button
          aria-label={t("lightbox.zoomIn")}
          className={ICON_BTN}
          disabled={zoom >= ZOOM_MAX}
          onClick={() => zoomBy(1)}
          type="button"
        >
          <Plus aria-hidden="true" className="size-4.5" />
        </button>
        <button aria-label={t("lightbox.close")} className={ICON_BTN} onClick={close} type="button">
          <X aria-hidden="true" className="size-4.5" />
        </button>
      </div>

      {/* Stage: fixed size, content centered with object-contain; zoom/pan
          ride transform and never touch layout -- the box never changes
          with content size or zoom level */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden" ref={stageRef}>
        <div
          className={cn("flex items-center justify-center", item.kind === "svg" && "w-full", zoomed && "touch-none")}
          {...contentProps}
        >
          {item.kind === "img" ? (
            <img
              alt={item.alt}
              className="max-h-[64dvh] max-w-[min(86vw,52rem)] select-none object-contain"
              draggable={false}
              src={item.src}
            />
          ) : (
            // Full width chain (fixed-width stage → wrapper w-full) gives the
            // svg's percentage width a definite base; mermaid's inline
            // max-width keeps the natural-size cap, overflow letterboxes
            // centered via preserveAspectRatio, over-tall heights clip at
            // max-height
            <div
              aria-hidden="true"
              className="w-full max-w-[min(86vw,52rem)] select-none [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-h-[64dvh] [&_svg]:w-full"
              dangerouslySetInnerHTML={{ __html: item.html }}
            />
          )}
        </div>
        {items.length > 1 && (
          <>
            <button
              aria-label={t("lightbox.prev")}
              className={cn(ICON_BTN, "absolute left-2 top-1/2 size-10 -translate-y-1/2 bg-bg/90 shadow-card")}
              onClick={() => {
                step(-1);
              }}
              type="button"
            >
              <ChevronLeft aria-hidden="true" className="size-5" />
            </button>
            <button
              aria-label={t("lightbox.next")}
              className={cn(ICON_BTN, "absolute right-2 top-1/2 size-10 -translate-y-1/2 bg-bg/90 shadow-card")}
              onClick={() => {
                step(1);
              }}
              type="button"
            >
              <ChevronRight aria-hidden="true" className="size-5" />
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
