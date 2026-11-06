// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Compass, Search } from "lucide-react";
import type { ReactNode } from "react";
import { Suspense, useEffect } from "react";
import {
  BootActions,
  BootDocTitle,
  BootPrefsRows,
  BootProse,
  BootRowsCard,
  BootRunBody,
  BootSearchCard,
  BootStatsTable,
  BootTabCard,
} from "@/components/BootGhosts.tsx";
import { Link, Shell } from "@/components/Shell.tsx";
import { Tape } from "@/components/Tape.tsx";
import { OverlayProvider } from "@/features/overlay/OverlayProvider.tsx";
import { setDateFormatLocale } from "@/lib/format.ts";
import { I18nContext, themeLocaleTag, useT } from "@/lib/i18n.ts";
import { RouterProvider, useRouter } from "@/lib/router.tsx";
import type { ClientSettings } from "@/lib/settings.ts";
import { SettingsContext } from "@/lib/settings.ts";
import { PAPER_STRIP } from "@/lib/styles.ts";
import type { AnyPageData } from "@/lib/types.ts";
import {
  isAiOverviewDebugPageData,
  isAiThreadPageData,
  isInfoPageData,
  isKnowledgePageData,
  isPreferencesPageData,
  isSearchPageData,
  isStatsPageData,
} from "@/lib/types.ts";
import { IndexPage } from "@/pages/IndexPage.tsx";
import {
  AiOverviewDebugPage,
  AiThreadPage,
  InfoPage,
  KnowledgePage,
  PreferencesPage,
  ResultsPage,
  StatsPage,
} from "@/pages/lazyPages.ts";

function Pages() {
  const { data, error } = useRouter();
  const t = useT();

  if (!data) {
    // an error here is terminal (the payload is gone); a payload-less boot
    // with no error still owes the user a shape, not a lone ellipsis
    return error ? (
      <div className="grid min-h-dvh place-items-center">
        <p className="text-sm text-ink-2">{error}</p>
      </div>
    ) : (
      <PageFallback shape="doc" />
    );
  }

  const globals = data.globals;

  if (isSearchPageData(data)) {
    // the chunk is pre-warmed on results boots (streamed shell inline import)
    // and by hero-search intent; the fallback only shows on a cold SPA nav
    return (
      <Suspense fallback={<PageFallback q={data.q} shape={data.globals.ai_mode === true ? "ai" : "classic"} />}>
        <ResultsPage data={data} />
      </Suspense>
    );
  }

  if (isPreferencesPageData(data)) {
    return (
      <Suspense fallback={<PageFallback brand={globals.instance_name} shape="prefs" />}>
        <PreferencesPage data={data} />
      </Suspense>
    );
  }
  if (isStatsPageData(data)) {
    return (
      <Suspense fallback={<PageFallback brand={globals.instance_name} shape="stats" />}>
        <StatsPage data={data} />
      </Suspense>
    );
  }
  if (isInfoPageData(data)) {
    return (
      <Suspense fallback={<PageFallback brand={globals.instance_name} shape="doc" />}>
        <InfoPage data={data} />
      </Suspense>
    );
  }
  if (isAiThreadPageData(data)) {
    return (
      <Suspense fallback={<PageFallback brand={globals.instance_name} shape="thread" />}>
        <AiThreadPage data={data} />
      </Suspense>
    );
  }
  if (isAiOverviewDebugPageData(data)) {
    return (
      <Suspense fallback={<PageFallback brand={globals.instance_name} shape="doc" />}>
        <AiOverviewDebugPage data={data} />
      </Suspense>
    );
  }
  if (isKnowledgePageData(data)) {
    return (
      <Suspense fallback={<PageFallback brand={globals.instance_name} shape="knowledge" />}>
        <KnowledgePage data={data} />
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
          <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-4 pb-24 animate-fade-up">
            {/* same composition as the results empty state — icon disc,
                heading, muted line, one action — on the family paper ground
                (torn note + two tape corners, tape as SIBLING of the clipped
                note; the micro-tilt is fixed, never random) */}
            <div className="relative w-full max-w-md -rotate-[0.35deg]">
              <Tape className="w-24 bg-accent-soft/80" corner="start" seed="setup-a" />
              <Tape className="w-20 bg-accent-soft/60" corner="end" seed="setup-b" />
              <div className="paper-note px-6 py-10 text-center">
                <span className="mx-auto grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
                  <Compass aria-hidden="true" className="size-7" />
                </span>
                <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">404</h1>
                <p className="mt-1.5 text-sm text-ink-2">{t("page_not_found")}</p>
                <Link
                  className={`${PAPER_STRIP} mt-5 -rotate-1 px-4 py-2 text-accent-contrast [--strip:var(--accent-strong)] hover:[--strip:var(--accent-strong-hover)]`}
                  href="/"
                >
                  {t("back_to_search")}
                </Link>
              </div>
            </div>
          </main>
        </Shell>
      );
  }
}

