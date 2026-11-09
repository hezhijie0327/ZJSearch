// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useEffect, useState } from "react";
import { reducedMotion } from "@/lib/motion.ts";

/**
 * Exit-animation presence for conditionally rendered surfaces (dropdown
 * menus, dialogs, drawers, popovers): a dismissal keeps the surface mounted
 * for the exit animation instead of snapping it out of the DOM.  Returns
 * `render` (keep the element in the tree) and `closing` (the exit phase —
 * apply the `-out` animation class, set `inert`, and short-circuit handlers
 * that must not re-fire, e.g. a second Escape re-opening history).
 *
 * The unmount is a plain timer sized to the CSS animation duration —
 * deterministic, and it doubles as the timeout fallback for the animation
 * itself.  Reduced motion skips the window entirely (the global stylesheet
 * guard collapses the animation to 0.01ms, so an instant unmount is what
 * the user asked for).
 */
export function useExitPresence(open: boolean, ms = 160): { render: boolean; closing: boolean } {
  const [render, setRender] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setRender(true);
      setClosing(false);
      return;
    }
    if (!render || reducedMotion()) {
      setRender(false);
      setClosing(false);
      return;
    }
    setClosing(true);
    const timer = window.setTimeout(() => {
      setRender(false);
      setClosing(false);
    }, ms);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open, ms, render]);
  return { render, closing };
}
