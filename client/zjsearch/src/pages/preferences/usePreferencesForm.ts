// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * All preference form state plus the auto-save machinery.  Every change is
 * debounced and POSTed with the exact form semantics of upstream
 * /preferences (Preferences.parse_form): absent booleans are false, and the
 * `engine_*` / `plugin_*` keys are REVERSED — a posted key marks that engine
 * or plugin as disabled, so we send exactly the disabled set (omitted keys
 * are re-enabled by the server).
 */

import { useEffect, useRef, useState } from "react";
import { fetchText } from "@/lib/http.ts";
import { useT } from "@/lib/i18n.ts";
import { flashToast } from "@/lib/toast.ts";
import type { PreferencesPageData } from "@/lib/types.ts";

export function usePreferencesForm(data: PreferencesPageData) {
  const kv = data.kv;
  const t = useT();

  const [savedAt, setSavedAt] = useState(0);

  // form state
  const [categories, setCategories] = useState<string[]>(kv.categories);
  const [language, setLanguage] = useState(kv.language);
  const [autocomplete, setAutocomplete] = useState(kv.autocomplete);
  const [faviconResolver, setFaviconResolver] = useState(kv.favicon_resolver);
  const [safesearch, setSafesearch] = useState(String(kv.safesearch));
  const [tokens, setTokens] = useState(kv.tokens);
  const [doiResolver, setDoiResolver] = useState(
    Object.entries(data.doi_resolvers).find(([, url]) => url === kv.doi_resolver)?.[0] ?? "",
  );
  const [locale, setLocale] = useState(kv.locale);
  const [theme, setTheme] = useState(kv.theme);
  const [themeStyle, setThemeStyle] = useState<string>(kv.simple_style);
  const [resultsOnNewTab, setResultsOnNewTab] = useState(kv.results_on_new_tab);
  const [searchOnCategorySelect, setSearchOnCategorySelect] = useState(kv.search_on_category_select);
  const [hotkeys, setHotkeys] = useState(kv.hotkeys);
  const [urlFormatting, setUrlFormatting] = useState(kv.url_formatting);
  const [method, setMethod] = useState<"GET" | "POST">(kv.method);
  const [imageProxy, setImageProxy] = useState(kv.image_proxy);
  const [queryInTitle, setQueryInTitle] = useState(kv.query_in_title);
  const [centerAlignment, setCenterAlignment] = useState(kv.center_alignment);
  const [engines, setEngines] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const tabInfo of data.engine_tabs) {
      for (const group of tabInfo.groups) {
        for (const engine of group.engines) {
          map[`${engine.name}__${tabInfo.category}`] = !engine.disabled;
        }
      }
    }
    return map;
  });
  const [plugins, setPlugins] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const plugin of data.plugins) {
      map[plugin.id] = plugin.enabled;
    }
    return map;
  });
  const [pastedHash, setPastedHash] = useState("");

  const toggleEngine = (key: string, value: boolean) => {
    setEngines((prev) => ({ ...prev, [key]: value }));
  };
  const setPluginEnabled = (id: string, enabled: boolean) => {
    setPlugins((prev) => ({ ...prev, [id]: enabled }));
  };
  const setAllEngines = (keys: string[], value: boolean) => {
    setEngines((prev) => {
      const next = { ...prev };
      for (const key of keys) {
        next[key] = value;
      }
      return next;
    });
  };

  // snapshot of every saved field, used to detect changes
  const formSignature = JSON.stringify([
    categories,
    language,
    autocomplete,
    faviconResolver,
    safesearch,
    tokens,
    doiResolver,
    locale,
    theme,
    themeStyle,
    hotkeys,
    urlFormatting,
    method,
    imageProxy,
    queryInTitle,
    centerAlignment,
    resultsOnNewTab,
    searchOnCategorySelect,
    engines,
    plugins,
    pastedHash,
  ]);

  const initialized = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: formSignature covers all saved fields
  useEffect(() => {
    // skip the initial mount: nothing changed yet, posting would corrupt
    // the reversed engine/plugin sets
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      const fd = new FormData();
      fd.set("language", language);
      fd.set("autocomplete", autocomplete);
      fd.set("favicon_resolver", faviconResolver);
      fd.set("safesearch", safesearch);
      fd.set("locale", locale);
      fd.set("theme", theme);
      fd.set("simple_style", themeStyle);
      fd.set("hotkeys", hotkeys);
      fd.set("url_formatting", urlFormatting);
      fd.set("method", method);
      fd.set("doi_resolver", doiResolver);
      fd.set("tokens", tokens);
      if (resultsOnNewTab) {
        fd.set("results_on_new_tab", "on");
      }
      if (searchOnCategorySelect) {
        fd.set("search_on_category_select", "on");
      }
      if (imageProxy) {
        fd.set("image_proxy", "on");
      }
      if (queryInTitle) {
        fd.set("query_in_title", "on");
      }
      if (centerAlignment) {
        fd.set("center_alignment", "on");
      }
      for (const category of categories) {
        fd.append(`category_${category}`, "on");
      }
      for (const [key, allowed] of Object.entries(engines)) {
        if (!allowed) {
          fd.set(`engine_${key.replaceAll(" ", "_")}`, "on");
        }
      }
      for (const [id, enabled] of Object.entries(plugins)) {
        if (!enabled) {
          fd.set(`plugin_${id}`, "on");
        }
      }
      if (pastedHash.trim()) {
        fd.set("preferences", pastedHash.trim());
      }
      // fetchText throws on non-2xx, so "saved" only ever reports real
      // successes; a failed POST leaves the state untouched and the next
      // change re-fires the debounced save
      void fetchText("/preferences", { body: fd, method: "POST", redirect: "follow" })
        .then(() => {
          setSavedAt(Date.now());
        })
        .catch(() => {
          flashToast(t("save_failed"), { tone: "danger" });
        });
    }, 600);
    return () => {
      window.clearTimeout(timer);
    };
  }, [formSignature]);

  return {
    savedAt,
    categories,
    setCategories,
    language,
    setLanguage,
    autocomplete,
    setAutocomplete,
    faviconResolver,
    setFaviconResolver,
    safesearch,
    setSafesearch,
    tokens,
    setTokens,
    doiResolver,
    setDoiResolver,
    locale,
    setLocale,
    theme,
    setTheme,
    themeStyle,
    setThemeStyle,
    resultsOnNewTab,
    setResultsOnNewTab,
    searchOnCategorySelect,
    setSearchOnCategorySelect,
    hotkeys,
    setHotkeys,
    urlFormatting,
    setUrlFormatting,
    method,
    setMethod,
    imageProxy,
    setImageProxy,
    queryInTitle,
    setQueryInTitle,
    centerAlignment,
    setCenterAlignment,
    engines,
    toggleEngine,
    setAllEngines,
    plugins,
    setPluginEnabled,
    pastedHash,
    setPastedHash,
  };
}

export type PreferencesForm = ReturnType<typeof usePreferencesForm>;
