// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Page payload plumbing: the server embeds the full page state as JSON in
 * `<script id="page-data" type="application/json">`; client side navigation
 * fetches the same URLs and extracts the payload from the HTML response.
 */

import type { ClientSettings } from "@/lib/settings.ts";
import { DEFAULT_CLIENT_SETTINGS } from "@/lib/settings.ts";
import type { AnyPageData } from "@/lib/types.ts";

export function parseEmbeddedPageData(): AnyPageData | null {
  // the late chunk carries ONE #page-data -- but the stream-error recovery
  // (zjsearch_stream) may append a second, clean one after a failed attempt
  // that left a broken script behind: prefer the last payload that parses
  for (const el of [...document.querySelectorAll("#page-data")].reverse()) {
    const text = el.textContent?.trim();
    if (!text) {
      continue;
    }
    try {
      return JSON.parse(text) as AnyPageData;
    } catch {
      /* a truncated payload from a failed serialization -- try the next */
    }
  }
  return null;
}

/** First-stage payload of a streamed search page (see
    searx/templates/zjsearch/data/macros.html, page_boot): globals + query
    with `pending: true`, present in the early shell chunk while the engines
    are still running. */
export function parseBootData(): AnyPageData | null {
  const el = document.getElementById("boot-data");
  const text = el?.textContent?.trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as AnyPageData;
  } catch {
    return null;
  }
}

export function extractPageData(html: string): AnyPageData {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of [...doc.querySelectorAll("#page-data")].reverse()) {
    const text = el.textContent?.trim();
    if (!text) {
      continue;
    }
    try {
      return JSON.parse(text) as AnyPageData;
    } catch {
      /* a truncated payload from a failed stream serialization -- try the next */
    }
  }
  throw new Error("page-data missing in response");
}

export function parseClientSettings(): ClientSettings {
  const el = document.querySelector("script[client_settings]");
  const raw = el?.getAttribute("client_settings");
  if (!raw) {
    return { ...DEFAULT_CLIENT_SETTINGS };
  }
  try {
    const parsed = JSON.parse(atob(raw)) as Partial<ClientSettings>;
    return { ...DEFAULT_CLIENT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_CLIENT_SETTINGS };
  }
}
