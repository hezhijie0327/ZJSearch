// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useEffect, useMemo, useRef, useState } from "react";
import { BackToTop } from "@/components/BackToTop.tsx";
import { HelpModal } from "@/components/HelpModal.tsx";
import { SearchBox } from "@/components/SearchBox.tsx";
import { CategoryTabs, type FilterValues, SearchFilters } from "@/components/SearchControls.tsx";
import { HeaderActions, Link, Shell } from "@/components/Shell.tsx";
import { tryEvaluateExpression } from "@/features/calculator.ts";
import { focusSearchInput, useHotkeys } from "@/features/hotkeys.ts";
import { Answers } from "@/features/results/answers/Answers.tsx";
import { CalculatorAnswer } from "@/features/results/answers/Calculator.tsx";
import { CacheUrlProvider } from "@/features/results/CacheUrlProvider.tsx";
import { ResultSkeleton } from "@/features/results/cardParts.tsx";
import { DebugPanels } from "@/features/results/DebugPanels.tsx";
import { Corrections, NoResults } from "@/features/results/EmptyStates.tsx";
import { InfiniteScrollSentinel } from "@/features/results/InfiniteScroll.tsx";
import { Infobox } from "@/features/results/Infobox.tsx";
import { detectResultsLayout } from "@/features/results/layout.ts";
import { Pagination } from "@/features/results/Pagination.tsx";
import { ResultsView } from "@/features/results/ResultsView.tsx";
import { Sidebar } from "@/features/results/Sidebar.tsx";
import { SuggestionsBox } from "@/features/results/SuggestionsBox.tsx";
import { useCopyToast } from "@/lib/clipboard.ts";
import { readCookie } from "@/lib/cookies.ts";
import { useT } from "@/lib/i18n.ts";
import { scrollBehavior } from "@/lib/motion.ts";
import { useRouter } from "@/lib/router.tsx";
import { fetchSearchPage, parseSearchUrl, shareableSearchUrl } from "@/lib/searchParams.ts";
import { useHasPlugin, useSettings } from "@/lib/settings.ts";
import type { ResultItem, SearchPageData } from "@/lib/types.ts";

