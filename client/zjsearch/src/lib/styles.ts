// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Shared utility-class fragments for the result area's recurring visual
 * patterns.  Keeping the long Tailwind strings here means a tweak to the
 * swipe/scroll language updates every row at once.
 */

/** Hidden-scrollbar tail for horizontally swipeable rows (mobile-style). */
export const SCROLLBAR_NONE = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** Single-line swipe row: children never wrap or shrink — overflow swipes
    horizontally instead, like the mobile category tabs.  Callers add their
    own gap (e.g. gap-1 / gap-x-2). */
export const SWIPE_ROW = `flex flex-nowrap items-center overflow-x-auto ${SCROLLBAR_NONE} [&>*]:shrink-0`;

/** Multi-part meta row that swipes horizontally on overflow (same hidden
    scrollbar, children never shrink).  Callers add their own gap and text
    size (e.g. gap-x-3 text-xs text-ink-3). */
export const META_ROW = `flex items-center overflow-x-auto whitespace-nowrap ${SCROLLBAR_NONE} [&>*]:shrink-0`;

/** Circular ghost icon button, 36px with 18px icons — header actions,
    drawer/help closes, and every other chrome-level round button. */
export const ICON_BTN =
  "grid size-9 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink";

/** Tiny meta chip (engine pills, mono tokens, tag pills): callers add their
    own text colour / font / hover on top of the shape.  min-h-6 keeps every
    chip a 24px touch target (Lighthouse target-size / WCAG 2.5.8) without
    changing the 12px type tier. */
export const CHIP = "inline-flex min-h-6 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 transition-colors";

/** Mono-token variant of CHIP (IPs, digests, language pairs, algo names):
    same shape, monospace ink-2 text — the 12px meta tier for unbreakable
    payloads, always with break-all/truncate on the content around it. */
export const MONO_CHIP = `${CHIP} font-mono text-xs text-ink-2`;

/** Hover behaviour for interactive chips — every hoverable chip raises its
    text colour the same way (transition-colors lives in CHIP itself). */
export const CHIP_HOVER = "hover:text-ink";

/** Square code chip (inline code tokens: algo names, config keys, license
    tags) — the non-pill sibling of CHIP in the 12px meta tier. */
export const CODE_CHIP = "rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink-2";

/** Segmented-control language (preference tabs, info tabs, stock range
    picker): one shape, two states — selected fills accent-strong. */
export const SEGMENT =
  "flex items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 text-[13px] transition-colors";
export const SEGMENT_ACTIVE = "bg-accent-strong font-medium text-accent-contrast";
export const SEGMENT_IDLE = "text-ink-2 hover:bg-surface-2 hover:text-ink";

/** Shared disabled treatment for secondary controls (pager arrows, sliders):
    dimmed and click-transparent, never invisible. */
export const DISABLED = "disabled:pointer-events-none disabled:opacity-40";

/** Corner badge over media (duration / filesize): the sanctioned 11px badge
    tier on a fixed-dark scrim, readable over any thumbnail in every palette. */
export const TILE_BADGE = "absolute rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white";

/** Reliability column colour: green >=90, ink >=80, amber >=50, red below,
    muted when unknown — shared by the stats page and the engine tables. */
export function reliabilityColor(reliability: number | null): string {
  if (reliability === null) {
    return "text-ink-3";
  }
  if (reliability <= 50) {
    return "text-danger";
  }
  if (reliability < 80) {
    return "text-warning";
  }
  if (reliability < 90) {
    return "text-ink-2";
  }
  return "text-ok";
}
