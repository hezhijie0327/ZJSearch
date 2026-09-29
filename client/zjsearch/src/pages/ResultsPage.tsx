// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackToTop } from "@/components/BackToTop.tsx";
import { Brand } from "@/components/Brand.tsx";
import { Dropdown } from "@/components/Dropdown.tsx";
import { HelpModal } from "@/components/HelpModal.tsx";
import { SearchBox, SubmitCircle } from "@/components/SearchBox.tsx";
import { CategoryTabs, type FilterValues, SearchFilters } from "@/components/SearchControls.tsx";
import { HeaderActions, Shell } from "@/components/Shell.tsx";
import { tryEvaluateExpression } from "@/features/calculator.ts";
import { focusSearchInput, useHotkeys } from "@/features/hotkeys.ts";
import { AiAnswerCard, AiAnswerTrigger, useAiAnswer } from "@/features/results/AiSummary.tsx";
import {
  type AiSourceMeta,
  aiSourceMeta,
  buildAiContext,
  citedSourceNumbers,
  collectAiImages,
  splitAnswerStream,
} from "@/features/results/aiAnswer.ts";
import { AiSearchRunSection } from "@/features/results/aiSearch/AiSearchRunSection.tsx";
import { depthOptions, parseDepthMode } from "@/features/results/aiSearch/depth.tsx";
import { type AiSearchMode, type AiSearchRun, useAiSearch } from "@/features/results/aiSearch/useAiSearch.ts";
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
import { themeLocaleTag, useLocale, useT } from "@/lib/i18n.ts";
import { animateScroll, scrollIntoViewAnimated } from "@/lib/motion.ts";
import { useRouter } from "@/lib/router.tsx";
import { fetchSearchPage, parseSearchUrl, shareableSearchUrl } from "@/lib/searchParams.ts";
import { useHasPlugin, useSettings } from "@/lib/settings.ts";
import type { ResultItem, SearchPageData } from "@/lib/types.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";

/** stable empty set: the derived aiCited must not churn the apply effect
    when the marks are invalidated (a fresh identity per render would) */
