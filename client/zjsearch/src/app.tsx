// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Compass, LoaderCircle } from "lucide-react";
import { Suspense } from "react";
import { Link, Shell } from "@/components/Shell.tsx";
import { OverlayProvider } from "@/features/overlay/OverlayProvider.tsx";
import { I18nContext, useT } from "@/lib/i18n.ts";
import { RouterProvider, useRouter } from "@/lib/router.tsx";
import type { ClientSettings } from "@/lib/settings.ts";
import { SettingsContext } from "@/lib/settings.ts";
import type { AnyPageData } from "@/lib/types.ts";
import { isInfoPageData, isPreferencesPageData, isSearchPageData, isStatsPageData } from "@/lib/types.ts";
import { IndexPage } from "@/pages/IndexPage.tsx";
import { InfoPage, PreferencesPage, ResultsPage, StatsPage } from "@/pages/lazyPages.ts";

function Pages() {
  const { data, error } = useRouter();
  const t = useT();

  if (!data) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <p className="text-sm text-ink-2">{error ?? "…"}</p>
      </div>
    );
  }

  const globals = data.globals;

  if (isSearchPageData(data)) {
    // the chunk is pre-warmed on results boots (streamed shell inline import)
    // and by hero-search intent; the fallback only shows on a cold SPA nav
    return (
      <Suspense fallback={<PageFallback />}>
        <ResultsPage data={data} />
      </Suspense>
    );
  }

  if (isPreferencesPageData(data)) {
    return (
      <Suspense fallback={<PageFallback />}>
        <PreferencesPage data={data} />
      </Suspense>
    );
  }
  if (isStatsPageData(data)) {
    return (
      <Suspense fallback={<PageFallback />}>
        <StatsPage data={data} />
      </Suspense>
    );
  }
  if (isInfoPageData(data)) {
    return (
      <Suspense fallback={<PageFallback />}>
        <InfoPage data={data} />
      </Suspense>
    );
  }
  switch (globals.page) {
    case "index":
      return <IndexPage data={data} />;
    default:
      // no top nav on the 404 shell: its links (engine stats, info, instance
      // URLs) are instance details a prober shouldn't get served for free
      return (
        <Shell globals={globals} hideTopNav>
          <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-4 pb-24 text-center animate-fade-up">
            {/* same composition as the results empty state: icon disc,
                heading, muted line, one pill action */}
            <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
              <Compass aria-hidden="true" className="size-7" />
            </span>
            <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">404</h1>
            <p className="mt-1.5 text-sm text-ink-2">{t("page_not_found")}</p>
            <Link
              className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-accent-strong px-4 py-2 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
              href="/"
            >
              {t("back_to_search")}
            </Link>
          </main>
        </Shell>
      );
  }
}

function PageFallback() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <LoaderCircle className="size-6 animate-spin-slow text-ink-3" />
    </div>
  );
}

/** Which payloads can open as a drawer panel (URL unchanged). Panel chrome
    and plumbing live in features/overlay; the page selection stays here
    where the routing lives. Returns null for non-panel-able pages. */
function renderOverlayPanel(data: AnyPageData, hint?: string) {
  if (isPreferencesPageData(data)) {
    return <PreferencesPage data={data} embedded />;
  }
  if (isStatsPageData(data)) {
    return <StatsPage data={data} embedded />;
  }
  if (isInfoPageData(data)) {
    return <InfoPage data={data} embedded initialPagename={hint} />;
  }
  return null;
}

export function App({ initialData, settings }: { initialData: AnyPageData | null; settings: ClientSettings }) {
  const locale = initialData?.globals.locale ?? "en";
  return (
    <SettingsContext.Provider value={settings}>
      <I18nContext.Provider value={locale}>
        <RouterProvider initialData={initialData}>
          <OverlayProvider panels={{ renderPage: renderOverlayPanel }}>
            <Pages />
          </OverlayProvider>
        </RouterProvider>
      </I18nContext.Provider>
    </SettingsContext.Provider>
  );
}
