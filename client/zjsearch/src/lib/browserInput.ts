// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
/** The Lightbox takeover's input channel: the stack's first
    client-to-server live path.  The token rides the boot capability (the
    same page-data HMAC token every AI endpoint takes); coordinates are
    viewport-space (the session's actual launch dimensions) -- the server
    clamps. */

import { fetchJson } from "@/lib/http.ts";

export type BrowserInputPayload =
  | { type: "click"; x: number; y: number }
  | { type: "drag"; x1: number; y1: number; x2: number; y2: number }
  | { type: "wheel"; deltaY: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "done" };

/** The fresh mirror frame the input route returns after every forwarded
    action (viewport jpeg + page identity + the model pointer when one is
    tracked) -- the takeover overlays it locally until the next wire frame
    supersedes it. */
export interface BrowserInputFrame {
  img: string;
  url: string;
  title: string;
  w: number;
  h: number;
  px?: number;
  py?: number;
  pk?: string;
}

let token = "";

/** Called at boot (and on every landing payload) with the ai capability's
    page-data token -- absent = the input route will 403. */
export function configureBrowserInput(t: string | undefined): void {
  token = t ?? "";
}

/** Forward one user input to the interactive session.  Resolves null on
    any failure -- the caller keeps the live frame as the only truth; a
    success carries the POST-ACTION frame so the takeover sees its own
    effect immediately (the model's settlements only update the mirror on
    their own beat). */
export async function postBrowserInput(payload: BrowserInputPayload): Promise<BrowserInputFrame | null> {
  try {
    const out = await fetchJson<{ ok?: boolean; frame?: BrowserInputFrame }>("/zjsearch/ai/browser/input", {
      body: JSON.stringify({ tk: token, ...payload }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    return out.frame ?? null;
  } catch {
    return null;
  }
}