const EMPTY_AI_CITED: ReadonlySet<number> = new Set();

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
  // the AI reply language as a RESOLVED catalog tag (zh-CN | en): the raw
  // locale falls back like the UI does, server-side stays a data table
  const aiLang = themeLocaleTag(uiLocale || globals.locale || "en");
  const aiAnswer = useAiAnswer(globals.ai, aiLang);
  // AI Search mode: the [classic|AI] switch writes `ai=1` into the URL; the
  // panel leads the results column and auto-runs once the results settle
  const aiSearchCap = globals.ai_search;
  const aiModeRaw = urlParams?.ai === true || globals.ai_mode === true;
  const aiMode = aiModeRaw && Boolean(aiSearchCap);
  const aiSearch = useAiSearch(aiSearchCap);

  // re-sync filters after any navigation (back/forward, payload change);
  // a new search invalidates the Quick Answer and its citation marks
  // biome-ignore lint/correctness/useExhaustiveDependencies: URL is the source of truth
  useEffect(() => {
    setFilterValues(filterValuesFrom());
    // the research depth re-reads the URL too: back/forward between
    // searches with different `mode` params must restore the picker
    setResearchMode(parseDepthMode(urlParams?.mode));
    aiAnswer.reset();
    aiSearch.reset();
    aiSearchRan.current = false;
    setAiMarks(null);
  }, [href]);

  const settings = useSettings();
  const [helpOpen, setHelpOpen] = useState(false);
  const { render: renderHelp, closing: helpClosing } = useExitPresence(helpOpen);
  const [collapsedBlocks, setCollapsedBlocks] = useState<Record<string, boolean>>({});
  const [hotkeysSelected, setHotkeysSelected] = useState(-1);
  const listRef = useRef<HTMLDivElement | null>(null);
  // identity anchors for the per-run cumulative citation meta (see
  // runSourceMetas): the last runs array and the meta arrays it produced
  const runSourceMetaRuns = useRef<AiSearchRun[]>([]);
  const runSourceMetaOut = useRef<AiSourceMeta[][]>([]);
  const flashTimer = useRef<number | null>(null);
  const hrefRef = useRef(href);
  hrefRef.current = href;
  const [followupQuery, setFollowupQuery] = useState("");
  // the hero's depth pick travels as the `mode` URL param (validated --
  // anything unknown falls back to balanced)
  const [researchMode, setResearchMode] = useState<AiSearchMode>(() =>
    parseDepthMode(new URLSearchParams(window.location.search).get("mode")),
  );
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
      ai: boolean;
    }>,
  ) => ({
    q: overrides?.q ?? data.q,
    categories: overrides?.categories ?? selectedCategories,
    pageno: overrides?.pageno ?? data.pageno,
    language: overrides?.language ?? filterValues.language,
    time_range: overrides?.time_range ?? filterValues.time_range,
    safesearch: overrides?.safesearch ?? filterValues.safesearch,
    timeout_limit: data.timeout_limit || undefined,
    ai: overrides?.ai ?? (aiModeRaw || globals.ai_mode || undefined),
    // the hero's depth pick travels along; searchParamEntries only serializes
    // it when the ai flag is set, so classic URLs stay clean
    mode: researchMode,
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
      scrollIntoViewAnimated(next, "center");
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

  // AI Search auto-run: once per search, after the results settled.  The raw
  // results are NOT fed to the agent as a seed — with reference material in
  // the prompt the model skips the web_search calls and answers directly
  // (live-verified against LM Studio + qwen3.6), defeating the whole "AI
  // drives the searches" point.  The agent runs on the question alone.
  const aiSearchRan = useRef(false);
  // no dependency array on purpose: the guard ref makes it run once per
  // search.  allResults is deliberately NOT a gate — the takeover page has
  // no classic results to wait for (the server skipped the raw fan-out)
  useEffect(() => {
    if (!aiMode || showSkeletons || error || aiSearchRan.current) {
      return;
    }
    aiSearchRan.current = true;
    aiSearch.start(data.q, aiLang, researchMode, filterValues.search_language);
  });
  // a hand-crafted ?ai=1 (or the feature switched off mid-session) without
  // the capability: the server ran no classic search either — fall back to
  // the classic page so the user is never stuck on an empty takeover
  // no dependency array on purpose: fires once per navigation state
  useEffect(() => {
    if (aiModeRaw && !aiSearchCap && !showSkeletons && !loading) {
      search(buildParams({ ai: false }), { replace: true });
    }
  });
  // citation chips of run N resolve against the thread's sources up to and
  // including that run: a follow-up may cite earlier [n] sources, so its
  // meta stays cumulative while each run's grid shows only its own finds.
  // IDENTITY STABILITY IS THE POINT: the runs array is rebuilt by every
  // NDJSON chunk, but settled run OBJECTS keep identity — when a run object
  // is unchanged its cumulative meta array is REUSED, so a settled
  // section's memo holds and its markdown is not re-parsed per chunk.
  const runSourceMetas = useMemo(() => {
    const prevRuns = runSourceMetaRuns.current;
    const prevMetas = runSourceMetaOut.current;
    const out: AiSourceMeta[][] = [];
    let cumulative: AiSourceMeta[] = [];
    aiSearch.runs.forEach((run, index) => {
      if (prevRuns[index] === run && prevMetas[index]) {
        cumulative = prevMetas[index];
      } else {
        cumulative = [
          ...cumulative,
          ...run.sources.map((source) => ({
            domain: source.netloc,
            favicon: source.favicon,
            t: source.title,
            u: source.url,
          })),
        ];
      }
      out[index] = cumulative;
    });
    runSourceMetaRuns.current = aiSearch.runs;
    runSourceMetaOut.current = out;
    return out;
  }, [aiSearch.runs]);
  // The run sections are memoized with their handler props excluded, so
  // those handlers must be IMMUNE to stale closures: they read the live
  // state through refs.  A depth pick or filter change made after a run
  // settled must reach that run's Related/Regenerate/Fallback buttons.
  const aiSearchRef = useRef(aiSearch);
  aiSearchRef.current = aiSearch;
  const aiViewState = { aiLang, data, filterValues, globals, researchMode, uiLocale };
  const aiViewStateRef = useRef(aiViewState);
  aiViewStateRef.current = aiViewState;
  const buildParamsRef = useRef<(overrides?: Parameters<typeof buildParams>[0]) => ReturnType<typeof buildParams>>(
    (overrides) => buildParams(overrides),
  );
  buildParamsRef.current = (overrides) => buildParams(overrides);
  const onRunCite = useCallback(async (runIndex: number, index: number) => {
    const run = aiSearchRef.current.runs[runIndex];
    const source = aiSearchRef.current.runs.slice(0, runIndex + 1).flatMap((r) => r.sources)[index - 1];
    if (!run || !source?.url) {
      return;
    }
    // ONE logic for every citation: locate the source card in this run's
    // grid and flash it.  A card behind the grid's view-more cap is not in
    // the DOM yet -- expand that run's grid, wait for the commit, then
    // locate.  Only a truly missing card (should not happen) opens the
    // page instead.
    let card = listRef.current?.querySelector<HTMLElement>(`[data-ai-n="${index}"]`);
    if (!card) {
      const more = document.getElementById(`ai-run-${run.runNo}`)?.querySelector<HTMLElement>("[data-view-more]");
      if (more) {
        more.click();
        for (let i = 0; i < 10 && !card; i++) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          card = listRef.current?.querySelector<HTMLElement>(`[data-ai-n="${index}"]`);
        }
      }
    }
    if (!card) {
      window.open(source.url, "_blank", "noopener,noreferrer");
      return;
    }
    scrollIntoViewAnimated(card, "center");
    if (flashTimer.current !== null) {
      window.clearTimeout(flashTimer.current);
    }
    card.removeAttribute("data-ai-flash");
    void card.offsetWidth;
    card.setAttribute("data-ai-flash", "");
    flashTimer.current = window.setTimeout(() => {
      card.removeAttribute("data-ai-flash");
      flashTimer.current = null;
    }, 1900);
  }, []);
  const onRunFallback = useCallback(() => {
    search(buildParamsRef.current({ ai: false }), { replace: true });
  }, [search]);
  const onRunRegenerate = useCallback(() => {
    const view = aiViewStateRef.current;
    aiSearchRef.current.reset();
    aiSearchRef.current.start(view.data.q, view.aiLang, view.researchMode, view.filterValues.search_language);
  }, []);
  const onRunRelated = useCallback((question: string) => {
    const view = aiViewStateRef.current;
    setFollowupQuery("");
    aiSearchRef.current.followup(question, view.aiLang, view.researchMode, view.filterValues.search_language);
  }, []);
  const onRunStop = useCallback(() => {
    aiSearchRef.current.stop();
  }, []);
  // the awaiting run's clarify card was answered (or skipped): its
  // research starts on the SAME run, informed by the confirmed direction
  const onRunClarify = useCallback((text: string | null) => {
    const view = aiViewStateRef.current;
    aiSearchRef.current.submitClarify(text, view.aiLang, view.researchMode, view.filterValues.search_language);
  }, []);
  // a follow-up appends its run section: bring the new question into view
  const runsCount = aiSearch.runs.length;
  const seenRuns = useRef(0);
  // no dependency array on purpose: the guard ref fires it on growth only
  useEffect(() => {
    const appended = runsCount > seenRuns.current;
    seenRuns.current = runsCount;
    if (!appended || runsCount < 2) {
      return;
    }
    const el = document.getElementById(`ai-run-${runsCount}`);
    if (el) {
      scrollIntoViewAnimated(el, "start");
    }
  });
  // "jump to latest" on long threads (morphic's scroll-to-bottom): the
  // scrolled-up reader gets a one-hop way back to the live run + composer
  const [jumpLatest, setJumpLatest] = useState(false);
  useEffect(() => {
    if (!aiMode) {
      return;
    }
    const onScroll = () => {
      const fromBottom = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      setJumpLatest(fromBottom > 480);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, [aiMode]);
  const aiImages = useMemo(() => collectAiImages(allResults), [allResults]);
  const aiMeta = useMemo(() => aiSourceMeta(allResults), [allResults]);

  // Quick Answer citation [n] → the n-th result of the flat list the answer
  // context was built from.  The cited indices live in STATE keyed to the
  // search they were cited in (href): a new search invalidates them in the
  // same render (no flash of stale frames on the new results), and the
  // frames re-apply when React recreates a marked card's DOM (category
  // blocks unmount while folded).
  const [aiMarks, setAiMarks] = useState<{ href: string; indices: ReadonlySet<number> } | null>(null);
  const aiCited = aiMarks && aiMarks.href === href ? aiMarks.indices : EMPTY_AI_CITED;
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
      scrollIntoViewAnimated(card, "start");
      // the dashed frame persists — the accumulating set of the results the
      // AI cited; the tint flash below is the one-shot locate highlight
      setAiMarks({ href, indices: new Set(aiCited).add(index - 1) });
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
    [allResults, findResultCard, aiCited, href],
  );

  // the marks belong to the answer that produced them: a fresh ask
  // (new question, regenerate) drops the set; the new search invalidation
  // is the derived aiCited above (href identity)
  useEffect(() => {
    if (aiAnswer.phase === "streaming") {
      setAiMarks(null);
    }
  }, [aiAnswer.phase]);

  // as soon as the answer settles, mark EVERY result it actually cites —
  // the cited source numbers are parsed from the settled answer text with
  // the same grammar (and code-block skips) the renderer uses.  The marks
  // carry the href CURRENT at settle time (via ref — re-running on href
  // would resurrect the previous answer's citations onto a new search's
  // results).
  useEffect(() => {
    if (aiAnswer.phase !== "done") {
      return;
    }
    const { answer } = splitAnswerStream(aiAnswer.text);
    // [n] beyond the numbered results (the infobox trails the context as a
    // bare chip) must not mark a phantom row: clamp to the meta length
    const limit = aiMeta.length;
    setAiMarks({
      href: hrefRef.current,
      indices: new Set(
        citedSourceNumbers(answer)
          .filter((n) => n <= limit)
          .map((n) => n - 1),
      ),
    });
  }, [aiAnswer.phase, aiAnswer.text, aiMeta.length]);

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
  const showRail = !aiMode && (showSkeletons || data.infoboxes.length > 0 || globals.method === "POST");
  // a freed rail column is only useful to container-query grids; card-list
  // presentations render borderless rows capped at the reading measure, so
  // the full freed width would read as a formless void. They keep instead
  // the exact width the reserved rail gives the column — which also keeps
  // the streamed boot → payload swap gapless for text pages.
  const cardListLayout = layout.kind === "list" || layout.kind === "dictionary" || layout.kind === "science";
  // aiMode excluded: the takeover's empty payload detects as a card-list
  // layout, and the rail-width cap would then override max-w-3xl at xl
  // (the reading column rendered 61rem instead of 48rem on wide screens)
  const columnCap =
    !aiMode && !showRail && cardListLayout ? "lg:max-w-[calc(100%-22rem)] xl:max-w-[calc(100%-26rem)]" : "";

  return (
    <Shell globals={globals} hideTopNav>
      <header>
        {!aiMode ? (
          // classic header: brand + query pill + mode switch + actions
          <>
            <h1 className="sr-only">{data.q}</h1>
            <div className="zjs-results-header-row mx-auto flex w-full items-center gap-4 px-4 pt-3 sm:px-6">
              <div className="hidden min-[480px]:block">
                <Brand className="text-2xl" globals={globals} />
              </div>
              <div className="min-w-0 flex-1 max-w-2xl xl:max-w-3xl 2xl:max-w-4xl">
                <SearchBox initialQuery={data.q} onSubmitQuery={submitQuery} />
              </div>
              <div className="ms-auto">
                <HeaderActions globals={globals} />
              </div>
            </div>
          </>
        ) : (
          // AI takeover header: a slim Vane-style bar -- small brand, the
          // question heading lives in the column, mode switch + actions right.
          // The brand hides below 480px like the classic header: a long
          // instance name must never push the slim bar into a horizontal pan
          <>
            <h1 className="sr-only">{data.q}</h1>
            <div className="zjs-results-header-row mx-auto flex w-full items-center gap-3 px-4 pt-3 sm:px-6">
              <div className="hidden min-[480px]:block">
                <Brand className="text-xl" globals={globals} />
              </div>
              <div className="ms-auto flex items-center gap-3">
                <HeaderActions globals={globals} />
              </div>
            </div>
          </>
        )}
      </header>

      <main className="zjs-results-main mx-auto w-full flex-1 px-4 sm:px-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
          {/* @container: grid density keys off the actual column width, so
              widescreen adds a column and centered mode drops one */}
          {/* AI takeover: a centered reading column that grows into the
              answer+sources TWO-COLUMN composition from lg (prose keeps
              the 48rem measure, the source cards take the right rail);
              below lg it stays the 48rem Perplexity/morphic column.
              center_alignment deliberately has no say here: it widens/
              narrows the classic results FRAME, while an AI answer page
              is a prose column in both modes (all reference
              implementations lock it too). */}
          <div
            className={`@container min-w-0 flex-1 pt-4 ${columnCap} ${
              aiMode ? "mx-auto w-full max-w-3xl lg:max-w-[68rem] xl:max-w-[72rem]" : ""
            }`}
            ref={listRef}
          >
            {/* Kagi layout: the tabs and filters live in the results column so
                the infobox sidebar rises to the top of the page.  The AI
                takeover hides both — the agent picks its own categories. */}
            {!aiMode ? (
              <>
                <CategoryTabs
                  globals={globals}
                  onSearch={onSearchCategories}
                  onSelectionChange={setSelectedCategories}
                  selected={selectedCategories}
                />
                <div className="mt-1">
                  <SearchFilters globals={globals} onChange={onFilters} values={filterValues} />
                </div>
              </>
            ) : null}
            {!showSkeletons && !error ? (
              aiMode ? (
                <div className="space-y-8">
                  {aiSearch.runs.map((run, index) => (
                    <AiSearchRunSection
                      isFirst={index === 0}
                      isLast={index === aiSearch.runs.length - 1}
                      key={run.runNo}
                      live={index === aiSearch.runs.length - 1 && aiSearch.phase === "streaming"}
                      onCite={(n) => {
                        return onRunCite(index, n);
                      }}
                      onFallback={onRunFallback}
                      onRegenerate={onRunRegenerate}
                      onRelated={onRunRelated}
                      onStop={onRunStop}
                      onSubmitClarify={onRunClarify}
                      run={run}
                      sourceMeta={runSourceMetas[index] ?? []}
                    />
                  ))}
                  {aiSearch.phase === "done" ? (
                    // Perplexica's floating follow-up: pinned above the fold
                    // while the thread scrolls under it, a palette fog fading
                    // the content beneath the pill
                    <div className="sticky bottom-6 z-10">
                      {/* the fog masks content emerging ABOVE the pinned
                          pill; it must not wrap below it -- a translucent
                          band under the pill reads as a stray shadow box.
                          The bleed mirrors the main column's own padding
                          (px-4 / sm:px-6) so it ends AT the viewport edge
                          instead of spilling past it into a horizontal pan */}
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -inset-x-4 -top-8 bottom-full -z-10 bg-gradient-to-t from-bg to-transparent sm:-inset-x-6"
                      />
                      {jumpLatest ? (
                        <div className="relative z-10 mb-2 flex justify-center">
                          <button
                            aria-label={t("ai_scroll_latest")}
                            className="grid size-9 place-items-center rounded-full border border-line bg-surface text-ink-2 shadow-card transition-colors hover:text-ink"
                            onClick={() => {
                              animateScroll(window, { top: document.documentElement.scrollHeight });
                            }}
                            title={t("ai_scroll_latest")}
                            type="button"
                          >
                            <ChevronDown aria-hidden="true" className="size-4.5" />
                          </button>
                        </div>
                      ) : null}
                      <form
                        aria-label={t("ai_search_followup")}
                        className="rounded-2xl border border-line bg-surface px-5 py-4 shadow-card transition-colors focus-within:border-accent"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const value = followupQuery.trim();
                          if (!value) {
                            return;
                          }
                          setFollowupQuery("");
                          aiSearch.followup(value, aiLang, researchMode, filterValues.search_language);
                        }}
                      >
                        <input
                          aria-label={t("ai_search_followup")}
                          autoComplete="off"
                          className="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-3"
                          dir="auto"
                          onChange={(event) => {
                            setFollowupQuery(event.target.value);
                          }}
                          placeholder={t("ai_search_followup")}
                          value={followupQuery}
                        />
                        <div className="mt-3 flex items-center justify-between gap-2">
                          <Dropdown
                            ariaLabel={t("research_mode")}
                            onChange={(value) => {
                              setResearchMode(value as AiSearchMode);
                            }}
                            options={depthOptions(t)}
                            value={aiSearch.runs[aiSearch.runs.length - 1]?.mode ?? researchMode}
                          />
                          <div className="flex items-center gap-2">
                            <SubmitCircle disabled={!followupQuery.trim()} label={t("ai_search_followup")} send />
                          </div>
                        </div>
                      </form>
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  {/* the empty state LEADS a zero-result page (the hero must
                      not sit below the diagnostics strip); the meta line and
                      its engine-messages panel follow as supporting detail */}
                  {allResults.length === 0 && data.answers.length === 0 ? (
                    <div className="mt-6">
                      <NoResults
                        hasInfobox={data.infoboxes.length > 0}
                        onPrev={data.pageno > 1 ? () => onPage(data.pageno - 1) : undefined}
                        pageno={data.pageno}
                      />
                    </div>
                  ) : null}
                  <div className="mt-2">
                    <DebugPanels
                      actions={
                        globals.ai && allResults.length > 0 ? (
                          <AiAnswerTrigger
                            onToggle={() => {
                              aiAnswer.toggle(data.q, buildAiContext(allResults, data.infoboxes), aiImages);
                            }}
                            open={aiAnswer.open}
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
              )
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
            ) : aiMode ? // AI takeover: the panel + blocks above ARE the page; the
            // classic lower half (fed by the skipped raw search) stays off
            null : (
              <>
                <Corrections data={data} onSearch={submitQuery} />
                <div className="mt-3 space-y-3">
                  {aiAnswer.open ? <AiAnswerCard onCite={jumpToAiSource} sourceMeta={aiMeta} state={aiAnswer} /> : null}
                  {calc ? <CalculatorAnswer calc={calc} /> : null}
                  <Answers answers={data.answers} query={data.q} />
                </div>

                {/* mobile knowledge panel: after the instant answers so the
                    AI Overview leads the page (the desktop rail shows it
                    beside the results instead) */}
                {!showSkeletons && data.infoboxes.length > 0 ? (
                  <div className="mt-3 flex flex-col gap-3 lg:hidden">
                    {data.infoboxes.map((infobox) => (
                      <Infobox globals={globals} infobox={infobox} key={infobox.title} onSearch={submitQuery} />
                    ))}
                  </div>
                ) : null}

                {allResults.length === 0 && data.answers.length === 0 ? null : (
                  // the zero-result NoResults hero leads the page above the
                  // meta line — nothing further down for it
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
