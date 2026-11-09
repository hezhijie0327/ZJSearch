// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Shared utility-class fragments for the result area's recurring visual
 * patterns.  Keeping the long Tailwind strings here means a tweak to the
 * swipe/scroll language updates every row at once.
 */

/** Hidden-scrollbar tail for horizontally swipeable rows (mobile-style). */
export const SCROLLBAR_NONE = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** Responsive variant: the hidden-scrollbar swipe behaviour kicks in from
    `sm:` up (below it the row wraps) — category/filter tab rows. */
export const SCROLLBAR_NONE_SM = "sm:[scrollbar-width:none] sm:[&::-webkit-scrollbar]:hidden";

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

/** Compact segmented control (in-row choice groups: preferences POST/GET,
    theme-style picker, stock range pills): SEGMENT at the 13px control tier
    with a tighter pad — pair with SEGMENT_ACTIVE / SEGMENT_IDLE. */
export const SEGMENT_SM =
  "flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[13px] transition-colors";

/** Results meta-row toggle (12px tier: "found N results", "took X s", the
    AI trigger): a borderless text button that raises its ink on hover. */
export const META_TOGGLE = "inline-flex min-h-6 items-center gap-1 transition-colors hover:text-ink";

/** Pill chip on the 13px control tier (strip chips, suggestion chips):
    rounded surface fill; callers append their own gap-* and hover colour
    (the selected language lives in the design contract, not here). */
export const PILL =
  "inline-flex items-center rounded-full bg-surface-2 px-3 py-1.5 text-[13px] text-ink-2 transition-colors";

/** Outlined action pill (empty-state actions, pagination, strip buttons):
    bordered round chip that raises to the accent on hover. */
export const OUTLINE_PILL =
  "inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent";

/** Shared disabled treatment for secondary controls (pager arrows, sliders):
    dimmed and click-transparent, never invisible. */
export const DISABLED = "disabled:pointer-events-none disabled:opacity-40";

/** Torn-paper strip button (DESIGN.md §7 family paper language; the torn
    ground is the global `.paper-strip` CSS — paper colour injected via
    `[--strip:…]`).  Micro-tilts are caller-supplied and must be DETERMINISTIC
    (fixed per position, never random — SSR/hydration must agree); hover
    lifts the strip level again. */
export const PAPER_STRIP =
  "paper-strip inline-flex items-center gap-1.5 text-sm font-medium text-ink transition-all hover:-translate-y-0.5 hover:rotate-0 active:translate-y-0";

/** Tape decoration (DESIGN.md §7 family paper language): a translucent amber
    rectangle pressed over a torn-paper edge.  `aria-hidden` +
    `pointer-events-none` are built in; positioning/rotation/opacity are the
    caller's.  MUST be a SIBLING of the clip-path element (a child would be
    cut by the torn edge); two corners beat one centred strip. */
export const TAPE = "pointer-events-none absolute z-10 h-6 bg-accent-soft";

/** The machine-voice pane (AI reading panes, args debug panes): the boxed
    ground that says "produced by the pipeline, not the answer" -- THINK
    reasoning, tool results and debug payloads share it, CONTENT sits on
    the plain ground. */
export const READ_PANE =
  "rounded-lg bg-surface-2/50 py-2 ps-3 pe-10 text-xs leading-relaxed whitespace-pre-wrap break-words text-ink-2";

/** Hover-revealed corner chips over a pane/card (copy, external-open): a
    28px chip that appears on the group's hover AND focus (keyboard users
    tab to it -- without focus-within the control stays invisible). */
export const HOVER_CHIP =
  "grid size-7 place-items-center rounded-lg bg-surface/80 text-ink-3 backdrop-blur transition-opacity hover:text-ink opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";

/** Auxiliary circular ghost button, 28px with 14px icons -- the compact
    action tier for in-card rows (answer actions, row stars/trash, memory
    edit); the 36px ICON_BTN stays the chrome-level tier. */
export const CHIP_BTN =
  "grid size-7 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink";

/** Outlined chip on the 13px control tier (choice chips, filter pills):
    one shape, two states -- pair the shape with CHIP_OUTLINE_IDLE or
    CHIP_OUTLINE_ACTIVE (the selected language per the design contract:
    border-accent-strong + bg-accent-soft + font-medium + text-accent). */
export const CHIP_OUTLINE =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors";
export const CHIP_OUTLINE_IDLE = "border-line text-ink-3 hover:bg-surface-2 hover:text-ink";
export const CHIP_OUTLINE_ACTIVE =
  "border-accent-strong bg-accent-soft font-medium text-accent hover:text-accent-hover";

/** Borderless ghost pill on the same tier: the quiet half of a pill pair
    (cancel/dismiss beside a primary pill). */
export const CHIP_GHOST =
  "inline-flex items-center rounded-full px-3 py-1.5 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink";

/** Accent action chip on the 13px control tier (in-flow continue /
    regenerate-style actions): the soft accent fill with a hairline ring. */
export const CHIP_ACCENT =
  "inline-flex items-center gap-1.5 rounded-full border border-accent-strong/40 bg-accent-soft px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:text-accent-hover";

/** Soft accent action pill without the ring (empty-state actions, card
    download chips); hover deepens to the accent-strong fill. */
export const CHIP_ACCENT_SOFT =
  "inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent-strong hover:text-accent-contrast";

/** Corner badge over media (duration / filesize): the 12px meta floor on a
    fixed-dark scrim, readable over any thumbnail in every palette.  Numerals
    are tabular so durations/sizes align across a grid. */
export const TILE_BADGE = "absolute rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium tabular-nums text-white";

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
