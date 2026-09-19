// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { AlignCenterVertical, Globe, Languages, Link as LinkIcon, Monitor, Moon, Sun, Tag } from "lucide-react";
import { Fragment } from "react";
import { cap } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import type { ThemeStyle } from "@/lib/theme.ts";
import { applyCenterAlignment, applyThemeStyle } from "@/lib/theme.ts";
import type { PreferencesPageData } from "@/lib/types.ts";
import { Card, SectionLabel, Select, SettingRow, Switch } from "@/pages/preferences/parts.tsx";
import type { PreferencesForm } from "@/pages/preferences/usePreferencesForm.ts";

export function UiTab({
  data,
  form,
  locked,
}: {
  data: PreferencesPageData;
  form: PreferencesForm;
  locked: Set<string>;
}) {
  const t = useT();
  const locales = Object.entries(data.locales).sort((a, b) => a[1].localeCompare(b[1]));
  // grouped like the plugins tab; a group only renders while at least one of
  // its rows survives the locked-preferences filter
  const showLook =
    !locked.has("locale") || !locked.has("theme") || !locked.has("simple_style") || !locked.has("center_alignment");
  const showDisplay = !locked.has("favicon_resolver") || !locked.has("urlformatting") || !locked.has("query_in_title");
  return (
    <Card>
      {showLook ? (
        <Fragment>
          <SectionLabel label={t("ui_group_look")} />
          {!locked.has("locale") ? (
            <SettingRow
              description={t("change_layout_language")}
              icon={<Languages className="size-4.5" />}
              title={t("interface_language")}
            >
              <Select
                ariaLabel={t("interface_language")}
                onChange={form.setLocale}
                options={locales.map(([id, name]) => ({ value: id, label: name }))}
                value={form.locale}
              />
            </SettingRow>
          ) : null}
          {!locked.has("theme") ? (
            <SettingRow description={t("change_layout")} icon={<Monitor className="size-4.5" />} title={t("theme")}>
              <Select
                ariaLabel={t("theme")}
                onChange={form.setTheme}
                options={data.themes.map((name) => ({
                  value: name,
                  label: name === "zjsearch" ? "ZJSearch" : cap(name),
                }))}
                value={form.theme}
              />
            </SettingRow>
          ) : null}
          {!locked.has("simple_style") ? (
            <SettingRow description={t("choose_auto")} icon={<Sun className="size-4.5" />} title={t("theme_style")}>
              <div className="inline-flex rounded-xl border border-line bg-surface p-0.5">
                {(
                  [
                    ["auto", cap(t("auto")), <Sun className="size-3.5" key="a" />],
                    ["light", cap(t("light")), <Sun className="size-3.5" key="l" />],
                    ["dark", cap(t("dark")), <Moon className="size-3.5" key="d" />],
                    ["black", cap(t("black")), <Moon className="size-3.5" key="b" />],
                  ] as const
                ).map(([value, label, icon]) => (
                  <button
                    aria-pressed={form.themeStyle === value}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
                      form.themeStyle === value
                        ? "bg-accent-strong font-medium text-accent-contrast"
                        : "text-ink-2 hover:text-ink"
                    }`}
                    key={value}
                    onClick={() => {
                      form.setThemeStyle(value);
                      applyThemeStyle(value as ThemeStyle);
                    }}
                    title={label}
                    type="button"
                  >
                    {icon}
                    <span className="hidden md:inline">{label}</span>
                  </button>
                ))}
              </div>
            </SettingRow>
          ) : null}
          {!locked.has("center_alignment") ? (
            <SettingRow
              description={t("center_alignment_desc")}
              icon={<AlignCenterVertical className="size-4.5" />}
              title={t("center_alignment")}
            >
              <Switch
                checked={form.centerAlignment}
                label={t("center_alignment")}
                onChange={(value) => {
                  form.setCenterAlignment(value);
                  applyCenterAlignment(value);
                }}
              />
            </SettingRow>
          ) : null}
        </Fragment>
      ) : null}
      {showDisplay ? (
        <Fragment>
          <SectionLabel label={t("ui_group_display")} />
          {!locked.has("favicon_resolver") ? (
            <SettingRow
              description={t("display_favicons")}
              icon={<Globe className="size-4.5" />}
              title={t("favicon_resolver")}
            >
              <Select
                ariaLabel={t("favicon_resolver")}
                onChange={form.setFaviconResolver}
                options={[
                  { value: "", label: "-" },
                  ...data.favicon_resolver_names.map((name) => ({ value: name, label: name })),
                ]}
                value={form.faviconResolver}
              />
            </SettingRow>
          ) : null}
          {!locked.has("urlformatting") ? (
            <SettingRow
              description={t("change_url_formatting")}
              icon={<LinkIcon className="size-4.5" />}
              title={t("url_formatting")}
            >
              <Select
                ariaLabel={t("url_formatting")}
                onChange={form.setUrlFormatting}
                options={[
                  { value: "pretty", label: t("pretty") },
                  { value: "full", label: t("full") },
                  { value: "host", label: t("host") },
                ]}
                value={form.urlFormatting}
              />
            </SettingRow>
          ) : null}
          {!locked.has("query_in_title") ? (
            <SettingRow
              description={t("query_in_title_desc")}
              icon={<Tag className="size-4.5" />}
              title={t("query_in_title")}
            >
              <Switch checked={form.queryInTitle} label={t("query_in_title")} onChange={form.setQueryInTitle} />
            </SettingRow>
          ) : null}
        </Fragment>
      ) : null}
    </Card>
  );
}
