// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
/** The knowledge listing's favicon channel: the store rows' hosts never
    passed the server's template serialization, so the page asks the one
    route that reuses the classic results' favicon machinery (the
    resolver preference, the server cache, the data-URL fast path, the
    signed proxy route).  One module-level cache per session; a host's
    fetch is deduped while in flight; an empty answer (no resolver
    configured / no icon found) is cached too. */

import { useEffect, useState } from "react";

import { fetchJson } from "@/lib/http.ts";
import { aiTokenValue } from "@/lib/kb/shared.ts";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

async function loadFavicon(host: string): Promise<string> {
  const hit = cache.get(host);
  if (hit !== undefined) {
    return hit;
  }
  let run = inflight.get(host);
  if (!run) {
    run = fetchJson<{ favicon: string }>("/zjsearch/knowledge/favicon", {
      body: JSON.stringify({ host, tk: aiTokenValue() }),
      headers: { "Content-type": "application/json" },
      method: "POST",
    })
      .then((r) => {
        const url = String(r.favicon ?? "");
        cache.set(host, url);
        return url;
      })
      .catch(() => {
        cache.set(host, "");
        return "";
      })
      .finally(() => {
        inflight.delete(host);
      });
    inflight.set(host, run);
  }
  return run;
}

/** A host's favicon url (the classic channel), null until fetched and
    null when the channel has none -- the row keeps its Globe fallback. */
export function useKnowledgeFavicon(host: string | null): string | null {
  const [url, setUrl] = useState<string | null>(() => (host ? cache.get(host) || null : null));
  useEffect(() => {
    if (!host) {
      return;
    }
    const hit = cache.get(host);
    if (hit !== undefined) {
      setUrl(hit || null);
      return;
    }
    setUrl(null);
    let live = true;
    void loadFavicon(host).then((found) => {
      if (live) {
        setUrl(found || null);
      }
    });
    return () => {
      live = false;
    };
  }, [host]);
  return url;
}
