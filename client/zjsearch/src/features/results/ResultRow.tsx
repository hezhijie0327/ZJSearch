// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { ReactNode } from "react";

/** First N rows play the entrance animation with a per-row stagger; rows
    appended by infinite scroll (index ≥ N) get a plain fade-in instead of
    popping into the bottom of the list. */
const FADE_UP_SLOTS = 12;
const MAX_STAGGER_MS = 300;

/** Wrapper for one card in a list layout: page-global hotkey index,
    hotkey-selection ring and the entrance stagger — the scaffold shared by
    every list view (grids mark their own cells instead). */
export function ResultRow({ index, selected, children }: { index: number; selected: boolean; children: ReactNode }) {
  const fadeUp = index < FADE_UP_SLOTS;
  return (
    <div
      className={`rounded-2xl ${selected ? "bg-surface ring-1 ring-accent-strong" : ""} ${
        fadeUp ? "animate-fade-up" : "animate-fade-in"
      }`}
      data-hotkey-index={index}
      style={fadeUp ? { animationDelay: `${Math.min(index * 30, MAX_STAGGER_MS)}ms` } : undefined}
    >
      {children}
    </div>
  );
}
