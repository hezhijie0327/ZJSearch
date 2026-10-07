// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
// 正文图片灯箱：原生 <dialog> 顶层弹层 —— Esc 原生关闭、模态期焦点困在
// 弹层内。固定尺寸舞台（不随图片与缩放变化），图片 object-contain 居中；
// 0.5×–5× 缩放（滚轮 / +− 键 / 按钮，双击或 0 复位），放大后拖拽平移；
// 点击背板关闭。零依赖实现。

import { ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn.ts";
import { useT } from "@/lib/i18n.ts";
import { ICON_BTN } from "@/lib/styles.ts";

export interface LightboxImage {
  alt: string;
  src: string;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 5;
const ZOOM_FACTOR = 1.15;

const clampZoom = (value: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));

export function Lightbox({
  images,
  initialIndex,
  onClose,
}: {
  images: LightboxImage[];
  initialIndex: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const t = useT();
  const image = images[index];

  // 挂载即模态；所有关闭路径统一走原生 close()（Esc 天然如此），父级经
  // close 事件同步状态 —— 先关弹层（释放顶层、焦点可移出）再卸载组件，
  // 否则带焦点卸载会把焦点抢回 body，无法归还给触发图片。
  // 守卫 open：HMR/重挂载下 effect 重跑时对已打开的 dialog 再 showModal 会抛错。
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

  const resetZoom = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const step = (delta: number) => {
    setIndex((current) => (current + delta + images.length) % images.length);
    resetZoom();
  };

  // 滚轮缩放（React 合成事件是 passive 的，preventDefault 需手动挂非被动监听）
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((current) => clampZoom(current * (event.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR)));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  /** 关闭面板（背板/关闭按钮）：交给原生 close()，close 事件驱动父级卸载。 */
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
      if (event.key === "ArrowLeft" && images.length > 1) {
        step(-1);
      } else if (event.key === "-") {
        setZoom((current) => clampZoom(current / ZOOM_FACTOR));
      }
      return;
    }
    if (event.key === "ArrowRight" || event.key === "+" || event.key === "=") {
      event.preventDefault();
      if (event.key === "ArrowRight" && images.length > 1) {
        step(1);
      } else {
        setZoom((current) => clampZoom(current * ZOOM_FACTOR));
      }
      return;
    }
    if (event.key === "0") {
      resetZoom();
    }
  };

  if (!image) {
    return null;
  }

  return (
    <dialog
      {...(image.alt ? { "aria-label": image.alt } : {})}
      className={cn(
        "rounded-2xl border border-line bg-surface shadow-card",
        "lightbox fixed inset-0 m-auto flex h-[min(92dvh,44rem)] w-[min(94vw,56rem)] flex-col p-4 sm:p-5",
      )}
      onClick={onDialogClick}
      onKeyDown={onKeyDown}
      ref={dialogRef}
    >
      {/* 工具条：计数 + 缩放档位 + 关闭 */}
      <div className="flex min-h-9 items-center justify-end gap-2 pb-2">
        {images.length > 1 && (
          <span className="mr-auto font-mono text-xs text-ink-3">
            {index + 1} / {images.length}
          </span>
        )}
        <button
          aria-label={t("lightbox.zoomOut")}
          className={ICON_BTN}
          disabled={zoom <= ZOOM_MIN}
          onClick={() => setZoom((current) => clampZoom(current / ZOOM_FACTOR))}
          type="button"
        >
          <Minus aria-hidden="true" className="size-4" />
        </button>
        {/* 点击百分比复位 100% */}
        <button
          className="min-w-12 rounded px-1 font-mono text-xs text-ink-2 transition-colors hover:text-ink"
          onClick={resetZoom}
          type="button"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          aria-label={t("lightbox.zoomIn")}
          className={ICON_BTN}
          disabled={zoom >= ZOOM_MAX}
          onClick={() => setZoom((current) => clampZoom(current * ZOOM_FACTOR))}
          type="button"
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
        <button aria-label={t("lightbox.close")} className={ICON_BTN} onClick={close} type="button">
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>

      {/* 舞台：固定尺寸，图片 object-contain 居中；缩放/平移走 transform，
          不改变布局 —— 框永远不因图片大小或缩放档位变化 */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden" ref={stageRef}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the drag-pan stage -- keyboard users zoom via +/-, pan is pointer-only */}
        <div
          className={cn("flex items-center justify-center", zoom > 1 && "touch-none")}
          onDoubleClick={resetZoom}
          onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
            if (zoom <= 1) {
              return;
            }
            dragStart.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
            setDragging(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
            const start = dragStart.current;
            if (!start) {
              return;
            }
            setOffset({ x: start.ox + (event.clientX - start.x), y: start.oy + (event.clientY - start.y) });
          }}
          onPointerUp={(event: PointerEvent<HTMLDivElement>) => {
            dragStart.current = null;
            setDragging(false);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          style={{
            cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transition: dragging ? "none" : "transform 150ms ease-out",
          }}
        >
          <img
            alt={image.alt}
            className="max-h-[64dvh] max-w-[min(86vw,52rem)] select-none object-contain"
            draggable={false}
            src={image.src}
          />
        </div>
        {images.length > 1 && (
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
