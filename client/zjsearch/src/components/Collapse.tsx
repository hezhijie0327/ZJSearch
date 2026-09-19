// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { type ReactNode, useEffect, useState } from "react";

/**
 * The app-wide animated disclosure (results meta strips, category blocks,
 * media embeds): children fold via a grid-template-rows 0fr → 1fr transition
 * — smooth in BOTH directions, no max-height guessing. The global
 * prefers-reduced-motion guard clips the transition automatically.
 *
 * Folded content is inert + aria-hidden (focus cannot land inside), and with
 * `unmountAfterHide` it unmounts after the close animation finishes — use
 * that mode when children must not stay alive folded (iframes keep playing,
 * hotkey targets poll the DOM); leave it off when the folded tree is cheap
 * and staying mounted avoids re-render churn.
 */
export function Collapse({
  open,
  unmountAfterHide = false,
  className = "",
  innerClassName = "",
  id,
  children,
}: {
  open: boolean;
  /** unmount the children once the closing transition has finished */
  unmountAfterHide?: boolean;
  /** spacing etc. on the animating wrapper (apply margins conditionally:
      a static margin under a folded panel reads as a stray gap) */
  className?: string;
  innerClassName?: string;
  id?: string;
  children: ReactNode;
}) {
  const [present, setPresent] = useState(open);
  const [expanded, setExpanded] = useState(open);

  useEffect(() => {
    if (open) {
      if (!present) {
        setPresent(true);
      }
      // mount at 0fr first, then let the transition play on the next frames
      const frame = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setExpanded(true);
        });
      });
      return () => {
        cancelAnimationFrame(frame);
      };
    }
    setExpanded(false);
    if (unmountAfterHide) {
      const timer = window.setTimeout(() => {
        setPresent(false);
      }, 340);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [open, present, unmountAfterHide]);

  if (!present) {
    return null;
  }
  return (
    <div
      aria-hidden={!expanded}
      className={`grid transition-[grid-template-rows] duration-300 ease-out ${className}`}
      id={id}
      inert={!expanded}
      style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
    >
      <div className={`min-h-0 overflow-hidden ${innerClassName}`}>{children}</div>
    </div>
  );
}
