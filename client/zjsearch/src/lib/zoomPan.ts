// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * The ONE image zoom/pan engine: the results image viewer and the AI
 * attachment viewer are its only consumers.  0.5x-5x wheel zoom on the
 * stage (a manually attached non-passive listener -- React's synthetic
 * wheel event cannot preventDefault), drag-to-pan while zoomed with
 * pointer capture, double-click reset.  Zoom/pan ride transform only --
 * the stage never changes size with content or zoom level.
 */

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 5;

/** Per-step zoom multiplier: one wheel notch, one +/- key, one button. */
const ZOOM_FACTOR = 1.15;

const clampZoom = (value: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));

export function useZoomPan() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const zoomBy = useCallback((direction: 1 | -1) => {
    setZoom((prev) => clampZoom(prev * (direction > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR)));
  }, []);

  const resetZoom = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((prev) => clampZoom(prev * (event.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR)));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (zoom <= 1) {
      return;
    }
    dragStart.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start) {
      return;
    }
    setOffset({ x: start.ox + (event.clientX - start.x), y: start.oy + (event.clientY - start.y) });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragStart.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  /** Spread onto the zoomable CONTENT element inside the stage (the stage
      itself only carries stageRef -- it must not pan with the content). */
  const contentProps = {
    onDoubleClick: resetZoom,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    style: {
      cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
      transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
      transition: dragging ? "none" : "transform 150ms ease-out",
    } satisfies CSSProperties,
  };

  return { contentProps, pct: Math.round(zoom * 100), resetZoom, stageRef, zoom, zoomBy, zoomed: zoom > 1 };
}
