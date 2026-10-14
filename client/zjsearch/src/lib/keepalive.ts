// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * The backgrounded tab's keepalive: a run's event stream dies when the
 * browser freezes the page or the OS drops the socket, but a DEDICATED
 * WORKER's timers are NOT throttled by tab visibility (the window's
 * setInterval clamps to ~1/min under Chrome's intensive throttling; the
 * worker keeps its own schedule).  While a run streams, a tiny inline
 * Blob worker POSTs a heartbeat every interval -- the run host counts
 * the grace window from the LAST beat, so a living tab whose fetch the
 * OS dropped keeps its run alive, and a closed tab stops beating and
 * takes the normal grace wrap.  The worker is inline on purpose: no
 * static-root publishing contract, no extra request, nothing to cache.
 *
 * The beat's OUTCOME rides back to the page (`onBeat`): every beat opens
 * a FRESH connection, so a succeeded beat while the run stream sits
 * silent is the half-open-socket verdict -- the network is up, only the
 * stream's own TCP path died -- and the page's idle watchdog uses it to
 * reattach immediately instead of waiting out the full silence ceiling.
 */

const WORKER_SOURCE = `
let timer = null;
self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === "start") {
    if (timer) clearInterval(timer);
    const beat = () => {
      fetch(data.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: data.body,
        keepalive: true,
      })
        .then((response) => self.postMessage({ type: "beat", ok: response.ok }))
        .catch(() => self.postMessage({ type: "beat", ok: false }));
    };
    beat();
    timer = setInterval(beat, data.intervalMs);
  } else if (data.type === "stop") {
    if (timer) clearInterval(timer);
    timer = null;
    self.close();
  }
};
`;

export const KEEPALIVE_INTERVAL_MS = 45_000;
/** Comfortably under the run host's 90s detach grace: one missed beat
    still leaves a full window before the wrap. */

export interface RunKeepalive {
  stop(): void;
}

export function startRunKeepalive(
  runKey: string,
  body: Record<string, unknown>,
  intervalMs: number = KEEPALIVE_INTERVAL_MS,
  onBeat?: (ok: boolean) => void,
): RunKeepalive {
  const noop = { stop: () => {} };
  if (!runKey || typeof Worker === "undefined" || typeof URL?.createObjectURL !== "function") {
    return noop;
  }
  try {
    const worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" })));
    if (onBeat) {
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; ok?: boolean } | null;
        if (data?.type === "beat") {
          onBeat(Boolean(data.ok));
        }
      };
    }
    worker.postMessage({
      type: "start",
      url: "/zjsearch/ai/run/keepalive",
      body: JSON.stringify(body),
      intervalMs,
    });
    return {
      stop: () => {
        try {
          worker.onmessage = null;
          worker.postMessage({ type: "stop" });
          worker.terminate();
        } catch {
          /* a terminated worker is already silent */
        }
      },
    };
  } catch {
    // a CSP or blob-worker refusal degrades to the old grace semantics
    return noop;
  }
}