export function ResultsPage({ data }: { data: SearchPageData }) {
  const t = useT();
  const copyToast = useCopyToast();
  const { search, loading, error, href } = useRouter();
  const hasPlugin = useHasPlugin();
  const infiniteScroll = hasPlugin("infiniteScroll");

  const globals = data.globals;
  const [selectedCategories, setSelectedCategories] = useState<string[]>(
    data.selected_categories.length > 0 ? data.selected_categories : [globals.default_category],
  );
  useEffect(() => {
    setSelectedCategories(data.selected_categories.length > 0 ? data.selected_categories : [globals.default_category]);
  }, [data, globals.default_category]);

  // the URL is the source of truth for the active filter values
  // biome-ignore lint/correctness/useExhaustiveDependencies: URL is the source of truth
  const urlParams = useMemo(() => {
    try {
      return parseSearchUrl(new URL(window.location.href));
    } catch {
      return null;
    }
  }, [href]);

  // one literal for the URL→filter mapping so init and re-sync cannot drift
  const filterValuesFrom = (): FilterValues => ({
    language: urlParams?.language ?? data.current_language ?? globals.language,
    time_range: urlParams?.time_range ?? data.time_range ?? "",
    safesearch: urlParams?.safesearch ?? globals.safesearch,
    search_language: data.search_language,
  });

  const [filterValues, setFilterValues] = useState<FilterValues>(filterValuesFrom);

  // re-sync filters after any navigation (back/forward, payload change)
  // biome-ignore lint/correctness/useExhaustiveDependencies: URL is the source of truth
  useEffect(() => {
    setFilterValues(filterValuesFrom());
  }, [href]);

  const settings = useSettings();
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsedBlocks, setCollapsedBlocks] = useState<Record<string, boolean>>({});
  const [hotkeysSelected, setHotkeysSelected] = useState(-1);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [appended, setAppended] = useState<ResultItem[]>([]);
  const [appendState, setAppendState] = useState<"idle" | "loading" | "error" | "done">("idle");
  const appendedHref = useRef(href);

  useEffect(() => {
    if (appendedHref.current !== href) {
      appendedHref.current = href;
      setAppended([]);
      setAppendState("idle");
    }
  }, [href]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: href is the trigger
  useEffect(() => {
    setHotkeysSelected(-1);
  }, [href]);

  const buildParams = (
    overrides?: Partial<{
      q: string;
      categories: string[];
      pageno: number;
      language: string;
      time_range: string;
      safesearch: number;
    }>,
  ) => ({
    q: overrides?.q ?? data.q,
    categories: overrides?.categories ?? selectedCategories,
    pageno: overrides?.pageno ?? data.pageno,
    language: overrides?.language ?? filterValues.language,
    time_range: overrides?.time_range ?? filterValues.time_range,
    safesearch: overrides?.safesearch ?? filterValues.safesearch,
    timeout_limit: data.timeout_limit || undefined,
    engine_data: data.engine_data && Object.keys(data.engine_data).length > 0 ? data.engine_data : undefined,
  });

  const submitQuery = (q: string) => {
    // a bang search pins its resolved category into selectedCategories; a
    // plain follow-up query must fall back to the user's default category
    // (the preferences cookie) instead of silently keeping the bang's
    const previousWasBang = data.q.trim().startsWith("!");
    const nextIsBang = q.trim().startsWith("!");
    const cookieDefault = readCookie("categories")?.split(",").filter(Boolean);
    const categories =
      previousWasBang && !nextIsBang
        ? cookieDefault && cookieDefault.length > 0
          ? cookieDefault
          : [globals.default_category]
        : selectedCategories;
    search(buildParams({ q, pageno: 1, categories }));
  };

  const onSearchCategories = (categories: string[]) => {
    setSelectedCategories(categories);
    search(buildParams({ categories, pageno: 1 }));
  };

  const onFilters = (next: Partial<FilterValues>) => {
    // filters apply on the next search submit (magnifier / Enter) — switching
    // one alone must not fire a new search
    setFilterValues((prev) => ({ ...prev, ...next }));
  };

  const onPage = (pageno: number) => {
    search(buildParams({ pageno }));
  };
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;

  const loadNextPage = useRef(() => {});
  loadNextPage.current = () => {
    if (appendState !== "idle") {
      return;
    }
    setAppendState("loading");
    // guard against the mid-flight navigation race: if the user submits a
    // new query while page N+1 is fetching, the reset effect has already
    // cleared `appended` — the stale response must not paste into it
    const hrefAtStart = href;
    const nextParams = buildParams({ pageno: data.pageno + 1 });
    void fetchSearchPage(nextParams, globals.method)
      .then((next) => {
        if (appendedHref.current !== hrefAtStart) {
          return;
        }
        setAppended((prev) => [...prev, ...next.results]);
        setAppendState(next.paging ? "idle" : "done");
      })
      .catch(() => {
        if (appendedHref.current !== hrefAtStart) {
          return;
        }
        setAppendState("error");
      });
  };

  // ----- keyboard navigation (default / vim layouts) -----
  // navigable cards are marked with data-hotkey-index (the index into
  // allResults); grids without per-result cards (images) are skipped
  const selectedCard = () => {
    if (hotkeysSelected < 0 || !listRef.current) {
      return undefined;
    }
    return listRef.current.querySelector<HTMLElement>(`[data-hotkey-index="${hotkeysSelected}"]`) ?? undefined;
  };
  const hotkeyTarget = {
    move: (delta: number) => {
      const cards = listRef.current
        ? Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-hotkey-index]"))
        : [];
      if (cards.length === 0) {
        return;
      }
      const pos =
        hotkeysSelected < 0 ? -1 : cards.findIndex((card) => card.dataset.hotkeyIndex === String(hotkeysSelected));
      const next = cards[Math.min(cards.length - 1, Math.max(0, pos + delta))];
      if (!next) {
        return;
      }
      next.scrollIntoView({ block: "center", behavior: scrollBehavior() });
      setHotkeysSelected(Number(next.dataset.hotkeyIndex));
    },
    open: (newTab: boolean) => {
      const href = selectedCard()?.querySelector("a[href]")?.getAttribute("href");
      if (href) {
        // o/Enter follows the "results in new tabs" preference, t/v forces it
        if (newTab || globals.results_on_new_tab) {
          window.open(href, "_blank", "noopener,noreferrer");
        } else {
          window.location.assign(href);
        }
      }
    },
    yank: () => {
      const url = selectedCard()?.querySelector("a[href]")?.getAttribute("href");
      if (url) {
        copyToast(url);
      }
    },
    page: (delta: number) => {
      const next = data.pageno + delta;
      if (next >= 1 && (delta < 0 || data.paging)) {
        onPageRef.current(next);
      }
    },
    focusSearch: focusSearchInput,
  };
  useHotkeys(settings.hotkeys, hotkeyTarget, () => {
    setHelpOpen((open) => !open);
  });

  const allResults = useMemo(() => [...data.results, ...appended], [data.results, appended]);
  const layout = useMemo(
    () => detectResultsLayout(data, selectedCategories, allResults),
    [data, selectedCategories, allResults],
  );

  // client-side calculator answer (server plugin "calculator" enabled)
  const calc = useMemo(() => {
    if (!hasPlugin("calculator")) {
      return null;
    }
    return tryEvaluateExpression(data.q);
  }, [data.q, hasPlugin]);
  // `pending` covers streamed full loads: the app booted before the engines
  // finished, the real payload swaps in through the router (no fetch here)
  const showSkeletons = (loading || data.pending === true) && !error;
  // the right rail exists while it can ever get content: the streamed boot
  // keeps the width reservation (matching the static skeleton so the swap
  // never shifts); afterwards it stays only with content — an absent rail
  // frees the column and the container-query grids widen into it
  const showRail = showSkeletons || data.infoboxes.length > 0 || globals.method === "POST";

  return (
    <Shell globals={globals} hideTopNav>
      <header>
        {/* the query is the page's heading — visually carried by the query
            pill, kept as an sr-only h1 for document outline / SEO */}
        <h1 className="sr-only">{data.q}</h1>
        <div className="zjs-results-header-row mx-auto flex w-full items-center gap-4 px-4 pt-3 sm:px-6">
          {/* brand links back to the home page (SPA navigation);
              hidden on small screens so the query box keeps enough width */}
          <Link
            ariaLabel={globals.instance_name}
            className="hidden min-[480px]:block shrink-0 select-none text-xl font-extrabold tracking-tight text-ink"
            href="/"
            title={globals.instance_name}
          >
            {globals.instance_name}
            <span className="text-accent-strong">.</span>
          </Link>
          <div className="min-w-0 flex-1 max-w-2xl xl:max-w-3xl 2xl:max-w-4xl">
            <SearchBox initialQuery={data.q} onSubmitQuery={submitQuery} />
          </div>
          <div className="ms-auto">
            <HeaderActions globals={globals} />
          </div>
        </div>
      </header>

      <main className="zjs-results-main mx-auto w-full flex-1 px-4 sm:px-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
          {/* @container: grid density keys off the actual column width, so
              widescreen adds a column and centered mode drops one */}
          <div className="@container min-w-0 flex-1 pt-4" ref={listRef}>
            {/* Kagi layout: the tabs and filters live in the results column so
                the infobox sidebar rises to the top of the page */}
            <CategoryTabs
              globals={globals}
              onSearch={onSearchCategories}
              onSelectionChange={setSelectedCategories}
              selected={selectedCategories}
            />
            <div className="mt-1">
              <SearchFilters globals={globals} onChange={onFilters} values={filterValues} />
            </div>
            {!showSkeletons && !error ? (
              <>
                <div className="mt-2">
                  <DebugPanels data={data} results={allResults} searchUrl={shareableSearchUrl(data)} />
                </div>
                <div className="mt-3.5">
                  <SuggestionsBox data={data} onSearch={submitQuery} />
                </div>
              </>
            ) : null}

            {!showSkeletons && data.infoboxes.length > 0 ? (
              <div className="mt-3 flex flex-col gap-3 lg:hidden">
                {data.infoboxes.map((infobox) => (
                  <Infobox globals={globals} infobox={infobox} key={infobox.title} onSearch={submitQuery} />
                ))}
              </div>
            ) : null}
            {error ? (
              <div
                className="mb-4 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger"
                role="alert"
              >
                {t("error_loading_next_page")} ({error})
              </div>
            ) : null}

            {showSkeletons ? (
              <div aria-busy="true" className="mt-2 space-y-1">
                {Array.from({ length: 5 }, (_, index) => (
                  <ResultSkeleton key={index} />
                ))}
              </div>
            ) : (
              <>
                <Corrections data={data} onSearch={submitQuery} />
                <div className="mt-3 space-y-3">
                  {calc ? <CalculatorAnswer calc={calc} /> : null}
                  <Answers answers={data.answers} query={data.q} />
                </div>

                {allResults.length === 0 && data.answers.length === 0 ? (
                  <div className="mt-6">
                    <NoResults
                      hasInfobox={data.infoboxes.length > 0}
                      onPrev={data.pageno > 1 ? () => onPage(data.pageno - 1) : undefined}
                      pageno={data.pageno}
                    />
                  </div>
                ) : (
                  <CacheUrlProvider cacheUrl={globals.cache_url}>
                    <ResultsView
                      collapsedBlocks={collapsedBlocks}
                      globals={globals}
                      layout={layout}
                      onToggleBlock={(key) => {
                        setCollapsedBlocks((prev) => ({ ...prev, [key]: !prev[key] }));
                      }}
                      results={allResults}
                      selected={hotkeysSelected}
                    />
                  </CacheUrlProvider>
                )}

                {infiniteScroll &&
                allResults.length > 0 &&
                !collapsedBlocks.general &&
                appendState !== "done" &&
                (data.paging || appended.length > 0) ? (
                  <InfiniteScrollSentinel
                    error={appendState === "error"}
                    loading={appendState === "loading"}
                    onNext={() => {
                      loadNextPage.current();
                    }}
                  />
                ) : (
                  <Pagination onPage={onPage} pageno={data.pageno} paging={data.paging} />
                )}
              </>
            )}
          </div>

          {showRail ? (
            <div className="hidden w-full shrink-0 pt-4 lg:flex lg:flex-col lg:gap-3 lg:w-80 xl:w-96 lg:pb-6">
              {showSkeletons ? null : <Sidebar data={data} onSearch={submitQuery} />}
            </div>
          ) : null}
        </div>
      </main>

      <BackToTop />
      {helpOpen ? <HelpModal layout={settings.hotkeys} onClose={() => setHelpOpen(false)} /> : null}
    </Shell>
  );
}
