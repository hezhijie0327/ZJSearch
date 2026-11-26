// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Host styles: the twin of ZJBlog DeckViewer's HOST_CSS (the print and
 *  preview blocks stay in sync on both sides);
 *  differences: no shiki dark switch (code blocks flip through their own
 *  tokens); one extra divider for stacked mode across part
 *  boundaries. */
export const HOST_CSS = `
.deck-root { --deck-canvas-w: 1280px; }
.deck-stage {
  position: relative;
  container-type: inline-size;
  --deck-scale: calc(tan(atan2(100cqw, var(--deck-canvas-w))));
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--bg);
  overflow: hidden;
  box-shadow: var(--shadow-card);
}
.deck-canvas {
  width: var(--deck-canvas-w);
  transform: scale(var(--deck-scale));
  transform-origin: top left;
}
/* Paged: the stage locks 16:9, the canvas scales absolutely at the origin */
.deck-root[data-mode="paged"] .deck-stage { aspect-ratio: 16 / 9; }
.deck-root[data-mode="paged"] .deck-canvas { position: absolute; left: 0; top: 0; }
.deck-root[data-mode="paged"] .deck-canvas section { animation: deck-slide-in 0.28s ease; }
@keyframes deck-slide-in {
  from { opacity: 0; transform: translateX(14px); }
  to { opacity: 1; transform: none; }
}
/* Continuous: adjacent pages inside a part join through a divider (the
   stage height is synced by JS to the post-scale actual value) */
.deck-root[data-mode="stacked"] .deck-canvas section + section,
.deck-root[data-mode="stacked"] .deck-canvas .deck-part + .deck-part > section:first-child {
  border-top: 1px solid var(--line);
}
/* Speaker notes stay out of the canvas (paged mode shows the current
   slide's notes in the React panel) */
.deck-root .marpit section .deck-notes { display: none; }
/* Fullscreen presentation: styles are driven by React state
   (data-fullscreen) instead of the :fullscreen pseudo-class
   -- the native Fullscreen API is often "half-broken" in webview/preview
   environments (the DOM state flips, the view never expands,
   fullscreenchange never dispatches); hanging the styles on state
   guarantees a visible reaction whenever the button is clicked in any
   environment; pseudo-fullscreen = a fixed overlay, and it applies the
   same under real fullscreen.  The control bar stays on screen. */
.deck-root[data-fullscreen] {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: var(--bg);
  padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right))
    max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
  overflow: auto;
}
.deck-root[data-fullscreen] .deck-stage {
  width: min(100%, calc((100dvh - 48px - 64px) * 16 / 9));
  margin-inline: auto;
}
/* Horizontal swipes on the stage go to JS page turns; vertical swipes
   stay with page scrolling */
.deck-stage {
  touch-action: pan-y;
}
/* Paged mode's non-current slides: Tailwind preflight's [hidden] is a
 * layered !important (an unlayered rule loses to a layered one by the
 * cascade's layer inversion), so the page turn uses a custom attribute +
 * its own rule */
.deck-canvas section[data-slide-hidden] {
  display: none !important;
}
/* ── Print / preview paper: the viewport-independent uniform-scale flow
 * (the ZJBlog a0913bf same-shape flow).
 * Desktop Chrome/Edge lay out at marpit's own @page 1280×720 (landscape),
 * so the scale naturally
 * normalizes to 1; pipelines without @page size support (iOS AirPrint and
 * kin) follow the print layout width with the scale
 * (cqw-adaptive), one slide per page, nothing clipped.  Chrome hides,
 * hidden slides reveal, per-block break protection.
 * This component's HOST_CSS rides printDocument's clone onto the paper,
 * so the rules work identically inside the clone.
 * The @media print and html.zjs-print-view (preview face, lib/print.ts)
 * lists stay in sync.
 * ── */
@media print {
  .deck-root [data-deck-chrome] {
    display: none !important;
  }
  .deck-root .deck-stage {
    aspect-ratio: auto !important;
    overflow: visible !important;
    height: auto !important;
    border: none;
    box-shadow: none;
    border-radius: 0;
    margin-inline: auto !important;
  }
  .deck-root .deck-canvas {
    position: static !important;
    transform: none !important;
    zoom: var(--deck-scale) !important;
  }
  .deck-root .deck-canvas section[data-slide-hidden] {
    display: block !important;
  }
  .deck-root .deck-canvas section {
    break-inside: avoid;
    page-break-inside: avoid;
    /* one slide per landscape sheet: the sections are 1280×720 (marpit)
       and the deck paper's @page is the same box -- the explicit break
       pins the boundary even when a slide's content overflows a hair */
    break-after: page;
  }
  .deck-root .deck-canvas section:last-child {
    break-after: auto;
  }
}
.zjs-print-view .deck-root [data-deck-chrome] {
  display: none !important;
}
.zjs-print-view .deck-root .deck-stage {
  aspect-ratio: auto !important;
  overflow: visible !important;
  height: auto !important;
  border: none;
  box-shadow: none;
  border-radius: 0;
  margin-inline: auto !important;
}
.zjs-print-view .deck-root .deck-canvas {
  position: static !important;
  transform: none !important;
  zoom: var(--deck-scale) !important;
}
.zjs-print-view .deck-root .deck-canvas section[data-slide-hidden] {
  display: block !important;
}
.zjs-print-view .deck-root .deck-canvas section {
  break-inside: avoid;
  break-after: page;
}
.zjs-print-view .deck-root .deck-canvas section:last-child {
  break-after: auto;
}
`;
