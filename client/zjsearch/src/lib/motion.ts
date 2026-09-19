// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Motion preferences for JS-driven behaviour.  The global stylesheet guard
 * (`prefers-reduced-motion` → transition/animation/scroll-behavior) cannot
 * reach JS-initiated smooth scrolling — every `scrollTo`/`scrollIntoView`/
 * `scrollBy` call must pass this as its `behavior`.
 */
export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function scrollBehavior(): ScrollBehavior {
  return reducedMotion() ? "auto" : "smooth";
}
