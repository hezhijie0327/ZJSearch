// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Motion preferences for JS-driven scrolling.  The global stylesheet guard
 * (`prefers-reduced-motion` → transition/animation/scroll-behavior) cannot
 * reach JS-initiated smooth scrolling, and native `behavior: "smooth"` is
 * not a safe primitive anyway: webviews built with smooth scrolling disabled
 * (embedded browsers, some in-app engines) SILENTLY DROP every smooth
 * scroll — `window.scrollTo`, `scrollIntoView` and CSS `scroll-behavior`
 * alike no-op instead of animating or snapping, so the scroll never happens
 * at all.  Every programmatic scroll therefore goes through `animateScroll`
 * / `scrollIntoViewAnimated`, which tween instant scrolls per frame — they
 * work in every engine, give one consistent easing/duration across browsers,
 * and collapse to an instant jump under reduced motion.
 */

export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type ScrollTarget = { top?: number; left?: number };

// one active tween per scroller — a second call supersedes the first
const active = new WeakMap<object, () => void>();

function stopTween(key: object): void {
  active.get(key)?.();
}

/** Shared per-frame tween of instant scrolls (works where native smooth
    scrolling is disabled).  Cancels on user scroll input (wheel / touch /
    keys) and when superseded by another tween on the same scroller. */
function tweenScroll(
  key: object,
  stepAt: (eased: number) => void,
  distance: number,
  opts?: { durationMs?: number },
): void {
  stopTween(key);
  const duration = opts?.durationMs ?? Math.min(600, Math.max(240, distance * 0.45));
  const t0 = performance.now();
  let raf = 0;
  let timer = 0;
  let stopped = false;
  const onUserScroll = () => stop();
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    window.removeEventListener("wheel", onUserScroll);
    window.removeEventListener("touchstart", onUserScroll);
    window.removeEventListener("keydown", onUserScroll);
    active.delete(key);
  };
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / duration);
    stepAt(t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    if (t < 1) {
      raf = requestAnimationFrame(step);
    } else {
      stop();
    }
  };
  // a starved rAF (occluded tab, frozen pipeline) must never strand the
  // scroll mid-way — settle at the target instead
  timer = window.setTimeout(() => {
    stepAt(1);
    stop();
  }, duration + 150);
  // attach the cancel listeners AFTER the current dispatch completes: the
  // initiating event (a hotkey keydown) would otherwise reach the fresh
  // listener synchronously and cancel its own scroll
  queueMicrotask(() => {
    if (stopped) {
      return;
    }
    window.addEventListener("wheel", onUserScroll, { passive: true });
    window.addEventListener("touchstart", onUserScroll, { passive: true });
    window.addEventListener("keydown", onUserScroll);
  });
  raf = requestAnimationFrame(step);
  active.set(key, stop);
}

/** Animated scroll of the window towards absolute `top`/`left` coordinates
    (undefined axis = leave unchanged). */
export function animateScroll(
  scroller: HTMLElement | Window,
  target: ScrollTarget,
  opts?: { durationMs?: number },
): void {
  if (!(scroller instanceof HTMLElement)) {
    animateWindow(target, opts);
  } else {
    animateBox(scroller, target, opts);
  }
}

function animateWindow(target: ScrollTarget, opts?: { durationMs?: number }): void {
  const top = target.top;
  const left = target.left;
  if ((top === undefined || top === window.scrollY) && (left === undefined || left === window.scrollX)) {
    return;
  }
  if (reducedMotion()) {
    stopTween(window);
    window.scrollTo(left ?? window.scrollX, top ?? window.scrollY);
    return;
  }
  const topFrom = window.scrollY;
  const leftFrom = window.scrollX;
  const distance = Math.max(
    top === undefined ? 0 : Math.abs(top - topFrom),
    left === undefined ? 0 : Math.abs(left - leftFrom),
  );
  tweenScroll(
    window,
    (eased) => {
      window.scrollTo(
        left === undefined ? window.scrollX : Math.round(leftFrom + (left - leftFrom) * eased),
        top === undefined ? window.scrollY : Math.round(topFrom + (top - topFrom) * eased),
      );
    },
    distance,
    opts,
  );
}

function animateBox(box: HTMLElement, target: ScrollTarget, opts?: { durationMs?: number }): void {
  const top = target.top;
  const left = target.left;
  if ((top === undefined || top === box.scrollTop) && (left === undefined || left === box.scrollLeft)) {
    return;
  }
  const apply = (t: number | undefined, l: number | undefined) => {
    if (t !== undefined) {
      box.scrollTop = t;
    }
    if (l !== undefined) {
      box.scrollLeft = l;
    }
  };
  if (reducedMotion()) {
    stopTween(box);
    apply(top, left);
    return;
  }
  const topFrom = box.scrollTop;
  const leftFrom = box.scrollLeft;
  const distance = Math.max(
    top === undefined ? 0 : Math.abs(top - topFrom),
    left === undefined ? 0 : Math.abs(left - leftFrom),
  );
  tweenScroll(
    box,
    (eased) => {
      apply(
        top === undefined ? undefined : Math.round(topFrom + (top - topFrom) * eased),
        left === undefined ? undefined : Math.round(leftFrom + (left - leftFrom) * eased),
      );
    },
    distance,
    opts,
  );
}

/** `scrollIntoView` semantics (block start/center against the window
    scroller, honouring `scroll-margin-top`) driven through `animateScroll`. */
export function scrollIntoViewAnimated(el: HTMLElement, block: "start" | "center" = "start"): void {
  const rect = el.getBoundingClientRect();
  const margin = Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const top =
    block === "start"
      ? rect.top + window.scrollY - margin
      : rect.top + window.scrollY - (window.innerHeight - rect.height) / 2;
  animateScroll(window, { top });
}
