// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * The base64 `client_settings` blob the server attaches to the module script
 * tag (see get_client_settings() in searx/webapp.py).
 */

import { createContext, useContext } from "react";

export interface ClientSettings {
  plugins: string[];
  autocomplete: string;
  autocomplete_min: number;
  method: "GET" | "POST";
  translations: Record<string, string>;
  search_on_category_select: boolean;
  hotkeys: "default" | "vim";
  url_formatting: string;
  theme_static_path: string;
  results_on_new_tab: boolean;
  favicon_resolver: string;
  query_in_title: boolean;
  safesearch: number;
  theme: string;
  doi_resolver: string;
}

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  plugins: [],
  autocomplete: "",
  autocomplete_min: 2,
  method: "GET",
  translations: {},
  search_on_category_select: true,
  hotkeys: "default",
  url_formatting: "pretty",
  theme_static_path: "",
  results_on_new_tab: false,
  favicon_resolver: "",
  query_in_title: false,
  safesearch: 1,
  theme: "zjsearch",
  doi_resolver: "doi.org",
};

export const SettingsContext = createContext<ClientSettings>(DEFAULT_CLIENT_SETTINGS);

export function useSettings(): ClientSettings {
  return useContext(SettingsContext);
}

export function useHasPlugin(): (id: string) => boolean {
  const settings = useSettings();
  return (id: string) => settings.plugins.includes(id);
}
