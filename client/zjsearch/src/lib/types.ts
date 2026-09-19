// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Data contract between the SearXNG server (searx/templates/zjsearch) and this
 * React application.  Every type mirrors a JSON structure emitted by the
 * Jinja serialization macros in searx/templates/zjsearch/data/macros.html.
 */

// ------------------------------------------------------------------ globals

export interface LocaleInfo {
  tag: string;
  name: string;
  country: string;
  english: string;
  flag: string;
}

interface CustomLink {
  title: string;
  url: string;
}

export interface GlobalData {
  page: "index" | "results" | "preferences" | "stats" | "info" | "404" | "redirect" | "error";
  instance_name: string;
  version: string;
  git_url: string;
  issue_url: string;
  donation_url: string;
  enable_metrics: boolean;
  public_instances_url: string;
  privacypolicy_url: string;
  contact_url: string;
  custom_links: CustomLink[];
  search_formats: string[];
  categories_as_tabs: string[];
  categories: string[];
  default_category: string;
  locales: LocaleInfo[];
  language: string;
  safesearch: 0 | 1 | 2;
  method: "GET" | "POST";
  theme: string;
  theme_style: "auto" | "light" | "dark" | "black";
  search_on_category_select: boolean;
  results_on_new_tab: boolean;
  url_formatting: "pretty" | "full" | "host";
  favicon_resolver: string;
  doi_resolver: string;
  cache_url: string;
  locale: string;
  about_url: string;
  search_syntax_url: string;
  rtl: boolean;
}

// ------------------------------------------------------------------ results

export interface ResultItem {
  template: string;
  url: string;
  title_html: string;
  title_text: string;
  content_html: string;
  content_text: string;
  engines: string[];
  category: string;
  priority: string;
  /** relevance score from the backend: sum of engine weight / position */
  score?: number;

  netloc?: string;
  favicon?: string;
  pretty_url?: string[];
  published_date?: string;
  length_display?: string;
  length_seconds?: number;
  views?: string;
  author?: string;
  metadata?: string;
  img_src?: string;
  thumbnail?: string;
  iframe_src?: string;
  audio_src?: string;
  open_group?: boolean;
  close_group?: boolean;

  // images.html
  thumbnail_src?: string;
  resolution?: string;
  img_format?: string;
  source?: string;
  filesize?: string;
  formats?: Array<{ url: string; label: string }>;

  // torrent.html
  magnetlink?: string;
  torrentfile?: string;
  seed?: number;
  leech?: number;
  files?: number;

  // map.html
  address?: Partial<{
    name: string;
    road: string;
    house_number: string;
    postcode: string;
    locality: string;
    country: string;
    country_code: string;
  }>;
  map_links?: Array<{ label: string; url: string }>;
  data?: Array<{ label: string; value: string }>;
  boundingbox?: number[];
  longitude?: string;
  latitude?: string;
  geojson?: unknown;

  // paper.html
  comments?: string;
  tags?: string[];
  paper_type?: string;
  authors?: string[];
  editor?: string;
  publisher?: string;
  journal?: string;
  volume?: string;
  number?: string;
  pages?: string;
  doi?: string;
  issn?: string[];
  isbn?: string[];
  pdf_url?: string;
  html_url?: string;

  // packages.html
  package_name?: string;
  version?: string;
  maintainer?: string;
  popularity?: string;
  license_name?: string;
  license_url?: string;
  homepage?: string;
  source_code_url?: string;
  project_links?: Record<string, string>;

  // code.html
  repository?: string;
  filename?: string;
  code_html?: string;

  // file.html
  abstract_html?: string;
  size?: string;
  time?: string;
  mimetype?: string;
  embedded?: string;
  mtype?: string;
  subtype?: string;

  // keyvalue.html
  caption?: string;
  key_title?: string;
  value_title?: string;
  kvmap?: Record<string, unknown>;

  // products.html
  price?: string;
  shipping?: string;
  source_country?: string;
}

interface SuggestionItem {
  q: string;
  title: string;
}

interface TranslationItem {
  text: string;
  transliteration: string;
  examples: string[];
  definitions: string[];
  synonyms: string[];
}

/** One convertible unit of the unit-converter's dimension (same SI unit).
    Special (callable) converters — °C / °F / Bft — carry no factor and are
    implemented client-side. */
export interface UnitEntry {
  symbol: string;
  /** multiplier to the dimension's SI unit */
  to_si?: number;
  special?: boolean;
}

/** Structured payload of the special-query answers (see
    searx/plugins/{hash_plugin,self_info,time_zone,unit_converter,tor_check}.py
    and searx/answerers/{random,statistics}.py). */
