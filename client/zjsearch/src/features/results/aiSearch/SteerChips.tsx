// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { GripVertical, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import type { AiSteerChip } from "@/features/results/aiSearch/useAiSteer.ts";
import { useT } from "@/lib/i18n.ts";

/** The pending-steer chips under the AI composer (drained chips retire
    from `useAiSteer` on their own; what renders here is what is still
    queued or failed).  This block lived byte-for-byte in BOTH AI entry
    points (ResultsPage + AiThreadPage) and the dismiss glyph had already
    drifted to a literal `×` against the icon law -- one component owns
    it now.

    The queue's ORDER is its priority: the host drains the guide lane
    head-first at the next round boundary, so every pending chip carries
    its rank and the WHOLE chip drags (a 26px grip alone was no touch
    target on mobile; the grip stays as the affordance and the keyboard
    path).  Failed chips never entered the host's lane: no rank, no drag.
    Pointer moves reorder live; release commits the permutation to the
    run host (a stale view reverts through the hook). */
export function SteerChips({
  chips,
  onRetract,
  onReorder,
}: {
  chips: AiSteerChip[];
  onRetract: (text: string) => void;
  onReorder: (next: AiSteerChip[]) => void;
}) {
  const t = useT();
  // the drag's display order -- null follows the hook's list.  The
  // render-phase reset (React's derived-state pattern) re-syncs whenever
  // the hook's list changes underneath: a chip retiring mid-drag wins.
  const [drag, setDrag] = useState<{ base: AiSteerChip[]; order: AiSteerChip[] | null }>(() => ({
    base: chips,
    order: null,
  }));
  if (drag.base !== chips) {
    setDrag({ base: chips, order: null });
  }
  const dragFrom = useRef(-1);
  const shown = drag.order ?? chips;

  if (!shown.length) {
    return null;
  }

  const swap = (from: number, to: number): AiSteerChip[] | null => {
    if (from === to || to < 0 || to >= shown.length) {
      return null;
    }
    const next = [...shown];
    const [moved] = next.splice(from, 1);
    if (!moved) {
      return null;
    }
    next.splice(to, 0, moved);
    setDrag({ base: chips, order: next });
    return next;
  };

  const commit = (next: AiSteerChip[] | null): void => {
    if (next) {
      onReorder(next);
    }
    setDrag({ base: chips, order: null });
    dragFrom.current = -1;
  };

  const startDrag = (event: ReactPointerEvent<HTMLElement>, index: number): void => {
    if (event.button !== 0) {
      return;
    }
    dragFrom.current = index;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (dragFrom.current < 0) {
      return;
    }
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-steer-chip]");
    const to = hit?.getAttribute("data-steer-chip");
    const target = to == null ? Number.NaN : Number.parseInt(to, 10);
    if (!Number.isNaN(target)) {
      // the permutation flows through setDrag; the re-render rebinds this
      // handler to the fresh order, so tracking the dragged chip's new
      // slot keeps the next move right
      swap(dragFrom.current, target);
      dragFrom.current = target;
    }
  };

  // the pending rank (1 = the next boundary's first delivery) -- the
  // ORDER readout that makes priority visible in a wrapped chip row
  let rank = 0;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {shown.map((chip, i) => {
        const draggable = chip.state === "pending";
        if (draggable) {
          rank += 1;
        }
        const lifted = dragFrom.current === i;
        return (
          <span
            className={`inline-flex max-w-[18rem] select-none items-center gap-1 rounded-full border px-2 py-1 text-xs ${
              chip.state === "failed" ? "border-danger/50 text-danger" : "border-line bg-surface-2/50 text-ink-2"
            } ${draggable ? "cursor-grab touch-none active:cursor-grabbing" : ""} ${
              lifted ? "shadow-pop ring-1 ring-accent/50" : ""
            }`}
            data-steer-chip={i}
            key={chip.text}
            onPointerCancel={draggable ? () => commit(null) : undefined}
            onPointerDown={
              draggable
                ? (event) => {
                    startDrag(event, i);
                  }
                : undefined
            }
            onPointerMove={draggable ? moveDrag : undefined}
            onPointerUp={
              draggable
                ? () => {
                    commit(drag.order);
                  }
                : undefined
            }
          >
            {draggable ? (
              <>
                <button
                  aria-label={t("ai_steer_reorder")}
                  className="-my-1 -ms-1 grid size-6 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                  onKeyDown={(event) => {
                    const dir =
                      event.key === "ArrowUp" || event.key === "ArrowLeft"
                        ? -1
                        : event.key === "ArrowDown" || event.key === "ArrowRight"
                          ? 1
                          : 0;
                    if (!dir) {
                      return;
                    }
                    event.preventDefault();
                    commit(swap(i, i + dir));
                  }}
                  type="button"
                >
                  <GripVertical aria-hidden="true" className="size-3.5" />
                </button>
                <span
                  aria-hidden="true"
                  className="shrink-0 rounded-full bg-accent-soft px-1.5 font-mono text-[0.6875rem] font-semibold tabular-nums text-accent"
                  title={t("ai_steer_reorder")}
                >
                  {rank}
                </span>
              </>
            ) : null}
            <span className="truncate" dir="auto">
              {chip.text}
            </span>
            {chip.state === "failed" ? <span>{t("ai_steer_failed")}</span> : null}
            <button
              aria-label={t("remove")}
              className="-me-1 -my-1 grid size-6 shrink-0 place-items-center text-ink-3 transition-colors hover:text-danger"
              onClick={() => {
                onRetract(chip.text);
              }}
              onPointerDown={(event) => {
                // a tap on dismiss is not a drag (the chip's own handler
                // would capture the gesture and swallow the click)
                event.stopPropagation();
              }}
              type="button"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
