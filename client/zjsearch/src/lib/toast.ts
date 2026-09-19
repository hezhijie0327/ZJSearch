// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Imperative floating feedback pill — the shared 「已复制」/「已保存」 language:
 * a rounded pill fixed at the bottom of the viewport, stacked when several
 * fire together, auto-dismissed after a beat.  Every copy action confirms
 * through `tone: "ok"`; `accent` covers neutral notices and `danger` the
 * failure variants.  Meant for one-shot events (hotkey yank, clipboard
 * writes, the debounced preferences auto-save) — never render such
 * confirmations in flow, they would shift the page.
 */

export type ToastTone = "accent" | "ok" | "danger";

/** accent: soft amber fill (neutral notice); ok/danger: bordered status pill. */
const TONE_CLASS: Record<ToastTone, string> = {
  accent: "bg-accent-soft text-accent",
  ok: "border border-ok/40 bg-bg text-ok",
  danger: "border border-danger/40 bg-bg text-danger",
};

const ICON = (path: string) =>
  `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3.5 shrink-0"><path d="${path}"/></svg>`;

const TONE_ICON: Record<ToastTone, string> = {
  accent: "",
  ok: ICON("M20 6 9 17l-5-5"),
  danger: ICON("M18 6 6 18M6 6l12 12"),
};

let stack: HTMLDivElement | null = null;

/** Toasts belong to the surface the action happened on: with the overlay
    drawer open the stack is hosted inside its panel — the panel's residual
    entrance transform contains `fixed`, so pills center within the drawer
    instead of the viewport. */
function toastHost(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-zjs-overlay-panel]") ?? document.body;
}

export function flashToast(
  label: string,
  { tone = "accent", timeoutMs = 1500 }: { tone?: ToastTone; timeoutMs?: number } = {},
): void {
  const chip = document.createElement("div");
  chip.setAttribute("role", "status");
  chip.className = `inline-flex animate-fade-up items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium shadow-pop ${TONE_CLASS[tone]}`;
  if (TONE_ICON[tone]) {
    chip.innerHTML = TONE_ICON[tone];
  }
  chip.appendChild(document.createTextNode(label));
  const host = toastHost();
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2";
  }
  if (stack.parentElement !== host) {
    host.appendChild(stack); // appendChild moves, keeping live toasts along
  }
  stack.appendChild(chip);
  window.setTimeout(() => {
    chip.classList.add("opacity-0", "transition-opacity", "duration-300");
    window.setTimeout(() => {
      chip.remove();
    }, 300);
  }, timeoutMs);
}
