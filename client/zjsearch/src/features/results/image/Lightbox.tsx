// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
import { imageAlt } from "@/lib/format.ts";

/**
 * Kagi-style image lightbox: image centered, top bar with the image details
 * row, prev/next round buttons, bottom bar with actions, keyboard
 * navigation, touch swipe, zoom & drag-pan, and an #image-viewer hash so
 * the back button dismisses it.
 */

import { ChevronLeft, ChevronRight, Download, ExternalLink, ImageOff, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { EnginesLine } from "@/features/results/cardParts.tsx";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { useT } from "@/lib/i18n.ts";
import { hostnameOf, newTabLinkProps } from "@/lib/link.ts";
import { useSettings } from "@/lib/settings.ts";
import type { ResultItem } from "@/lib/types.ts";

/** The viewer is a fixed DARK media overlay in every palette (like photo
    viewers everywhere): tiles-over-image chrome uses its own zinc scale at
    AA contrast instead of the theme tokens. */

const IMAGE_VIEWER_HASH = "#image-viewer";

function ProgressiveImage({ thumbnail, full, alt }: { thumbnail: string; full: string; alt: string }) {
  const [src, setSrc] = useState(thumbnail);
  useEffect(() => {
    setSrc(thumbnail);
    if (!full || full === thumbnail) {
      return;
    }
    const image = new Image();
    const timer = window.setTimeout(() => {
      image.onload = () => {
        setSrc(full);
      };
      image.onerror = () => {
        setSrc(thumbnail);
      };
      image.src = full;
    }, 600);
    return () => {
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
    };
  }, [thumbnail, full]);
  const [failed, setFailed] = useState(!src);
  if (failed) {
    return (
      <div className="flex h-[60vh] w-full items-center justify-center text-zinc-400">
        <ImageOff className="size-10" />
      </div>
    );
  }
  return (
    <img
      alt={alt}
      className="max-h-[76vh] max-w-full rounded-md object-contain select-none"
      draggable={false}
      onError={() => {
        setFailed(true);
      }}
      src={src}
    />
  );
}

export function Lightbox({
  results,
  index,
  onClose,
  onNavigate,
}: {
  results: ResultItem[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const t = useT();
  const settings = useSettings();
  const result = results[index];
  const touchStartX = useRef<number | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>();

  const resetZoom = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // wheel zoom, non-passive so the page never scrolls behind the viewer
  useEffect(() => {
    const el = stageRef.current;
    if (!el) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((prev) => {
        // allow zooming out to 50% so small thumbnails can shrink to context
        const next = Math.min(5, Math.max(0.5, prev * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
        return Math.round(next * 100) / 100;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  // reset whenever another image is opened (resetZoom itself is stable)
  // biome-ignore lint/correctness/useExhaustiveDependencies: index change must re-run the reset
  useEffect(() => {
    resetZoom();
  }, [index, resetZoom]);

  const close = useCallback(
    (viaUser: boolean) => {
      if (viaUser && window.location.hash === IMAGE_VIEWER_HASH) {
        history.back(); // hashchange listener calls onClose
      } else {
        onClose();
      }
    },
    [onClose],
  );

  const nav = useCallback(
    (delta: number) => {
      resetZoom();
      const next = (index + delta + results.length) % results.length;
      onNavigate(next);
    },
    [index, results.length, onNavigate, resetZoom],
  );

  useEffect(() => {
    if (window.location.hash !== IMAGE_VIEWER_HASH) {
      window.location.hash = "image-viewer";
    }
    const onHashChange = () => {
      if (window.location.hash !== IMAGE_VIEWER_HASH) {
        onClose();
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const zoomIn = event.key === "+" || event.key === "=";
      const zoomOut = event.key === "-";
      if (
        event.key !== "Escape" &&
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight" &&
        !zoomIn &&
        !zoomOut &&
        event.key !== "0"
      ) {
        return;
      }
      // capture phase so the results-page hotkeys (arrows paginate) don't
      // also fire while the viewer is open
      event.stopPropagation();
      if (event.key === "Escape") {
        close(true);
      } else if (event.key === "ArrowLeft") {
        nav(-1);
      } else if (event.key === "ArrowRight") {
        nav(1);
      } else if (event.key === "0") {
        resetZoom();
      } else if (zoomIn || zoomOut) {
        // keyboard path of the wheel zoom: same 0.5×–5× window, ±15% steps
        setZoom((prev) => {
          const next = Math.min(5, Math.max(0.5, prev * (zoomIn ? 1.15 : 1 / 1.15)));
          return Math.round(next * 100) / 100;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [close, nav, resetZoom]);

  if (!result) {
    return null;
  }

  const thumbSrc = result.thumbnail_src || result.img_src || "";
  const linkProps = newTabLinkProps(settings.results_on_new_tab);

  const hostname = result.netloc || (result.url ? hostnameOf(result.url) : "");
  // the title already names the site; engines whose source field adds
  // information (openverse: "flickr") keep the extra label
  const source = result.source?.toLowerCase() === hostname.toLowerCase() ? null : result.source;
  const formats = result.formats ?? [];

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex flex-col bg-[#161616]/97 animate-fade-in"
      onTouchEnd={(event) => {
        const start = touchStartX.current;
        const end = event.changedTouches[0]?.clientX ?? null;
        touchStartX.current = null;
        if (start !== null && end !== null && Math.abs(end - start) > 48) {
          nav(end < start ? 1 : -1);
        }
      }}
      onTouchStart={(event) => {
        touchStartX.current = event.changedTouches[0]?.clientX ?? null;
      }}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      {/* top bar: the image details as a permanent inline row (wrapping on
          narrow viewports — same data at every width, no toggle), the zoom
          percentage appended while zoomed, close at the end */}
      <div className="flex items-start justify-between gap-3 p-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-0.5 py-1.5 text-xs leading-5">
          <Label label={t("resolution")} value={result.resolution} />
          <Label label={t("type")} value={result.img_format} />
          <Label label={t("filesize")} value={result.filesize} />
          <Label label={t("source")} value={source} />
          {formats.length > 0 ? (
            <span className="inline-flex flex-wrap items-center gap-x-1">
              <span className="text-zinc-400">{t("image_formats")}</span>
              {formats.map((ref, index) => (
                <span className="whitespace-nowrap" key={`${ref.url} ${ref.label}`}>
                  {index > 0 ? <span className="text-zinc-500">· </span> : null}
                  <a
                    className="text-zinc-200 transition-colors hover:text-white hover:underline"
                    dir="ltr"
                    href={ref.url}
                    {...linkProps}
                  >
                    {ref.label}
                  </a>
                </span>
              ))}
            </span>
          ) : null}
          {zoom !== 1 ? (
            <span className="whitespace-nowrap text-zinc-400" dir="ltr">
              {Math.round(zoom * 100)}%
            </span>
          ) : null}
        </div>
        <button
          aria-label={t("close")}
          className="grid size-9 shrink-0 place-items-center rounded-full text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
          data-dialog-close=""
          onClick={() => {
            close(true);
          }}
          type="button"
        >
          <X className="size-4.5" />
        </button>
      </div>

      {/* image */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4 pb-4"
        ref={stageRef}
      >
        <div
          aria-label={result.title_text}
          className={`flex items-center justify-center ${zoom > 1 ? "touch-none" : ""}`}
          onDoubleClick={() => {
            resetZoom();
          }}
          onPointerDown={(event) => {
            if (zoom <= 1) {
              return;
            }
            dragStart.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
            setDragging(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = dragStart.current;
            if (!start) {
              return;
            }
            setOffset({ x: start.ox + (event.clientX - start.x), y: start.oy + (event.clientY - start.y) });
          }}
          onPointerUp={(event) => {
            dragStart.current = null;
            setDragging(false);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          role="img"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transition: dragging ? "none" : "transform 150ms ease-out",
            cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
          }}
        >
          <ProgressiveImage alt={imageAlt(result)} full={result.img_src ?? ""} thumbnail={thumbSrc} />
        </div>
        <div className="absolute bottom-2 right-5 flex gap-2">
          <button
            aria-label={t("previous_page")}
            className="grid size-11 place-items-center rounded-full bg-white/10 text-zinc-200 backdrop-blur transition-colors hover:bg-white/20 hover:text-white"
            onClick={() => {
              nav(-1);
            }}
            type="button"
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            aria-label={t("next_page")}
            className="grid size-11 place-items-center rounded-full bg-white/10 text-zinc-200 backdrop-blur transition-colors hover:bg-white/20 hover:text-white"
            onClick={() => {
              nav(1);
            }}
            type="button"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>
      </div>

      {/* bottom bar: title block + the fixed action buttons as the right
          anchor; details live behind the top-bar (i) toggle */}
      <div className="flex items-center gap-x-4 border-t border-white/10 bg-[#1c1c1c]/95 px-5 py-3">
        <div className="min-w-0 flex-1">
          {result.url ? (
            <a
              className="block truncate text-sm font-medium text-zinc-100 hover:underline"
              dir="auto"
              href={result.url}
              {...linkProps}
            >
              {result.title_text}
            </a>
          ) : (
            <p className="truncate text-sm font-medium text-zinc-100" dir="auto">
              {result.title_text}
            </p>
          )}
          {hostname ? (
            <p className="truncate text-xs text-zinc-400" dir="ltr">
              {hostname}
            </p>
          ) : null}
          <EnginesLine result={result} tone="dark" />
        </div>

        <div className="flex shrink-0 items-center gap-2 text-[13px]">
          {result.img_src ? (
            <a
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-600 px-3 py-1.5 font-medium text-zinc-200 transition-colors hover:border-zinc-400"
              href={result.img_src}
              {...linkProps}
            >
              {t("view_original")}
              <ExternalLink className="size-3.5" />
            </a>
          ) : null}
          {result.img_src ? (
            <a
              className="inline-flex items-center gap-1.5 rounded-full bg-accent-strong px-3 py-1.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
              href={result.img_src}
              {...linkProps}
            >
              {t("download")}
              <Download className="size-3.5" />
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Label({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) {
    return null;
  }
  return (
    <span className="whitespace-nowrap">
      <span className="text-zinc-400">{label} </span>
      <span className="text-zinc-200">{value}</span>
    </span>
  );
}