export type LegacyAnswerData =
  | { kind: "hash"; algo: string; digest: string }
  | { kind: "stats"; func: string; args: string; result: string }
  | { kind: "time"; zone?: string; time: string; abbr?: string }
  | { kind: "self"; label: string; value: string }
  | { kind: "value"; value: string; swatch?: string }
  | {
      kind: "unit_conversion";
      from_value: string;
      from_unit: string;
      to_value: string;
      to_unit: string;
      units: UnitEntry[];
    }
  | { kind: "tor_check"; status: "error" | "not_tor" | "using_tor"; ip?: string; nodes?: string };

export interface WeatherItem {
  summary: string;
  symbol: string;
  location_name: string;
  /** raw upstream condition id ("light rain showers") — localized client-side */
  condition: string;
  /** temperature in °C — trend chart and daily hi/lo */
  temp_c: number;
  /** temperature in °F — small secondary readout in the hero */
  temp_f: number;
  /** location-timezone ISO instant — hourly slots only */
  datetime_iso?: string;
  /** IANA timezone of the location — client-side date/time formatting */
  timezone?: string;
  /** ISO date (YYYY-MM-DD) — hourly slots only, groups the daily strip */
  date_iso?: string;
  hour?: number;
  /** feels-like temperature in °C */
  feels_like?: number;
  wind?: string;
  /** wind speed in km/h */
  wind_speed?: number;
  /** pressure in hPa */
  pressure?: number;
  /** relative humidity in % */
  humidity?: number;
}

export type AnswerData =
  | {
      template: "answer/legacy.html";
      answer: string;
      /** upstream answer engine tag ("plugin: self_info" …); empty when the
          answer has no engine */
      engine: string;
      url: string;
      /** structured payload emitted by the special-query plugins (hash,
          statistics, time zone, self-info, random); themes render from this
          instead of parsing the localized *answer* text */
      data?: LegacyAnswerData;
    }
  | {
      template: "answer/translations.html";
      engine: string;
      url: string;
      translations: TranslationItem[];
    }
  | {
      template: "answer/weather.html";
      engine: string;
      service: string;
      url: string;
      current: WeatherItem;
      forecasts: WeatherItem[];
    }
  | {
      template: "answer/stock.html";
      answer: string;
      engine: string;
      url: string;
      /** quote payload from the stock_quote plugin (eastmoney): the sparkline
          series is intraday 5-minute closes, newest last */
      data: StockAnswerPayload;
    };

export interface StockAnswerPayload {
  kind: "stock";
  symbol: string;
  name: string;
  /** human market label from the data source (美股 / 沪深A股 / 港股 ...) */
  market: string;
  /** exchange acronym from the data source (NASDAQ / SH / ...) */
  exchange: string;
  currency: string;
  price: number;
  previous_close: number;
  change: number;
  change_percent: number;
  open: number | null;
  high: number | null;
  low: number | null;
  /** trailing P/E; null when the source does not compute it (e.g. US) */
  pe: number | null;
  /** total market cap in the listing currency */
  market_cap: number | null;
  week52_high: number | null;
  week52_low: number | null;
  avg_volume: number | null;
  as_of_date: string;
  as_of_time: string;
  /** close series per range key (1D/5D/1M/YTD/1Y/5Y/MAX), oldest first */
  ranges: Record<string, StockSeries>;
  /** first/last bar labels per range key, for the chart x axis */
  range_bounds: Record<string, [string, string]>;
}

export interface StockSeries {
  /** raw bar labels from the source ("2026-09-16 09:35" / "2026-09-16") */
  labels: string[];
  /** per bar: [open, high, low, close, volume] */
  candles: Array<[number, number, number, number, number]>;
}

export interface InfoboxData {
  title: string;
  content_html: string;
  img_src: string;
  attributes?: Array<{ label: string; value: string; image_src: string; image_alt: string }>;
  urls?: Array<{ title: string; url: string }>;
  related_topics?: Array<{ name: string; suggestions: string[] }>;
}

export interface SearchPageData {
  globals: GlobalData;
  q: string;
  selected_categories: string[];
  pageno: number;
  time_range: string;
  suggestions: SuggestionItem[];
  corrections: SuggestionItem[];
  answers: AnswerData[];
  infoboxes: InfoboxData[];
  results: ResultItem[];
  engine_data: Record<string, Record<string, string>>;
  paging: boolean;
  unresponsive_engines: Array<[string, string]>;
  timings: Array<{ name: string; time: number }>;
  max_response_time: number | null;
  timeout_limit: string;
  current_language: string;
  search_language: string;
  only_template: string;
  /** true in the first-stage payload of a streamed search page: the engines
      are still running, the real payload arrives through #page-data later
      (the stream pushes it, the client never re-fetches) */
  pending?: boolean;
}

// -------------------------------------------------------------- preferences

