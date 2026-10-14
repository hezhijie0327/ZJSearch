// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { AlertTriangle, Cookie, LayoutGrid, Palette, Puzzle, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, Shell } from "@/components/Shell.tsx";
import { useT } from "@/lib/i18n.ts";
import { SEGMENT, SEGMENT_ACTIVE, SEGMENT_IDLE } from "@/lib/styles.ts";
import { flashToast } from "@/lib/toast.ts";
import type { PreferencesPageData } from "@/lib/types.ts";
import { CookieTab } from "@/pages/preferences/tabs/CookieTab.tsx";
import { EnginesPane } from "@/pages/preferences/tabs/EnginesPane.tsx";
import { GeneralTab } from "@/pages/preferences/tabs/GeneralTab.tsx";
import { PluginsTab } from "@/pages/preferences/tabs/PluginsTab.tsx";
import { UiTab } from "@/pages/preferences/tabs/UiTab.tsx";
import { usePreferencesForm } from "@/pages/preferences/usePreferencesForm.ts";

type PrefsTab = "general" | "ui" | "engines" | "plugins" | "cookies";

export function PreferencesPage({ data, embedded = false }: { data: PreferencesPageData; embedded?: boolean }) {
  const t = useT();
  const globals = data.globals;
  const form = usePreferencesForm(data);
  const locked = useMemo(() => new Set(data.locked_preferences), [data.locked_preferences]);

  const [tab, setTab] = useState<PrefsTab>("general");
  const [engineTab, setEngineTab] = useState(0);

  // transient save confirmation in the shared floating-toast language —
  // nothing in flow, so its appearance never shifts the form
  const savedAt = form.savedAt;
  useEffect(() => {
    if (savedAt > 0) {
      flashToast(t("saved"), { tone: "ok", timeoutMs: 2000 });
    }
  }, [savedAt, t]);

  const isPreview = new URLSearchParams(window.location.search).get("preferences_preview_only") === "true";

  const tabs = [
    { id: "general", label: t("general"), icon: <SlidersHorizontal className="size-3.5" /> },
    { id: "ui", label: t("user_interface"), icon: <Palette className="size-3.5" /> },
    { id: "plugins", label: t("plugins"), icon: <Puzzle className="size-3.5" /> },
    { id: "engines", label: t("engines"), icon: <LayoutGrid className="size-3.5" /> },
    { id: "cookies", label: t("cookies"), icon: <Cookie className="size-3.5" /> },
  ] as const;

  return (
    <Shell embedded={embedded} globals={globals}>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 pb-20 sm:px-6">
        {!embedded ? (
          <div className="flex items-center py-6">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{t("preferences")}</h1>
          </div>
        ) : null}

        {isPreview ? (
          <div className="mb-4 flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-ink-2 animate-fade-up">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <p>{t("preview_banner")}</p>
              <ul className="mt-1.5 list-disc ps-5">
                <li>{t("press_save_to_copy")}</li>
                <li>
                  {t("view_browser_prefs")}{" "}
                  <Link className="text-accent hover:underline" href="/preferences">
                    /preferences
                  </Link>
                </li>
              </ul>
            </div>
          </div>
        ) : null}

        <div className="mb-6 flex flex-wrap gap-1.5 rounded-2xl border border-line bg-surface p-2" role="tablist">
          {tabs.map((item) => (
            <button
              aria-controls={`prefs-panel-${item.id}`}
              aria-selected={tab === item.id}
              className={`${SEGMENT} flex-1 ${tab === item.id ? SEGMENT_ACTIVE : SEGMENT_IDLE}`}
              id={`prefs-tab-${item.id}`}
              key={item.id}
              onClick={() => {
                setTab(item.id);
              }}
              role="tab"
              type="button"
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <div
          aria-labelledby={`prefs-tab-${tab}`}
          className="animate-fade-in"
          id={`prefs-panel-${tab}`}
          key={tab}
          role="tabpanel"
        >
          {tab === "general" ? <GeneralTab data={data} form={form} locked={locked} /> : null}
          {tab === "ui" ? <UiTab data={data} form={form} locked={locked} /> : null}
          {tab === "engines" ? (
            <EnginesPane data={data} engineTab={engineTab} form={form} onEngineTab={setEngineTab} />
          ) : null}
          {tab === "plugins" ? <PluginsTab data={data} form={form} /> : null}
          {tab === "cookies" ? <CookieTab data={data} form={form} /> : null}
        </div>
      </main>
    </Shell>
  );
}