/** The lazy pages' load ghost: the lazy chunks (results / preferences /
    stats / info / thread / knowledge) render NOTHING around them -- Shell
    included -- so a cold chunk fetch used to read as a blank viewport with
    a spinner.  Each page family now boots into ITS OWN shape, mirroring
    skeleton.html's boot shapes one-to-one (the geometry lives in boot.css's
    `.zjs-boot*` family — server shell and this ghost share it, so the
    static skeleton → ghost → real page chain never changes shape).
    Generic markup only: no page chunk is pulled into the eager graph. */
function PageFallback({
  brand,
  q,
  shape,
}: {
  /** the instance name renders as the real brand text when known */
  brand?: string;
  shape: "classic" | "ai" | "thread" | "knowledge" | "doc" | "prefs" | "stats";
  /** the search shapes show the real query in the header pill */
  q?: string;
}) {
  const brandMark = brand ? (
    <span className="zjs-boot-brand">
      {brand}
      <span>.</span>
    </span>
  ) : (
    <span className="zjs-skeleton zjs-boot-brand-bar" />
  );
  let body: ReactNode;
  if (shape === "ai" || shape === "thread") {
    body = <BootRunBody title={shape === "ai" ? q : undefined} />;
  } else if (shape === "knowledge") {
    body = (
      <>
        <div className="zjs-boot-k-head">
          <span className="zjs-skeleton zjs-boot-k-icon" />
          <span className="zjs-skeleton zjs-boot-k-title" />
        </div>
        <span className="zjs-skeleton zjs-boot-k-sub" />
        <BootTabCard tabs={6} />
        <BootSearchCard />
        <BootRowsCard />
      </>
    );
  } else if (shape === "prefs") {
    body = (
      <>
        <BootDocTitle />
        <BootTabCard />
        <BootPrefsRows />
      </>
    );
  } else if (shape === "stats") {
    body = (
      <>
        <BootDocTitle />
        <BootStatsTable />
      </>
    );
  } else if (shape === "doc") {
    body = (
      <>
        <BootDocTitle />
        <BootProse />
      </>
    );
  } else {
    // classic: tabs / filters / the text-card stack / the width-only rail
    body = (
      <div className="zjs-boot-body">
        <div className="zjs-boot-main">
          <div aria-hidden="true" className="zjs-boot-tabs">
            <span className="zjs-skeleton zjs-boot-tab is-selected" />
            <span className="zjs-skeleton zjs-boot-tab" />
            <span className="zjs-skeleton zjs-boot-tab" />
            <span className="zjs-skeleton zjs-boot-tab" />
            <span className="zjs-skeleton zjs-boot-tab" />
          </div>
          <div aria-hidden="true" className="zjs-boot-filters">
            <span className="zjs-skeleton zjs-boot-filter" />
            <span className="zjs-skeleton zjs-boot-filter" />
            <span className="zjs-skeleton zjs-boot-filter" />
          </div>
          <div aria-hidden="true" className="zjs-boot-cards">
            {[0, 1, 2, 3, 4].map((i) => (
              <div className="zjs-boot-card" key={i}>
                <span className="zjs-skeleton zjs-boot-w40" />
                <span className="zjs-skeleton zjs-boot-title" />
                <span className="zjs-skeleton zjs-boot-line" />
                <span className="zjs-skeleton zjs-boot-line2" />
                <span className="zjs-skeleton zjs-boot-pill" />
              </div>
            ))}
          </div>
        </div>
        <div aria-hidden="true" className="zjs-boot-side" />
      </div>
    );
  }
  return (
    <div aria-busy="true" className={`zjs-boot is-${shape}`}>
      {shape === "classic" || shape === "ai" ? (
        <div className="zjs-boot-shell">
          <div className="zjs-boot-top">
            {brandMark}
            <div className="zjs-boot-q">
              <span className="zjs-boot-q-text">{q}</span>
              <span aria-hidden="true" className="zjs-boot-submit">
                <Search aria-hidden="true" className="size-4.5" />
              </span>
            </div>
            <BootActions />
          </div>
          {body}
        </div>
      ) : (
        <>
          <div aria-hidden="true" className="zjs-boot-nav">
            {brandMark}
            <BootActions />
          </div>
          <div className="zjs-boot-shell">{body}</div>
        </>
      )}
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
  if (isKnowledgePageData(data)) {
    return <KnowledgePage data={data} embedded />;
  }
  return null;
}

export function App({ initialData, settings }: { initialData: AnyPageData | null; settings: ClientSettings }) {
  const locale = initialData?.globals.locale ?? "en";
  // the dates speak the UI's language (formatDate's formatters rebuild
  // once per change)
  useEffect(() => {
    setDateFormatLocale(themeLocaleTag(locale));
  }, [locale]);
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
