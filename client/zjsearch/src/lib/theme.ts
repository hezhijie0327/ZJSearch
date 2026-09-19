// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Light/dark theme handling shared by the quick toggle and the preferences UI. */

import { readCookie } from "@/lib/cookies.ts";

export type ThemeStyle = "auto" | "light" | "dark" | "black";

function readThemeStyle(): ThemeStyle {
  const value = readCookie("simple_style");
  if (value === "light" || value === "dark" || value === "black") {
    return value;
  }
  return "auto";
}

export function applyThemeStyle(style: ThemeStyle) {
  const dark =
    style === "dark" ||
    style === "black" ||
    (style === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  /* the palette cross-fade itself lives in CSS: the color tokens are
     registered <color> custom properties with a transition on <html>, so
     flipping the classes here animates every var() consumer.  A real
     change also opens the `.zjs-palette-anim` stand-down window (~350ms):
     elements with their own transition-colors (chips, pills, switches)
     would otherwise chase the interpolating tokens on their private 150ms
     timer and visibly lag the rest of the page.  Boot calls whose classes
     already match never open the window; reduced-motion users get none. */
  const changing = root.classList.contains("dark") !== dark || root.classList.contains("black") !== (style === "black");
  if (changing && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.classList.add("zjs-palette-anim");
    window.clearTimeout(paletteAnimTimer);
    paletteAnimTimer = window.setTimeout(() => root.classList.remove("zjs-palette-anim"), 350);
  }
  root.classList.toggle("dark", dark);
  root.classList.toggle("black", style === "black");
}

let paletteAnimTimer: number | undefined;

export function applyCenterAlignment(on: boolean) {
  document.documentElement.classList.toggle("centered", on);
}

/** Live-follow system theme switches while the page is open (auto mode). */
export function watchSystemTheme() {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (readThemeStyle() === "auto") {
      applyThemeStyle("auto");
    }
  });
}
