// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
/** The Lightbox takeover's input channel: the stack's first
    client-to-server live path.  The token rides the boot capability (the
    same page-data HMAC token every AI endpoint takes); coordinates are
    viewport-space (1280x800) -- the server clamps. */

import { fetchJson } from "@/lib/http.ts";

export type BrowserInputPayload =
  | { type: "click"; x: number; y: number }
  | { type: "wheel"; deltaY: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "done" };

let token = "";

/** Called at boot (and on every landing payload) with the ai capability's
    page-data token -- absent = the input route will 403. */
export function configureBrowserInput(t: string | undefined): void {
  token = t ?? "";
}

/** Forward one user input to the interactive session.  Resolves false on
    any failure -- the caller keeps the live frame as the only truth. */
export async function postBrowserInput(payload: BrowserInputPayload): Promise<boolean> {
  try {
    await fetchJson("/zjsearch/ai/browser/input", {
      body: JSON.stringify({ tk: token, ...payload }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    return true;
  } catch {
    return false;
  }
}
