// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { createContext, type ReactNode, useContext } from "react";

/** Instance-wide cache-link prefix (search.cache_url) — provided once around
    the results area; EnginesLine turns it into a per-result "cached" pill,
    mirroring upstream simple's result_sub_footer. */
const CacheUrlContext = createContext<string | undefined>(undefined);

export function CacheUrlProvider({ cacheUrl, children }: { cacheUrl?: string; children: ReactNode }) {
  return <CacheUrlContext.Provider value={cacheUrl}>{children}</CacheUrlContext.Provider>;
}

/** Renderers that build their own chip row outside EnginesLine read the
    prefix directly. */
export function useCacheUrl(): string | undefined {
  return useContext(CacheUrlContext);
}
