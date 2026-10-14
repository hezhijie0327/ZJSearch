// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Page-level layout intent (Kagi-style per-category presentation), detected
 * from the search payload alone — pure and unit-testable.  A single selected
 * category signals intent; `only_template` additionally catches bang-limited
 * searches where every result shares one template.
 */

import { NO_CATEGORY } from "@/lib/categories.ts";
import type { ResultItem, SearchPageData } from "@/lib/types.ts";

type ResultsLayoutKind =
  | "images"
  | "videos"
  | "music"
  | "movies"
  | "dictionary"
  | "apps"
  | "packages"
  | "science"
  | "files"
  | "products"
  /** relevance-ordered card list (category intent without a grid, e.g. news) */
  | "list"
  /** mixed search: one collapsible block per original search category */
  | "mixed";

export interface ResultsLayout {
  kind: ResultsLayoutKind;
  /** map intent opens the inline OSM map automatically (upstream simple behaviour) */
  autoOpenMap: boolean;
}

/** Engine bangs (`!imdb bat`) run with the pseudo category "none"; every
    result still carries its real category, so a bang search whose results
    all agree on one category inherits that category's presentation. */
function bangCategoryOf(selectedCategories: readonly string[], results: readonly ResultItem[]): string | null {
  const firstResult = results[0];
  if (selectedCategories.length !== 1 || selectedCategories[0] !== NO_CATEGORY || firstResult === undefined) {
    return null;
  }
  return results.every((result) => result.category === firstResult.category) ? firstResult.category : null;
}

export function detectResultsLayout(
  data: Pick<SearchPageData, "only_template">,
  selectedCategories: readonly string[],
  results: readonly ResultItem[],
): ResultsLayout {
  const singleCategory = selectedCategories.length === 1 ? selectedCategories[0] : null;
  const intent = singleCategory ?? bangCategoryOf(selectedCategories, results);
  const onlyTemplate = data.only_template;

  // the stock images specialization shares the masonry presentation
  const isImages =
    (onlyTemplate === "images" || intent === "images" || intent === "stock images") &&
    results.every((result) => result.template === "images" || result.thumbnail_src || result.img_src);
  const isVideos = onlyTemplate === "videos" || intent === "videos";
  const isProducts = (onlyTemplate === "products" || intent === "products") && !isVideos;
  const isMap = intent === "map" && !isImages && !isVideos;
  const isMusic = intent === "music" && !isImages && !isVideos;
  const isMovies = intent === "movies" && !isImages && !isVideos;
  const isDictionary = intent === "dictionaries" || intent === "define";
  const isApps = intent === "apps";
  const isPackages = intent === "packages";
  // science intent renders every result in the scholarly layout; a
  // paper-only bang search (`!pubmed ...`) gets the same treatment
  const isScience = (intent === "science" || onlyTemplate === "paper") && !isImages && !isVideos && !isMusic;
  // files intent (or a torrent-only bang search) gets the file-tile grid;
  // torrents keep the transfer card inside mixed searches
  const isFiles =
    (intent === "files" || onlyTemplate === "torrent") && !isImages && !isVideos && !isMusic && !isScience;

  const autoOpenMap = isMap;
  // precedence mirrors the historical render order — first match wins
  if (isImages) {
    return { kind: "images", autoOpenMap };
  }
  if (isVideos) {
    return { kind: "videos", autoOpenMap };
  }
  if (isMusic) {
    return { kind: "music", autoOpenMap };
  }
  if (isMovies) {
    return { kind: "movies", autoOpenMap };
  }
  if (isDictionary) {
    return { kind: "dictionary", autoOpenMap };
  }
  if (isApps) {
    return { kind: "apps", autoOpenMap };
  }
  if (isPackages) {
    return { kind: "packages", autoOpenMap };
  }
  if (isScience) {
    return { kind: "science", autoOpenMap };
  }
  if (isFiles) {
    return { kind: "files", autoOpenMap };
  }
  if (isProducts) {
    return { kind: "products", autoOpenMap };
  }
  if (singleCategory !== null) {
    return { kind: "list", autoOpenMap };
  }
  return { kind: "mixed", autoOpenMap };
}
