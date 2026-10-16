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
// the session viewport's LAUNCH dimensions (engine WINDOW, riding the ai
// capability) -- the fallback for frames that carry no w/h; live
// coordinates always map through the frame's own capture dimensions.
let viewport = { w: 1920, h: 1080 };

/** Called at boot (and on every landing payload) with the ai capability's
    page-data token + the session's launch viewport -- absent token = the
    input route will 403; absent dims fall back to the launch default. */
export function configureBrowserInput(t: string | undefined, vw?: number, vh?: number): void {
  token = t ?? "";
  viewport = { w: vw || 1920, h: vh || 1080 };
}

/** The session viewport the takeover's coordinate math falls back to
    (frames carry their own dims -- this only serves frames without). */
export function sessionViewport(): { w: number; h: number } {
  return viewport;
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
