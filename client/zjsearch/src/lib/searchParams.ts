// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Search parameter codec and transport, shared by the router (URL state),
 * the results page (infinite scroll) and the sidebar (shareable URL).
 * One entry list per search parameter keeps the GET query, the POST form
 * body and the parser in sync.
 */

import { fetchText } from "@/lib/http.ts";
import { extractPageData } from "@/lib/pageData.ts";
import type { SearchPageData } from "@/lib/types.ts";

export interface SearchParams {
  q: string;
  categories?: string[];
  pageno?: number;
  language?: string;
  time_range?: string;
  safesearch?: number;
  timeout_limit?: string;
  engine_data?: Record<string, Record<string, string>>;
  theme?: string;
}

/** One entry per search parameter, shared by the URL builder and the POST
    form body so both transports stay in sync. */
export function searchParamEntries(params: SearchParams): Array<[string, string]> {
  const entries: Array<[string, string]> = [["q", params.q]];
  if (params.language) {
    entries.push(["language", params.language]);
  }
  if (params.time_range) {
    entries.push(["time_range", params.time_range]);
  }
  if (params.safesearch !== undefined) {
    entries.push(["safesearch", String(params.safesearch)]);
  }
  if (params.timeout_limit) {
    entries.push(["timeout_limit", params.timeout_limit]);
  }
  if (params.theme) {
    entries.push(["theme", params.theme]);
  }
  if (params.pageno !== undefined && params.pageno > 1) {
    entries.push(["pageno", String(params.pageno)]);
  }
  if (params.categories && params.categories.length > 0) {
    entries.push(["categories", params.categories.join(",")]);
  }
  for (const [engine, kv] of Object.entries(params.engine_data ?? {})) {
    for (const [key, value] of Object.entries(kv)) {
      entries.push([`engine_data-${engine}-${key}`, value]);
    }
  }
  return entries;
}

export function buildSearchUrl(params: SearchParams): string {
  return `/search?${new URLSearchParams(searchParamEntries(params)).toString()}`;
}

/** A `?theme=` URL override must survive subsequent searches — the simple
    theme keeps a hidden `theme` input in its forms for the same reason.
    Read at call time from the current location; URLs built with explicit
    params (the shareable search URL) never carry it. */
export function urlThemeOverride(): string | null {
  return new URLSearchParams(window.location.search).get("theme");
}

/** Shareable URL rebuilt from a results payload - the address bar carries no
    query in POST mode, so the meta line and the sidebar both offer this.
    Absolute on purpose: the result is meant to be copied or shared. */
export function shareableSearchUrl(data: SearchPageData): string {
  return `${window.location.origin}${buildSearchUrl({
    q: data.q,
    categories: data.selected_categories.length > 0 ? data.selected_categories : undefined,
    pageno: data.pageno,
    language: data.current_language,
    time_range: data.time_range || undefined,
    timeout_limit: data.timeout_limit || undefined,
    safesearch: data.globals.safesearch,
  })}`;
}

/** The same parameters as a multipart form body (POST-mode searches). */
function toSearchFormData(params: SearchParams): FormData {
  const body = new FormData();
  for (const [key, value] of searchParamEntries(params)) {
    body.append(key, value);
  }
  return body;
}

export function parseSearchUrl(url: URL): SearchParams {
  const query = url.searchParams;
  const engine_data: Record<string, Record<string, string>> = {};
  for (const [key, value] of query.entries()) {
    if (key.startsWith("engine_data-")) {
      const rest = key.slice("engine_data-".length);
      const sep = rest.indexOf("-");
      if (sep > 0) {
        const engine = rest.slice(0, sep);
        const dataKey = rest.slice(sep + 1);
        if (!engine_data[engine]) {
          engine_data[engine] = {};
        }
        engine_data[engine][dataKey] = value;
      }
    }
  }
  const categories = query.get("categories");
  return {
    q: query.get("q") ?? "",
    categories: categories ? categories.split(",") : undefined,
    pageno: Number(query.get("pageno")) || 1,
    language: query.get("language") ?? undefined,
    time_range: query.get("time_range") ?? undefined,
    safesearch: query.has("safesearch") ? Number(query.get("safesearch")) : undefined,
    timeout_limit: query.get("timeout_limit") ?? undefined,
    theme: query.get("theme") ?? undefined,
    engine_data: Object.keys(engine_data).length > 0 ? engine_data : undefined,
  };
}

/** Fetch one results page through the current effective method: POST mode
    pages the query through the request body, GET mode through the URL. */
export async function fetchSearchPage(params: SearchParams, method: "GET" | "POST"): Promise<SearchPageData> {
  const override = urlThemeOverride();
  const effective = override ? { ...params, theme: override } : params;
  const html =
    method === "POST"
      ? await fetchText("/search", {
          body: toSearchFormData(effective),
          headers: { Accept: "text/html" },
          method: "POST",
        })
      : await fetchText(buildSearchUrl(effective), { headers: { Accept: "text/html" } });
  const data = extractPageData(html);
  // a redirect could land on a non-results shell (e.g. the index page) — the
  // caller dereferences results/paging, so fail loudly instead of crashing
  if (data.globals.page !== "results") {
    throw new Error("not a results page");
  }
  return data as SearchPageData;
}
