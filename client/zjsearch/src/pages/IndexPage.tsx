// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Lightbulb, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import { Dropdown } from "@/components/Dropdown.tsx";
import { HelpModal } from "@/components/HelpModal.tsx";
import { SearchBox, SubmitCircle } from "@/components/SearchBox.tsx";
import { CategoryTabs, defaultFilterValues, type FilterValues, SearchFilters } from "@/components/SearchControls.tsx";
import { Shell } from "@/components/Shell.tsx";
import { focusSearchInput, type HotkeyTarget, useHotkeys } from "@/features/hotkeys.ts";
import { AttachmentPicker } from "@/features/results/aiSearch/AttachmentPicker.tsx";
import { depthOptions, parseDepthMode } from "@/features/results/aiSearch/depth.tsx";
import { parseTemplateId, REPORT_TEMPLATES } from "@/features/results/aiSearch/reportTemplates.ts";
import type { AiSearchAttachment } from "@/features/results/aiSearch/timeline.ts";
import type { AiSearchMode } from "@/features/results/aiSearch/useAiSearch.ts";
import { type StringKey, useT } from "@/lib/i18n.ts";
import { useRouter } from "@/lib/router.tsx";
import { useSettings } from "@/lib/settings.ts";
import type { BasicPageData } from "@/lib/types.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";
import { preloadResultsPage } from "@/pages/lazyPages.ts";

interface IndexData extends BasicPageData {
  selected_categories?: string[];
}

/**
 * The [classic|AI] search-mode switch (the hero; page-private -- no other
 * page renders it), morphic's icon-only circles: the active mode is a raised surface circle with an
 * accent icon, the inactive one a muted icon.  Rendered only when the
 * page-data carries the `ai_search` capability; the choice rides along
 * with every search as the `ai` URL/body flag.
 */
export function AiModeSwitch({ ai, onChange }: { ai: boolean; onChange: (ai: boolean) => void }) {
  const t = useT();
  const option = (label: string, active: boolean, onSelect: () => void, icon: ReactNode) => (
    <button
      aria-checked={active}
      aria-label={label}
      className={`grid size-9 place-items-center rounded-full transition-colors ${
        active ? "bg-surface text-accent shadow-card" : "text-ink-3 hover:text-ink"
      }`}
      onClick={onSelect}
      role="radio"
      title={label}
      type="button"
    >
      {icon}
    </button>
  );
  return (
    <div
      aria-label={t("search_mode")}
      className="inline-flex items-center gap-1 rounded-full bg-surface-2/70 p-1"
      role="radiogroup"
    >
      {option(t("mode_classic"), !ai, () => onChange(false), <Search aria-hidden="true" className="size-4" />)}
      {option(t("mode_ai"), ai, () => onChange(true), <Sparkles aria-hidden="true" className="size-4" />)}
    </div>
  );
}

