// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The install-prompt flow: capture `beforeinstallprompt`, expose the
    deferred prompt to the header's install action, and stop offering once
    installed or dismissed (the dismissal lives for the session -- a fresh
    visit may ask again).

    The worker (searx/zjsearch/pwa.py's /sw.js) and the themed manifest
    are the other two legs of the installability tripod; Chrome fires
    `beforeinstallprompt` only when all three check out. */

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "zjs-install-dismissed";

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Wire the browser events -- call once at boot (main.tsx). */
export function initPwaInstall(): void {
  if (installed || deferred) {
    return;
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    try {
      sessionStorage.removeItem(DISMISS_KEY);
    } catch {
      /* storage unavailable -- the button state is best-effort */
    }
    notify();
  });
}

/** The deferred prompt is available AND the app is not already running
    installed (standalone windows never need the button). */
export function canPromptInstall(): boolean {
  if (deferred === null || installed) {
    return false;
  }
  try {
    if (sessionStorage.getItem(DISMISS_KEY)) {
      return false;
    }
  } catch {
    /* storage unavailable -- offer anyway */
  }
  return !window.matchMedia("(display-mode: standalone)").matches;
}

/** Fire the deferred prompt: "accepted" | "dismissed", or null when the
    prompt is gone (the caller hides the entry point either way). */
export async function promptInstall(): Promise<"accepted" | "dismissed" | null> {
  if (deferred === null) {
    return null;
  }
  const event = deferred;
  await event.prompt();
  const choice = await event.userChoice;
  if (choice.outcome === "dismissed") {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* storage unavailable -- the offer may reappear next prompt */
    }
  }
  deferred = null;
  notify();
  return choice.outcome;
}

/** Subscribe to availability flips (the button re-renders on them).
    Returns the unsubscribe function. */
export function onPwaInstallChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
