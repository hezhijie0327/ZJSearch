// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Tiny SPA router: page loads come from the server shell, every in-app
 * navigation fetches the target URL and swaps the page payload (page-data)
 * via pushState.  On network failures we fall back to a full page load.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { translateFor } from "@/lib/i18n.ts";
import { extractPageData, parseEmbeddedPageData } from "@/lib/pageData.ts";
import { buildSearchUrl, type SearchParams, searchParamEntries, urlThemeOverride } from "@/lib/searchParams.ts";
import { type AnyPageData, isErrorPageData, isPendingSearchData, isRedirectPageData } from "@/lib/types.ts";

export interface NavigateOptions {
  replace?: boolean;
  method?: "GET" | "POST";
  body?: FormData;
}

interface RouterContextValue {
  data: AnyPageData | null;
  loading: boolean;
  error: string | null;
  /** Navigate within the app; falls back to a full page load on failure. */
  navigate: (url: string, options?: NavigateOptions) => void;
  /** Convenience: navigate to /search with the given params. */
  search: (params: SearchParams, options?: NavigateOptions) => void;
  /** Re-fetch the current URL. */
  reload: () => void;
  href: string;
}

const RouterContext = createContext<RouterContextValue | null>(null);

function pageTitle(data: AnyPageData): string {
  const t = translateFor(data.globals.locale);
  const name = data.globals.instance_name;
  if (data.globals.page === "results" && "q" in data && data.q) {
    return `${data.q} - ${name}`;
  }
  if (data.globals.page === "index") {
    return name;
  }
  const labels: Partial<Record<typeof data.globals.page, string>> = {
    preferences: t("preferences"),
    stats: t("engine_stats"),
    info: t("info"),
    404: t("page_not_found"),
  };
  return `${labels[data.globals.page] ?? name} - ${name}`;
}

export function RouterProvider({
  initialData,
  children,
}: {
  initialData: AnyPageData | null;
  children: React.ReactNode;
}) {
  const [data, setData] = useState<AnyPageData | null>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [href, setHref] = useState(() => window.location.href);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  // effective search method from the latest page payload (preference may
  // change at any time through the auto-saving preferences panel)
  const methodRef = useRef<"GET" | "POST">("GET");
  methodRef.current = data?.globals.method ?? methodRef.current;

  const load = useCallback(
    async (url: string, options: NavigateOptions = {}, historyMode: "push" | "replace" | "none" = "push") => {
      const seq = ++seqRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);

      try {
        const resp = await fetch(url, {
          method: options.method ?? "GET",
          body: options.body,
          signal: controller.signal,
          headers: { Accept: "text/html" },
          redirect: "follow",
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const html = await resp.text();
        const pageData = extractPageData(html);
        if (seq !== seqRef.current) {
          return; // superseded by a newer navigation
        }
        // the final URL after redirects (e.g. POST /preferences -> /)
        const finalUrl = new URL(resp.url, window.location.href).href;
        if (historyMode !== "none") {
          const historyMethod = historyMode === "replace" ? "replaceState" : "pushState";
          // keep the payload out of the history state — the page data already
          // lives in React state and popstate re-fetches by URL, so storing
          // it here would only duplicate memory for every visited page
          window.history[historyMethod](null, "", finalUrl);
        }
        setHref(finalUrl);
        setData(pageData);
        setLoading(false);
        document.title = pageTitle(pageData);
        // instant jump on purpose ("auto" never fights reduced motion)
        window.scrollTo(0, 0);
      } catch (err) {
        if (controller.signal.aborted || seq !== seqRef.current) {
          return;
        }
        // network/CORS failure (e.g. external-bang redirect): full page load
        if (err instanceof TypeError) {
          window.location.assign(url);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    },
    [],
  );

  const navigate = useCallback(
    (url: string, options?: NavigateOptions) => {
      // POST mode: native pages only — the SPA must never pushState here,
      // a later popstate could not restore a search page from a query-less
      // URL; the browser's own history (and bfcache) takes over instead
      if (methodRef.current === "POST") {
        if (url !== window.location.href) {
          window.location.assign(url);
        }
        return;
      }
      if (url === window.location.href && !options?.body) {
        return;
      }
      void load(url, options, options?.replace ? "replace" : "push");
    },
    [load],
  );

  const search = useCallback(
    (params: SearchParams, options?: NavigateOptions) => {
      // an explicit `?theme=` link override rides along with every search
      const override = urlThemeOverride();
      const effective = override ? { ...params, theme: override } : params;
      // POST mode mirrors the upstream form flow: the query travels in the
      // request body so it never lands in the URL, the history or access
      // logs — a real form submission, exactly like the simple theme
      if (methodRef.current === "POST") {
        const form = document.createElement("form");
        form.method = "POST";
        form.action = "/search";
        form.hidden = true;
        for (const [key, value] of searchParamEntries(effective)) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = key;
          input.value = value;
          form.append(input);
        }
        document.body.appendChild(form);
        form.submit();
        return;
      }
      navigate(buildSearchUrl(effective), options);
    },
    [navigate],
  );

  const reload = useCallback(() => {
    void load(window.location.href, {}, "none");
  }, [load]);

  const hrefRef = useRef(href);
  hrefRef.current = href;

  useEffect(() => {
    const onPopState = () => {
      // ignore hash-only changes (image viewer open/close etc.)
      const stripHash = (value: string) => {
        const url = new URL(value);
        url.hash = "";
        return url.href;
      };
      if (stripHash(window.location.href) === stripHash(hrefRef.current)) {
        return;
      }
      void load(window.location.href, {}, "none");
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      abortRef.current?.abort();
    };
  }, [load]);

  // Streamed search pages boot into a pending payload while the engines run;
  // the late chunk of the same HTTP response drops the real page-data into
  // the document and notifies the app. We consume the pushed payload — the
  // client must never re-fetch the query it is already waiting for.
  useEffect(() => {
    if (!isPendingSearchData(data)) {
      return;
    }
    const consume = () => {
      const parsed = parseEmbeddedPageData();
      if (!parsed) {
        return;
      }
      if (isRedirectPageData(parsed)) {
        window.location.replace(parsed.url);
        return;
      }
      if (isErrorPageData(parsed)) {
        setError(parsed.message);
        return;
      }
      setData(parsed);
      setLoading(false);
      document.title = pageTitle(parsed);
    };
    (window as { __zjsPageData?: () => void }).__zjsPageData = consume;
    document.addEventListener("zjs:page-data", consume);
    // the late chunk may already sit in the DOM when the app finishes booting
    if (document.getElementById("page-data") !== null) {
      consume();
    }
    return () => {
      delete (window as { __zjsPageData?: unknown }).__zjsPageData;
      document.removeEventListener("zjs:page-data", consume);
    };
  }, [data]);

  return (
    <RouterContext.Provider value={{ data, loading, error, navigate, search, reload, href }}>
      {children}
    </RouterContext.Provider>
  );
}

export function useRouter(): RouterContextValue {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    throw new Error("useRouter outside of RouterProvider");
  }
  return ctx;
}
