// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// Slide overflow auto-fit (DESIGN.md §5.2 family contract, the ZJBlog
// src/features/deck/deckFit.ts twin): on the fixed 1280×720 canvas an
// over-tall body would be clipped by overflow -- this detects the overflow
// and applies a uniform scale + width compensation to the compile-time
// .deck-body wrapper, so the whole page shrinks INTO the canvas with its
// original layout intact.
//
// Principle: a section's layout width is always 1280 CSS px (viewport
// scaling rides the canvas-level transform), so one measurement is stable
// and never changes with the window; scale takes no part in layout, so
// scrollHeight always reports the original content height and
// undo-remeasure is idempotent.  Below the scale floor, keep the clipping
// -- shrinking without bound is unreadable.  A display:none slide has no
// measurable size: page mode measures only VISIBLE slides and remeasures
// on page turn; late content (mermaid svg, images) triggers a remeasure
// through the MutationObserver the viewer mounts (fit only touches
// style/attribute, never childList -- no observer loop).

const MIN_SCALE = 0.5;
/** The scale floor: below it the text is unreadable. */

/** Fit ONE slide: on overflow apply scale + width compensation to
    .deck-body; returns whether a fit was applied. */
function fitSlide(section: HTMLElement): boolean {
  const body = section.querySelector<HTMLElement>(":scope > .deck-body");
  if (!body) {
    return false;
  }
  body.style.transform = "";
  body.style.width = "";
  delete section.dataset.deckFit;
  const cs = getComputedStyle(section);
  const padTop = Number.parseFloat(cs.paddingTop) || 0;
  const padBottom = Number.parseFloat(cs.paddingBottom) || 0;
  const contentBox = section.clientHeight - padTop - padBottom;
  // The content's real height = the wrapper's own scrollHeight (unaffected
  // by transform).  section.scrollHeight would NOT do: it clamps to
  // clientHeight and counts padding-bottom -- an un-overflowed page would
  // misreport as exactly one padding over.
  const bodyExtent = body.scrollHeight;
  if (contentBox <= 0 || bodyExtent <= contentBox + 1) {
    return false;
  }
  const scale = Math.max(MIN_SCALE, contentBox / bodyExtent);
  body.style.transformOrigin = "top left";
  body.style.transform = `scale(${scale})`;
  // Width compensation: widen the layout by 1/s first, then the scale
  // shrinks it back -- the body's effective line width is unchanged while
  // the whole page scales down uniformly.
  body.style.width = `${100 / scale}%`;
  section.dataset.deckFit = scale.toFixed(2);
  return true;
}

/** Measure every currently VISIBLE slide: page mode shows only the
 * current slide (display:none has no measurable size; the page-turn
 * effect remeasures on flip), continuous/print reveal covers the rest
 * naturally. */
export function fitVisibleSlides(root: HTMLElement): void {
  for (const section of root.querySelectorAll<HTMLElement>("section[data-slide]")) {
    if (section.offsetParent !== null) {
      fitSlide(section);
    }
  }
}

/** The late-content remeasure observer: after DOM changes swap a mermaid
 * placeholder for its svg or finish loading an image, debounced-refit the
 * visible slides.  The viewer attaches it once on canvas mount and
 * cleans up on unmount. */
export function observeLateContent(root: HTMLElement): () => void {
  let timer = 0;
  const observer = new MutationObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      fitVisibleSlides(root);
    }, 180);
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    window.clearTimeout(timer);
    observer.disconnect();
  };
}
