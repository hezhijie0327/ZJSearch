// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Secondary pages load on demand: the entry bundle stays lean and these
    chunks are only fetched the first time a drawer (or a direct visit)
    needs them. */

import { lazy } from "react";

export const InfoPage = lazy(() => import("@/pages/InfoPage.tsx").then((m) => ({ default: m.InfoPage })));

/** The results feature tree (cards, grids, answers, infobox …) is the heavy
    half of the bundle; the home page must never download it.  The streamed
    results shell pre-warms the chunk with an inline import() (stable chunk
    name, see vite.config), so by the time the app boots on a search page the
    module is usually already in the module map and `ResultsPage` resolves
    without a paint gap. */
export const ResultsPage = lazy(() => import("@/pages/ResultsPage.tsx").then((m) => ({ default: m.ResultsPage })));

/** Fire-and-forget preloader for search intent: the hero search box calls it
    on focus so an on-the-spot query never waits for the chunk. */
export function preloadResultsPage(): void {
  void import("@/pages/ResultsPage.tsx");
}

export const PreferencesPage = lazy(() =>
  import("@/pages/preferences/PreferencesPage.tsx").then((m) => ({ default: m.PreferencesPage })),
);

export const StatsPage = lazy(() => import("@/pages/StatsPage.tsx").then((m) => ({ default: m.StatsPage })));
