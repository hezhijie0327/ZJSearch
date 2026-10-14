# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The PWA plumbing: the service worker at the origin root.

``/sw.js`` must live at the SCOPE ROOT to control ``/search`` and the
theme pages (``/static/...`` would scope it away), and the upstream
webapp.py keeps its single theme hook -- so the route registers through
the theme install chain like every other feature.

The worker is deliberately MINIMAL: a pass-through with an offline
fallback for navigations.  It exists to make the manifest installable;
it caches nothing -- static caching through a service worker would
outlive WhiteNoise's 30-second staleness window and revive the
"rebuilt but the page keeps executing the stale bundle" class of bug
with a much longer half-life.  Caching policy is a later, explicit
opt-in.
"""

import flask

SW_SOURCE = """/* zjsearch service worker -- pass-through + offline fallback.
   Deliberately cache-free: static caching here outlives the theme's
   30-second staleness window and revives stale bundles with a much
   longer half-life.  Caching policy is a later, explicit opt-in. */

const OFFLINE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:#faf9f6;color:#1b1a18}
main{text-align:center;padding:2rem}h1{font-size:1.1rem;font-weight:600}p{color:#716c61;font-size:.85rem}</style></head>
<body><main><h1>Offline</h1><p>The network is unreachable -- reconnect and try again.</p></main></body></html>`;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") {
    return;
  }
  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(OFFLINE_HTML, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    ),
  );
});
"""


def sw_js() -> flask.Response:
    """The worker source: no-cache so an updated worker propagates on the
    next reload instead of riding the static cache."""
    resp = flask.Response(response=SW_SOURCE, status=200, mimetype="application/javascript")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


def install(app: flask.Flask) -> None:
    """Register the worker route: the origin root, so the scope covers
    /search and every theme page."""
    app.add_url_rule("/sw.js", "zjs_sw_js", sw_js, methods=["GET"])
