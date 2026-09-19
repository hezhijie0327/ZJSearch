// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { RefObject } from "react";
import { useEffect, useRef } from "react";

/**
 * Focus management for the conditionally-rendered modal dialogs (overlay
 * drawer, image lightbox, help modal): on mount focus moves to the element
 * marked `data-dialog-close` (or the dialog itself — give it tabIndex={-1}),
 * on unmount focus returns to the trigger, and Tab cycles inside the dialog
 * so keyboard users cannot land behind the overlay.  Escape handling stays
 * with each dialog (the lightbox closes through history state, the drawer
 * through its own handler).
 *
 * `active` covers dialogs whose element is rendered by an always-mounted
 * provider (the overlay drawer): pass e.g. `open !== null` so the effect
 * re-runs when the dialog actually appears — the ref alone cannot trigger
 * the effect, it only receives the element during the same commit.
 */
export function useDialogFocus<T extends HTMLElement>(active = true): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!active) {
      return;
    }
    const dialog = ref.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = dialog?.querySelector<HTMLElement>("[data-dialog-close]");
    (close ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) {
        return;
      }
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) {
        return;
      }
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !(current instanceof HTMLElement) || !dialog.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus();
    };
  }, [active]);
  return ref;
}
