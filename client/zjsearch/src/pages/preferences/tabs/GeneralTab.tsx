// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  ArrowLeftRight,
  Book,
  ExternalLink,
  Image,
  Keyboard,
  Languages,
  LayoutGrid,
  MousePointerClick,
  Search,
  Shield,
} from "lucide-react";
import { Fragment } from "react";
import { categoryLabel } from "@/lib/categories.ts";
import { languageOptions, useT } from "@/lib/i18n.ts";
import type { PreferencesPageData } from "@/lib/types.ts";
import { Card, CategoryTab, SectionLabel, Select, SettingRow, Switch } from "@/pages/preferences/parts.tsx";
import type { PreferencesForm } from "@/pages/preferences/usePreferencesForm.ts";

export function GeneralTab({
  data,
  form,
  locked,
}: {
  data: PreferencesPageData;
  form: PreferencesForm;
  locked: Set<string>;
}) {
  const t = useT();
  const globals = data.globals;
  // grouped like the plugins tab; a group only renders while at least one of
  // its rows survives the locked-preferences filter
  const showSearch =
    !locked.has("categories") ||
    !locked.has("search_on_category_select") ||
    !locked.has("language") ||
    !locked.has("safesearch");
  const showInput = !locked.has("autocomplete") || !locked.has("hotkeys");
  const showRequests =
    !locked.has("results_on_new_tab") ||
    !locked.has("method") ||
    !locked.has("image_proxy") ||
    !locked.has("doi_resolver");
  return (
    <Card>
      {showSearch ? (
        <Fragment>
          <SectionLabel label={t("general_group_search")} />
          {!locked.has("categories") ? (
            <SettingRow icon={<LayoutGrid className="size-4.5" />} stacked title={t("default_categories")}>
              <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                {/* globals.categories = tabs filtered to categories with enabled
                    engines — mirrors upstream simple preferences behaviour */}
                {globals.categories.map((category) => (
                  <CategoryTab
                    category={category}
                    key={category}
                    label={categoryLabel(category, t)}
                    onClick={() => {
                      form.setCategories((prev) =>
                        prev.includes(category) ? prev.filter((item) => item !== category) : [...prev, category],
                      );
                    }}
                    selected={form.categories.includes(category)}
                  />
                ))}
              </div>
            </SettingRow>
          ) : null}
          {!locked.has("search_on_category_select") ? (
            <SettingRow
              description={t("search_on_category_select_desc")}
              icon={<MousePointerClick className="size-4.5" />}
              title={t("search_on_category_select")}
            >
              <Switch
                checked={form.searchOnCategorySelect}
                label={t("search_on_category_select")}
                onChange={form.setSearchOnCategorySelect}
              />
            </SettingRow>
          ) : null}
          {!locked.has("language") ? (
            <SettingRow
              description={t("what_language")}
              icon={<Languages className="size-4.5" />}
              title={t("search_language")}
            >
              <Select
                ariaLabel={t("search_language")}
                onChange={form.setLanguage}
                options={languageOptions(globals.locales, t)}
                value={form.language}
              />
            </SettingRow>
          ) : null}
          {!locked.has("safesearch") ? (
            <SettingRow
              description={t("filter_content")}
              icon={<Shield className="size-4.5" />}
              title={t("safesearch")}
            >
              <Select
                ariaLabel={t("safesearch")}
                onChange={form.setSafesearch}
                options={[
                  { value: "2", label: t("strict") },
                  { value: "1", label: t("moderate") },
                  { value: "0", label: t("none") },
                ]}
                value={form.safesearch}
              />
            </SettingRow>
          ) : null}
        </Fragment>
      ) : null}
      {showInput ? (
        <Fragment>
          <SectionLabel label={t("general_group_input")} />
          {!locked.has("autocomplete") ? (
            <SettingRow
              description={t("show_queries_as_you_type")}
              icon={<Search className="size-4.5" />}
              title={t("autocomplete")}
            >
              <Select
                ariaLabel={t("autocomplete")}
                onChange={form.setAutocomplete}
                options={[
                  { value: "", label: "-" },
                  ...data.autocomplete_backends.map((backend) => ({ value: backend, label: backend })),
                ]}
                value={form.autocomplete}
              />
            </SettingRow>
          ) : null}
          {!locked.has("hotkeys") ? (
            <SettingRow description={t("hotkeys_desc")} icon={<Keyboard className="size-4.5" />} title={t("hotkeys")}>
              <Select
                ariaLabel={t("hotkeys")}
                onChange={form.setHotkeys}
                options={[
                  { value: "default", label: "SearXNG" },
                  { value: "vim", label: t("hotkeys_vim") },
                ]}
                value={form.hotkeys}
              />
            </SettingRow>
          ) : null}
        </Fragment>
      ) : null}
      {showRequests ? (
        <Fragment>
          <SectionLabel label={t("general_group_requests")} />
          {!locked.has("results_on_new_tab") ? (
            <SettingRow
              description={t("open_result_new_tabs")}
              icon={<ExternalLink className="size-4.5" />}
              title={t("results_in_new_tabs")}
            >
              <Switch
                checked={form.resultsOnNewTab}
                label={t("results_in_new_tabs")}
                onChange={form.setResultsOnNewTab}
              />
            </SettingRow>
          ) : null}
          {!locked.has("method") ? (
            <SettingRow
              description={t("change_forms_submit")}
              icon={<ArrowLeftRight className="size-4.5" />}
              title={t("http_method")}
            >
              <div className="inline-flex rounded-xl border border-line bg-surface p-0.5">
                {(["POST", "GET"] as const).map((value) => (
                  <button
                    aria-pressed={form.method === value}
                    className={`rounded-lg px-4 py-1.5 text-[13px] transition-colors ${
                      form.method === value
                        ? "bg-accent-strong font-medium text-accent-contrast"
                        : "text-ink-2 hover:text-ink"
                    }`}
                    key={value}
                    onClick={() => {
                      form.setMethod(value);
                    }}
                    type="button"
                  >
                    {value}
                  </button>
                ))}
              </div>
            </SettingRow>
          ) : null}
          {!locked.has("image_proxy") ? (
            <SettingRow description={t("proxy_images")} icon={<Image className="size-4.5" />} title={t("image_proxy")}>
              <Switch checked={form.imageProxy} label={t("image_proxy")} onChange={form.setImageProxy} />
            </SettingRow>
          ) : null}
          {!locked.has("doi_resolver") ? (
            <SettingRow
              description={t("select_doi_service")}
              icon={<Book className="size-4.5" />}
              title={t("open_access_doi_resolver")}
            >
              <Select
                ariaLabel={t("open_access_doi_resolver")}
                onChange={form.setDoiResolver}
                options={Object.entries(data.doi_resolvers).map(([name]) => ({ value: name, label: name }))}
                value={form.doiResolver}
              />
            </SettingRow>
          ) : null}
        </Fragment>
      ) : null}
    </Card>
  );
}
