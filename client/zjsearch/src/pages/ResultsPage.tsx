// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackToTop } from "@/components/BackToTop.tsx";
import { HelpModal } from "@/components/HelpModal.tsx";
import { SearchBox } from "@/components/SearchBox.tsx";
import { CategoryTabs, type FilterValues, SearchFilters } from "@/components/SearchControls.tsx";
import { HeaderActions, Link, Shell } from "@/components/Shell.tsx";
import { tryEvaluateExpression } from "@/features/calculator.ts";
import { focusSearchInput, useHotkeys } from "@/features/hotkeys.ts";
import { AiAnswerCard, AiAnswerTrigger, useAiAnswer } from "@/features/results/AiSummary.tsx";
import {
  aiSourceMeta,
  buildAiContext,
  citedSourceNumbers,
  collectAiImages,
  splitAnswerStream,
} from "@/features/results/aiAnswer.ts";
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
import { useLocale, useT } from "@/lib/i18n.ts";
import { scrollBehavior } from "@/lib/motion.ts";
import { useRouter } from "@/lib/router.tsx";
import { fetchSearchPage, parseSearchUrl, shareableSearchUrl } from "@/lib/searchParams.ts";
import { useHasPlugin, useSettings } from "@/lib/settings.ts";
import type { ResultItem, SearchPageData } from "@/lib/types.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";

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
  // the AI output language follows the ACTIVE UI language (the i18n
  // runtime's locale — the server preference alone can be a stale default
  // while the UI actually renders in the browser language)
  const uiLocale = useLocale();
  const aiAnswer = useAiAnswer(globals.ai, uiLocale || globals.locale || "en");

  // re-sync filters after any navigation (back/forward, payload change);
  // a new search invalidates the Quick Answer
  // biome-ignore lint/correctness/useExhaustiveDependencies: URL is the source of truth
  useEffect(() => {
    setFilterValues(filterValuesFrom());
    aiAnswer.reset();
  }, [href]);

  const settings = useSettings();
  const [helpOpen, setHelpOpen] = useState(false);
  const { render: renderHelp, closing: helpClosing } = useExitPresence(helpOpen);
  const [collapsedBlocks, setCollapsedBlocks] = useState<Record<string, boolean>>({});
  const [hotkeysSelected, setHotkeysSelected] = useState(-1);
  const listRef = useRef<HTMLDivElement | null>(null);
  const flashTimer = useRef<number | null>(null);
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
  const aiImages = useMemo(() => collectAiImages(allResults), [allResults]);
  const aiMeta = useMemo(() => aiSourceMeta(allResults), [allResults]);

  // Quick Answer citation [n] → the n-th result of the flat list the answer
  // context was built from.  The cited indices live in STATE (not bare DOM
  // attributes) so the dashed frames can be cleared when the answer they
  // belong to is replaced, and re-applied when React recreates a marked
  // card's DOM (category blocks unmount while folded).
  const [aiCited, setAiCited] = useState<ReadonlySet<number>>(() => new Set());
  const findResultCard = useCallback((index: number, result: ResultItem): HTMLElement | null => {
    const list = listRef.current;
    if (!list) {
      return null;
    }
    // text cards anchor through their result link, grid tiles through
    // data-hotkey-index (the global result index) or the image tiles'
    // data-ai-url (present even when a thumbnail failed to load)
    const probe =
      list.querySelector(`a[href="${CSS.escape(result.url)}"]`) ??
      list.querySelector(`[data-hotkey-index="${index}"]`) ??
      list.querySelector(`[data-ai-url="${CSS.escape(result.url)}"]`);
    return probe?.closest<HTMLElement>("article, [data-hotkey-index], button") ?? null;
  }, []);

  const jumpToAiSource = useCallback(
    (index: number): boolean => {
      const result = allResults[index - 1];
      if (!result) {
        return false;
      }
      const card = findResultCard(index - 1, result);
      if (!card) {
        return false;
      }
      card.scrollIntoView({ block: "start", behavior: scrollBehavior() });
      // the dashed frame persists — the accumulating set of the results the
      // AI cited; the tint flash below is the one-shot locate highlight
      setAiCited((prev) => new Set(prev).add(index - 1));
      if (flashTimer.current !== null) {
        window.clearTimeout(flashTimer.current);
      }
      // restart the flash when a second citation hits the same card (setting
      // the attribute again would not replay a running CSS animation)
      card.removeAttribute("data-ai-flash");
      void card.offsetWidth;
      card.setAttribute("data-ai-flash", "");
      flashTimer.current = window.setTimeout(() => {
        card.removeAttribute("data-ai-flash");
        flashTimer.current = null;
      }, 1900);
      return true;
    },
    [allResults, findResultCard],
  );

  // the marks belong to the answer that produced them: a fresh ask (new
  // question, regenerate) and every new search payload drop the set
  // biome-ignore lint/correctness/useExhaustiveDependencies: data is the commit key — a new payload invalidates the marks even mid-idle
  useEffect(() => {
    if (aiAnswer.phase === "streaming") {
      setAiCited(new Set());
    }
  }, [aiAnswer.phase, data]);

  // as soon as the answer settles, mark EVERY result it actually cites —
  // the cited source numbers are parsed from the settled answer text with
  // the same grammar (and code-block skips) the renderer uses
  useEffect(() => {
    if (aiAnswer.phase !== "done") {
      return;
    }
    const { answer } = splitAnswerStream(aiAnswer.text);
    setAiCited(new Set(citedSourceNumbers(answer).map((n) => n - 1)));
  }, [aiAnswer.phase, aiAnswer.text]);

  // (re-)apply the frames from the set — idempotent, so it doubles as the
  // re-marker for cards whose DOM was recreated while folded
  useEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    for (const el of [...list.querySelectorAll("[data-ai-cited]")]) {
      if (!aiCited.has(Number(el.getAttribute("data-ai-cited")))) {
        el.removeAttribute("data-ai-cited");
      }
    }
    for (const index of aiCited) {
      const result = allResults[index];
      const card = result ? findResultCard(index, result) : null;
      card?.setAttribute("data-ai-cited", String(index));
    }
  }, [aiCited, allResults, findResultCard]);
  const layout = useMemo(
    () => detectResultsLayout(data, selectedCategories, allResults),
    [data, selectedCategories, allResults],
  );
  // stable identity: ResultsView is memoized against the AI stream's
  // per-chunk re-renders, an inline closure would break the memo
  const onToggleBlock = useCallback((key: string) => {
    setCollapsedBlocks((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

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
  // a freed rail column is only useful to container-query grids; card-list
  // presentations render borderless rows capped at the reading measure, so
  // the full freed width would read as a formless void. They keep instead
  // the exact width the reserved rail gives the column — which also keeps
  // the streamed boot → payload swap gapless for text pages.
  const cardListLayout = layout.kind === "list" || layout.kind === "dictionary" || layout.kind === "science";
  const columnCap = !showRail && cardListLayout ? "lg:max-w-[calc(100%-22rem)] xl:max-w-[calc(100%-26rem)]" : "";

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
            className="hidden min-[480px]:block shrink-0 select-none font-serif text-2xl font-semibold tracking-tight text-ink"
            href="/"
            title={globals.instance_name}
          >
            {globals.instance_name}
            {/* 品牌句号（DESIGN.md §2.2）：实心金点收尾，与 favicon 句号同色系 */}
            <span aria-hidden="true" className="ms-0.5 inline-block size-[0.25em] rounded-full bg-accent-strong" />
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
          <div className={`@container min-w-0 flex-1 pt-4 ${columnCap}`} ref={listRef}>
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
                  <DebugPanels
                    actions={
                      globals.ai && allResults.length > 0 ? (
                        <AiAnswerTrigger
                          onToggle={() => {
                            aiAnswer.toggle(data.q, buildAiContext(allResults, data.infoboxes), aiImages);
                          }}
                          phase={aiAnswer.phase}
                        />
                      ) : null
                    }
                    data={data}
                    results={allResults}
                    searchUrl={shareableSearchUrl(data)}
                  />
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
                  {aiAnswer.open ? <AiAnswerCard onCite={jumpToAiSource} sourceMeta={aiMeta} state={aiAnswer} /> : null}
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
                      onToggleBlock={onToggleBlock}
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
                ) : allResults.length > 0 ? (
                  // a zero-result page is final — the NoResults state above
                  // owns it (its later-page variant carries the prev action)
                  <Pagination onPage={onPage} pageno={data.pageno} paging={data.paging} />
                ) : null}
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
      {renderHelp ? (
        <HelpModal closing={helpClosing} layout={settings.hotkeys} onClose={() => setHelpOpen(false)} />
      ) : null}
    </Shell>
  );
}