export function IndexPage({ data }: { data: IndexData }) {
  const { search, loading } = useRouter();
  const globals = data.globals;
  const [query, setQuery] = useState("");
  // the AI mode choice on the hero is session-local state (initialized from
  // the URL so back/forward into ?ai=1 lands in AI mode); it rides along
  // with every search as the `ai` flag.  The switch only exists when the
  // server ships the ai_search capability (zjsearch.ai.search.enabled) --
  // without it the hero stays classic and ?ai=1 is ignored.
  const aiSearchCap = Boolean(globals.ai_search);
  const [aiMode, setAiMode] = useState(
    () => Boolean(globals.ai_search) && new URLSearchParams(window.location.search).get("ai") === "1",
  );
  // the hero's research-depth pick rides to the results page as the `mode`
  // param, where the agent run starts at that depth; back/forward into a
  // ?mode= URL re-opens the hero at that depth (validated — anything
  // unknown falls back to balanced)
  const [aiDepth, setAiDepth] = useState<AiSearchMode>(() =>
    parseDepthMode(new URLSearchParams(window.location.search).get("mode")),
  );
  // the report template pick rides ?template= beside the depth (validated
  // against the presets; report mode only)
  const [templateId, setTemplateId] = useState<string | null>(() =>
    parseTemplateId(new URLSearchParams(window.location.search).get("template")),
  );
  const [selected, setSelected] = useState<string[]>(
    data.selected_categories && data.selected_categories.length > 0
      ? data.selected_categories
      : [globals.default_category],
  );
  const [filters, setFilters] = useState<FilterValues>(() => defaultFilterValues(globals));
  // the hero's staged images (AI mode): handed to the AI takeover through
  // sessionStorage -- the first question itself is URL-borne and cannot
  // carry bytes; the takeover picks the hand-off up when it starts the run
  const [heroAttachments, setHeroAttachments] = useState<AiSearchAttachment[]>([]);
  const [optionsOpen, setOptionsOpen] = useState(false);

  const submitSearch = (q: string, categories = selected) => {
    const trimmed = q.trim();
    if (!trimmed) {
      return;
    }
    if (aiMode && heroAttachments.length) {
      window.sessionStorage.setItem(
        "zjs-attach-handoff",
        JSON.stringify(heroAttachments.map(({ kind, mime, name, bytes, data }) => ({ kind, mime, name, bytes, data }))),
      );
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
      template: aiMode && aiDepth === "report" ? (templateId ?? undefined) : undefined,
    });
  };

  const [helpOpen, setHelpOpen] = useState(false);
  const { render: renderHelp, closing: helpClosing } = useExitPresence(helpOpen);
  const [hintHidden, setHintHidden] = useState(() => window.localStorage.getItem("zjs-hint-hidden") === "1");
  const settings = useSettings();
  const t = useT();

  // the hero's greeting: ONE line, by time of day (computed at mount --
  // the hero is a transient landing, nobody needs it to roll over live).
  // Five buckets on the Chinese convention: 凌晨/早上/中午/下午/晚上 --
  // 中午 (11-13) and 下午 (13-18) are DIFFERENT greetings in zh.
  const hour = new Date().getHours();
  const period = hour < 5 ? "night" : hour < 11 ? "morning" : hour < 13 ? "noon" : hour < 18 ? "afternoon" : "evening";
  const greeting = t(`hero_greeting_${aiMode ? "ask" : "search"}_${period}` as StringKey);

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
        {/* the brand lives in the top bar now (unified with every page);
            the hero leads with a time-of-day GREETING instead of the giant
            wordmark.  The block keeps a fixed height so the mode flip
            cannot jump the layout. */}
        <h1 className="sr-only">{globals.instance_name}</h1>
        <div className="flex h-16 items-center justify-center sm:h-20">
          <p
            className="break-words text-center font-serif text-2xl font-semibold tracking-tight text-ink sm:text-3xl"
            dir="auto"
          >
            {greeting}
          </p>
        </div>
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
            disableAutocomplete={aiMode}
            initialQuery=""
            onQueryChange={setQuery}
            onSubmitQuery={(q) => {
              submitSearch(q);
            }}
            placeholder={aiMode ? t("ai_hero_ask") : t("ai_hero_search")}
            query={query}
            variant="bare"
          />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {aiSearchCap ? <AiModeSwitch ai={aiMode} onChange={setAiMode} /> : null}
              {aiMode ? (
                <Dropdown
                  ariaLabel={t("research_mode")}
                  onChange={(value) => {
                    setAiDepth(value as AiSearchMode);
                  }}
                  options={depthOptions(t)}
                  value={aiDepth}
                />
              ) : null}
              {aiMode && aiDepth === "report" ? (
                <Dropdown
                  ariaLabel={t("report_template")}
                  onChange={(value) => {
                    setTemplateId(value || null);
                  }}
                  options={[
                    { value: "", label: t("report_template_free") },
                    ...REPORT_TEMPLATES.map((template) => ({ value: template.id, label: template.name })),
                  ]}
                  value={templateId ?? ""}
                />
              ) : null}
              {aiMode ? null : (
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
            <div className="flex items-center gap-2">
              {aiSearchCap && aiMode ? (
                <AttachmentPicker items={heroAttachments} onChange={setHeroAttachments} />
              ) : null}
              <SubmitCircle
                disabled={!query.trim()}
                label={t("search")}
                large
                loading={loading}
                onClick={() => {
                  submitSearch(query);
                }}
                send
              />
            </div>
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
