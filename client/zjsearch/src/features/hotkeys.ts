// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Keyboard navigation for the results page, mirroring the upstream
 * default and vim layouts (client_settings.hotkeys).
 *
 * All actions are delegated to the HotkeyTarget: the page owns the
 * selection state and knows which elements are navigable.
 */

import { useEffect, useRef } from "react";

export interface HotkeyTarget {
  /** select previous / next result (clamped) */
  move: (delta: number) => void;
  /** open the selected result (same tab or new tab) */
  open: (newTab: boolean) => void;
  /** copy the url of the selected result (write + feedback owned by the page) */
  yank: () => void;
  /** paginate */
  page: (delta: number) => void;
  /** focus the search input */
  focusSearch: () => void;
}

/** Focus the page's search box (hotkey `i` / `/` on every page that has one). */
export function focusSearchInput(): void {
  (document.querySelector('input[name="q"]') as HTMLInputElement | null)?.focus();
}

const TEXT_ENTRY = new Set(["INPUT", "TEXTAREA", "SELECT"]);
/** elements with native Enter/space activation - never intercept their keys */
const NATIVE_ACTIVATION = new Set(["A", "BUTTON"]);

export function useHotkeys(layout: "default" | "vim", target: HotkeyTarget, onHelp: () => void) {
  const ref = useRef(target);
  ref.current = target;
  const helpRef = useRef(onHelp);
  helpRef.current = onHelp;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }
      const el = event.target as HTMLElement | null;
      const tag = el?.tagName ?? "";
      const t = ref.current;
      const vim = layout === "vim";
      const key = event.key;
      if (el?.isContentEditable || TEXT_ENTRY.has(tag)) {
        // inside text fields only Escape means "leave the field"
        if (event.key === "Escape" && tag === "INPUT") {
          (el as HTMLInputElement).blur();
        }
        return;
      }
      if (NATIVE_ACTIVATION.has(tag)) {
        // a focused link or button keeps Space/Enter for its own activation,
        // but the arrow keys must keep navigating the results - otherwise the
        // hotkeys die after clicking a collapsible block header
        if (key === "ArrowDown" || key === "j") {
          event.preventDefault();
          t.move(1);
        } else if (key === "ArrowUp" || key === "k") {
          event.preventDefault();
          t.move(-1);
        }
        return;
      }
      // keys arriving through an IME composition are input, not commands
      if (event.isComposing || event.keyCode === 229) {
        return;
      }

      // the CJK punctuation mode of Chinese IMEs emits the full-width "？"
      if (key === "?" || key === "？") {
        event.preventDefault();
        helpRef.current();
        return;
      }
      if (vim && (key === "j" || key === "k")) {
        event.preventDefault();
        t.move(key === "j" ? 1 : -1);
        return;
      }
      if (!vim && (key === "ArrowDown" || key === "ArrowRight")) {
        event.preventDefault();
        key === "ArrowRight" ? t.page(1) : t.move(1);
        return;
      }
      if (!vim && (key === "ArrowUp" || key === "ArrowLeft")) {
        event.preventDefault();
        key === "ArrowLeft" ? t.page(-1) : t.move(-1);
        return;
      }
      if (key === "n") {
        event.preventDefault();
        t.page(1);
        return;
      }
      if (key === "p") {
        event.preventDefault();
        t.page(-1);
        return;
      }
      if (key === "o" || key === "Enter") {
        event.preventDefault();
        t.open(false);
        return;
      }
      if (key === "t" || (vim && key === "v")) {
        event.preventDefault();
        t.open(true);
        return;
      }
      if (key === "y") {
        event.preventDefault();
        t.yank();
        return;
      }
      if (key === "i" || key === "/" || key === "／") {
        event.preventDefault();
        t.focusSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [layout]);
}
