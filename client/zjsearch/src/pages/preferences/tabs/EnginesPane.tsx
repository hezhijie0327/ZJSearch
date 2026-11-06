// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Check, Key, LayoutGrid, X } from "lucide-react";
import { categoryLabel } from "@/lib/categories.ts";
import { useT } from "@/lib/i18n.ts";
import type { PreferencesPageData } from "@/lib/types.ts";
import { Card, CategoryTab, SectionLabel, SettingRow } from "@/pages/preferences/parts.tsx";
import { EngineTable } from "@/pages/preferences/tabs/EngineTable.tsx";
import type { PreferencesForm } from "@/pages/preferences/usePreferencesForm.ts";

/** Engines tab pane: the private-engine tokens up top, then the per-category
    engine tables with the enable/disable-all shortcuts — in the shared
    Card + SectionLabel language of the other tabs. */
export function EnginesPane({
  data,
  form,
  engineTab,
  onEngineTab,
}: {
  data: PreferencesPageData;
  form: PreferencesForm;
  engineTab: number;
  onEngineTab: (index: number) => void;
}) {
  const t = useT();
  const currentEngineTab = data.engine_tabs[engineTab];
  const tabEngineKeys = currentEngineTab
    ? currentEngineTab.groups.flatMap((group) =>
        group.engines.map((engine) => `${engine.name}__${currentEngineTab.category}`),
      )
    : [];
  return (
    <Card>
      <SectionLabel label={t("engines_group_list")} />
      {/* access tokens unlock private engines — kept first so they are found
          without scrolling past the tables */}
      <SettingRow description={t("access_tokens")} icon={<Key className="size-4.5" />} title={t("engine_tokens")}>
        <input
          aria-label={t("engine_tokens")}
          autoComplete="off"
          className="h-9 w-full rounded-xl border border-line bg-surface px-3 text-[13px] transition-colors hover:border-ink-3 sm:w-60"
          onChange={(event) => {
            form.setTokens(event.target.value);
          }}
          spellCheck={false}
          type="text"
          value={form.tokens}
        />
      </SettingRow>
      <SettingRow
        description={t("engines_list_desc")}
        icon={<LayoutGrid className="size-4.5" />}
        title={t("engines_list")}
      >
        {currentEngineTab ? (
          <div className="flex items-center gap-1.5">
            <button
              className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-ok hover:text-ok"
              onClick={() => {
                form.setAllEngines(tabEngineKeys, true);
              }}
              type="button"
            >
              <Check className="size-3.5" />
              {t("enable_all")}
            </button>
            <button
              className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-danger hover:text-danger"
              onClick={() => {
                form.setAllEngines(tabEngineKeys, false);
              }}
              type="button"
            >
              <X className="size-3.5" />
              {t("disable_all")}
            </button>
          </div>
        ) : null}
      </SettingRow>
      <div className="px-5 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
          {data.engine_tabs.map((tabInfo, index) => (
            <CategoryTab
              category={tabInfo.category}
              key={tabInfo.category}
              label={categoryLabel(tabInfo.category, t)}
              onClick={() => {
                onEngineTab(index);
              }}
              selected={index === engineTab}
            />
          ))}
        </div>
      </div>
      {currentEngineTab ? (
        <EngineTable
          enabled={form.engines}
          showMetrics={data.globals.enable_metrics}
          tab={currentEngineTab}
          toggleEngine={form.toggleEngine}
        />
      ) : null}
    </Card>
  );
}
