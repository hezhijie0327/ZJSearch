// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ArrowUp, Lightbulb, LoaderCircle, SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";
import { AiModeSwitch } from "@/components/AiModeSwitch.tsx";
import { Collapse } from "@/components/Collapse.tsx";
import { Dropdown } from "@/components/Dropdown.tsx";
import { HelpModal } from "@/components/HelpModal.tsx";
import { SearchBox } from "@/components/SearchBox.tsx";
import { CategoryTabs, defaultFilterValues, type FilterValues, SearchFilters } from "@/components/SearchControls.tsx";
import { Shell } from "@/components/Shell.tsx";
import { focusSearchInput, type HotkeyTarget, useHotkeys } from "@/features/hotkeys.ts";
import { useOverlay } from "@/features/overlay/OverlayProvider.tsx";
import { depthOptions } from "@/features/results/aiSearch/depth.tsx";
import type { AiSearchMode } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";
import { useRouter } from "@/lib/router.tsx";
import { useSettings } from "@/lib/settings.ts";
import type { BasicPageData } from "@/lib/types.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";
import { preloadResultsPage } from "@/pages/lazyPages.ts";

interface IndexData extends BasicPageData {
  selected_categories?: string[];
}

export function IndexPage({ data }: { data: IndexData }) {
  const { search, loading } = useRouter();
  const globals = data.globals;
  const { openOverlay } = useOverlay();
  const [query, setQuery] = useState("");
  // the AI mode choice on the hero is session-local state (initialized from
  // the URL so back/forward into ?ai=1 lands in AI mode); it rides along
  // with every search as the `ai` flag
  const [aiMode, setAiMode] = useState(() => new URLSearchParams(window.location.search).get("ai") === "1");
  // the hero's research-depth pick rides to the results page as the `mode`
  // param, where the agent run starts at that depth
  const [aiDepth, setAiDepth] = useState<AiSearchMode>("balanced");
  const [selected, setSelected] = useState<string[]>(
    data.selected_categories && data.selected_categories.length > 0
      ? data.selected_categories
      : [globals.default_category],
  );
  const [filters, setFilters] = useState<FilterValues>(() => defaultFilterValues(globals));
  const [optionsOpen, setOptionsOpen] = useState(false);

  const submitSearch = (q: string, categories = selected) => {
    const trimmed = q.trim();
    if (!trimmed) {
      return;
    }
    search({
      q: trimmed,
      categories,
      language: filters.language,
      time_range: filters.time_range,
      safesearch: filters.safesearch,
      pageno: 1,
      ai: aiMode || undefined,
      mode: aiMode ? aiDepth : undefined,
    });
  };

  const [helpOpen, setHelpOpen] = useState(false);
  const { render: renderHelp, closing: helpClosing } = useExitPresence(helpOpen);
  const [hintHidden, setHintHidden] = useState(() => window.localStorage.getItem("zjs-hint-hidden") === "1");
  const settings = useSettings();
  const t = useT();

  // "?" opens the shortcuts help on the home page too; the result-navigation
  // keys have nothing to act on here
  const hotkeyTarget: HotkeyTarget = {
    move: () => {},
    open: () => {},
    yank: () => {},
    page: () => {},
    focusSearch: focusSearchInput,
  };
  useHotkeys(settings.hotkeys, hotkeyTarget, () => {
    setHelpOpen((open) => !open);
  });

  return (
    <Shell globals={globals} variant="hero">
      <main className="mx-auto flex w-full max-w-2xl flex-col items-center px-4 pb-24">
        {/* the accent dot is the attribution: hovering (or focusing) it fades
            in "Powered by SearXNG" beside the wordmark — absolutely positioned
            so the centered brand never shifts — and tapping it opens About.
            The wordmark NEVER changes size across modes: every hero block
            below either stays mounted or animates its height (Collapse), so
            the mode flip cannot jump the layout. */}
        <h1 className="animate-fade-up font-serif text-6xl font-black tracking-tight text-ink sm:text-7xl">
          {globals.instance_name}
          <button
            aria-label={`${t("powered_by")} SearXNG`}
            className="group/dot relative cursor-pointer"
            onClick={() => {
              openOverlay(globals.about_url, t("about"), "about");
            }}
            type="button"
          >
            {/* 品牌句号（DESIGN.md §2.2）：实心金点收尾，与 favicon 句号同色系 */}
            <span aria-hidden="true" className="ms-0.5 inline-block size-[0.25em] rounded-full bg-accent-strong" />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-1.5 left-full ms-3 hidden whitespace-nowrap text-xs font-medium tracking-normal text-ink-3 opacity-0 transition-opacity duration-150 group-focus-visible/dot:opacity-100 group-hover/dot:opacity-100 sm:block"
            >
              {t("powered_by")} SearXNG
            </span>
          </button>
        </h1>
        {/* ONE ask-card for both modes (morphic's ask-anything): the input
            on top, the bottom row carries the [classic|AI] switch, the
            mode's own control (research depth for AI, the options toggle
            for classic) and the circular submit.  Raised stacking level:
            fade-up leaves a residual transform (a stacking context) on
            animated siblings, which would let the dropdown paint under
            them. */}
        <div
          className="relative z-10 mt-12 w-full animate-fade-up [animation-delay:60ms] rounded-2xl border border-line bg-surface p-5 shadow-card transition-colors focus-within:border-accent"
          onFocusCapture={preloadResultsPage}
        >
          <SearchBox
            initialQuery=""
            onQueryChange={setQuery}
            onSubmitQuery={(q) => {
              submitSearch(q);
            }}
            placeholder={aiMode ? t("ai_hero_ask") : t("ai_hero_search")}
            query={query}
            variant="bare"
          />
          <div className="mt-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AiModeSwitch ai={aiMode} onChange={setAiMode} />
              {aiMode ? (
                <Dropdown
                  ariaLabel={t("research_mode")}
                  onChange={(value) => {
                    setAiDepth(value as AiSearchMode);
                  }}
                  options={depthOptions(t)}
                  value={aiDepth}
                />
              ) : (
                <button
                  aria-expanded={optionsOpen}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-lg px-3 text-[13px] transition-colors ${
                    optionsOpen ? "bg-surface-2 text-ink" : "text-ink-3 hover:bg-surface-2/70 hover:text-ink"
                  }`}
                  onClick={() => {
                    setOptionsOpen((open) => !open);
                  }}
                  type="button"
                >
                  <SlidersHorizontal className="size-3.5" />
                  {t("search_options")}
                </button>
              )}
            </div>
            <button
              aria-label={t("search")}
              className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-strong text-accent-contrast transition-opacity hover:bg-accent-strong-hover disabled:opacity-40"
              disabled={!query.trim()}
              onClick={() => {
                submitSearch(query);
              }}
              type="button"
            >
              {loading ? (
                <LoaderCircle aria-hidden="true" className="size-4.5 animate-spin-slow" />
              ) : (
                <ArrowUp className="size-4.5" />
              )}
            </button>
          </div>
        </div>
        {/* classic-only tabs + filters: forced closed in AI mode (an agent run
            has no categories/filters), animated by the shared Collapse */}
        <Collapse className={`w-full ${optionsOpen && !aiMode ? "mt-3" : ""}`} open={optionsOpen && !aiMode}>
          <div className="relative z-10 w-full">
            <CategoryTabs
              globals={globals}
              onSearch={(categories) => {
                setSelected(categories);
                submitSearch(query, categories);
              }}
              onSelectionChange={setSelected}
              selected={selected}
              wrap
            />
          </div>
          <div className="relative z-10 mt-2 flex w-full flex-wrap items-center gap-1.5 ps-6">
            <SearchFilters
              globals={globals}
              onChange={(next) => {
                setFilters((prev) => ({ ...prev, ...next }));
              }}
              values={filters}
            />
          </div>
        </Collapse>
      </main>
      {/* the hotkeys hint: dismissed hides it for good, the AI composition
          fades it via the Collapse band (no snap when the mode flips) */}
      <Collapse className="mx-auto mb-10 w-full max-w-xl px-4" open={!aiMode && !hintHidden}>
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-2.5 text-sm">
          <Lightbulb className="size-4 shrink-0 text-accent" />
          <button
            className="min-w-0 flex-1 truncate text-left text-[13px] text-ink-2 transition-colors hover:text-ink"
            onClick={() => {
              setHelpOpen(true);
            }}
            type="button"
          >
            {t("hotkeys_hint")}
          </button>
          <button
            aria-label={t("close")}
            className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            onClick={() => {
              window.localStorage.setItem("zjs-hint-hidden", "1");
              setHintHidden(true);
            }}
            type="button"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      </Collapse>
      {renderHelp ? (
        <HelpModal closing={helpClosing} layout={settings.hotkeys} onClose={() => setHelpOpen(false)} />
      ) : null}
    </Shell>
  );
}