export interface EngineEntry {
  name: string;
  shortcut: string;
  categories: string[];
  language: string;
  enable_http: boolean;
  weight: number;
  timeout: number;
  website: string;
  wikidata_id: string;
  disabled: boolean;
  stats_time: number | null;
  stats_rate80: number | null;
  stats_rate95: number | null;
  stats_result_count: number;
  warn_timeout: boolean;
  reliability: number | null;
  errors: string[];
  supports_safesearch: boolean;
  supports_time_range: boolean;
}

interface EngineGroup {
  group: string;
  group_bang: string;
  engines: EngineEntry[];
}

interface EngineTab {
  category: string;
  is_default: boolean;
  groups: EngineGroup[];
}

interface PluginInfo {
  id: string;
  name: string;
  description: string;
  section: string;
  enabled: boolean;
  keywords: string[];
  examples: string[];
  plugin: boolean;
}

export interface PreferencesPageData {
  globals: GlobalData;
  current_locale: string;
  locales: Record<string, string>;
  kv: {
    categories: string[];
    language: string;
    locale: string;
    autocomplete: string;
    favicon_resolver: string;
    safesearch: 0 | 1 | 2;
    theme: string;
    simple_style: string;
    center_alignment: boolean;
    results_on_new_tab: boolean;
    search_on_category_select: boolean;
    hotkeys: string;
    url_formatting: string;
    method: "GET" | "POST";
    image_proxy: boolean;
    query_in_title: boolean;
    doi_resolver: string;
    tokens: string;
  };
  autocomplete_backends: string[];
  favicon_resolver_names: string[];
  themes: string[];
  doi_resolvers: Record<string, string>;
  locked_preferences: string[];
  preferences_url_params: string;
  cookies: Array<{ name: string; value: string }>;
  answerers: Array<{ keywords: string[]; name: string; description: string; examples: string[]; plugin: boolean }>;
  plugins: PluginInfo[];
  engine_tabs: EngineTab[];
}

// -------------------------------------------------------------------- stats

export interface EngineStat {
  name: string;
  score: number | null;
  score_per_result: number | null;
  result_count: number | null;
  total: number | null;
  http: number | null;
  processing: number | null;
  total_p80: number | null;
  http_p80: number | null;
  processing_p80: number | null;
  total_p95: number | null;
  http_p95: number | null;
  processing_p95: number | null;
  reliability: number | null;
}

interface EngineError {
  secondary: boolean;
  exception_classname: string;
  log_message: string;
  percentage: number;
  log_parameters: string[];
  filename: string;
  line_no: number;
  function: string;
  code: string;
}

export interface StatsPageData {
  globals: GlobalData;
  sort_order: string;
  selected_engine_name: string;
  max_result_count: number;
  max_time: number;
  engines: EngineStat[];
  errors: EngineError[];
}

// --------------------------------------------------------------------- info

export interface InfoPageData {
  globals: GlobalData;
  active_pagename: string;
  active_title: string;
  active_html: string;
  pages: Array<{ pagename: string; locale: string; title: string }>;
}

// -------------------------------------------------------------- page union

export interface BasicPageData {
  globals: GlobalData;
}

/** Boot payload of the streamed search page when the search turned out to be
    a redirect (external bang `!!w`, instant-redirect preference): main.tsx
    navigates to `url` instead of rendering the app. */
export interface RedirectPageData {
  globals: GlobalData;
  url: string;
}

/** Boot payload of the streamed search page when the engines run failed
    (the HTTP status is already out by then): main.tsx renders a minimal
    error screen with `message` (server-localized). */
export interface ErrorPageData {
  globals: GlobalData;
  message: string;
}

export type AnyPageData =
  | SearchPageData
  | PreferencesPageData
  | StatsPageData
  | InfoPageData
  | RedirectPageData
  | ErrorPageData
  | BasicPageData;

export function isSearchPageData(data: AnyPageData): data is SearchPageData {
  return data.globals.page === "results";
}

export function isPendingSearchData(data: AnyPageData | null): data is SearchPageData {
  return data !== null && data.globals.page === "results" && (data as SearchPageData).pending === true;
}

export function isRedirectPageData(data: AnyPageData): data is RedirectPageData {
  return data.globals.page === "redirect";
}

export function isErrorPageData(data: AnyPageData): data is ErrorPageData {
  return data.globals.page === "error";
}

export function isPreferencesPageData(data: AnyPageData): data is PreferencesPageData {
  return data.globals.page === "preferences";
}

export function isStatsPageData(data: AnyPageData): data is StatsPageData {
  return data.globals.page === "stats";
}

export function isInfoPageData(data: AnyPageData): data is InfoPageData {
  return data.globals.page === "info";
}
