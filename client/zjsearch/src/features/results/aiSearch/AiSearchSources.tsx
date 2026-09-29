// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookOpen, ChevronDown, Globe } from "lucide-react";
import { Collapse } from "@/components/Collapse.tsx";
import type { AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";
import { SCROLLBAR_NONE } from "@/lib/styles.ts";
import { useCapExpand } from "@/lib/useCapExpand.ts";

/**
 * The AI Search sources section (Vane's MessageSources): a compact set of
 * source cards — title on top, favicon + domain + global [n] below — the
 * first four inline, the rest behind the section's toggle.  The toggle
 * NEVER MOVES: it sits right after the inline cards in both states (the
 * old chip lived at the tail of the expanded list, where nobody found
 * it), the extra cards ride a Collapse so the reveal folds in both
 * directions, and the button carries aria-expanded + the rotating
 * chevron.  A card opens the source page; citation [n] chips in the
 * answer jump instead.
 *
 * ONE responsive markup, two presentations: a 2-column grid below lg
 * (stacked page flow) and a vertical card list from lg (the run's right
 * rail — the wrapper carries the sticky/width classes, the list scrolls
 * internally so a 20-source run cannot push the page height around).
 */

const INLINE_CARDS = 4;

function SourceCard({ source }: { source: AiSearchSource }) {
  const t = useT();
  return (
    <a
      className="flex flex-col gap-2 rounded-lg bg-surface-2/70 p-3 transition-colors hover:bg-surface-2 lg:flex-row lg:items-center lg:gap-2.5 lg:p-2.5"
      data-ai-n={source.n}
      href={source.url}
      rel="noreferrer"
      target="_blank"
    >
      <span className="hidden size-4.5 shrink-0 items-center justify-center lg:flex">
        {source.favicon ? (
          <img alt="" aria-hidden="true" className="size-4 rounded object-contain" src={source.favicon} />
        ) : (
          <Globe aria-hidden="true" className="size-4 text-ink-3" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-1.5 lg:block">
          <span className="block truncate text-xs font-medium text-ink" dir="auto">
            {source.title}
          </span>
          {source.crawled ? (
            <span
              className="flex shrink-0 items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium leading-none text-accent lg:mt-0.5"
              title={t("ai_source_crawled")}
            >
              <BookOpen aria-hidden="true" className="size-2.5" />
              {t("ai_source_crawled")}
            </span>
          ) : null}
        </span>
        <span className="mt-1.5 flex items-center justify-between gap-1.5 lg:mt-0.5">
          <span className="flex min-w-0 items-center gap-1">
            <span className="flex size-3.5 shrink-0 items-center justify-center lg:hidden">
              {source.favicon ? (
                <img alt="" aria-hidden="true" className="size-3.5 rounded object-contain" src={source.favicon} />
              ) : (
                <Globe aria-hidden="true" className="size-3.5 text-ink-3" />
              )}
            </span>
            <span className="truncate text-xs text-ink-3">{source.netloc}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-ink-3">
            <span aria-hidden="true" className="size-1 rounded-full bg-ink-3" />
            {source.n}
          </span>
        </span>
      </span>
      {source.img ? (
        // the result's own thumbnail, pinned to the row end (the
        // infobox-side card language) -- Google's sources carry the same
        // preview; mobile's two-column grid stays compact without it
        <img
          alt=""
          aria-hidden="true"
          className="hidden h-10 w-14 shrink-0 rounded-lg object-cover object-top lg:block"
          decoding="async"
          loading="lazy"
          src={source.img}
        />
      ) : null}
    </a>
  );
}

export function AiSearchSources({ sources }: { sources: AiSearchSource[] }) {
  const t = useT();
  const cap = useCapExpand(sources.length, INLINE_CARDS);
  if (sources.length === 0) {
    return null;
  }
  return (
    <section aria-label={t("ai_search_sources")}>
      <div className="flex items-center gap-2">
        <BookOpen aria-hidden="true" className="size-4.5 shrink-0 text-ink-3" />
        <h3 className="text-base font-semibold text-ink">{t("ai_search_sources")}</h3>
        <span className="shrink-0 text-xs tabular-nums text-ink-3">{sources.length}</span>
      </div>
      <div
        className={`mt-3 grid grid-cols-2 gap-2 lg:mt-2 lg:flex lg:max-h-[calc(100vh-6rem)] lg:flex-col lg:overflow-y-auto lg:pe-1 ${SCROLLBAR_NONE}`}
      >
        {sources.slice(0, INLINE_CARDS).map((source) => (
          <SourceCard key={source.n} source={source} />
        ))}
        {/* the reveal folds via the house Collapse; a 0-height wrapper
            still costs its grid gaps, so the closed state cancels one */}
        <Collapse className={`order-last ${cap.expanded ? "" : "-mb-2"}`} open={cap.expanded}>
          <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-col">
            {sources.slice(INLINE_CARDS).map((source) => (
              <SourceCard key={source.n} source={source} />
            ))}
          </div>
        </Collapse>
        {/* the toggle's slot is FIXED — right after the inline cards in
            both states — so the collapse control is always where the
            expand one was */}
        <button
          aria-expanded={cap.expanded}
          className="flex flex-col gap-2 rounded-lg bg-surface-2/70 p-3 text-xs text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink lg:flex-row lg:items-center lg:gap-2.5 lg:p-2.5"
          data-view-more=""
          onClick={cap.toggle}
          type="button"
        >
          {!cap.expanded ? (
            <span className="flex items-center gap-1">
              {sources
                .slice(INLINE_CARDS, INLINE_CARDS + 3)
                .map((source) =>
                  source.favicon ? (
                    <img
                      alt=""
                      aria-hidden="true"
                      className="size-4 rounded-lg object-contain"
                      key={source.n}
                      src={source.favicon}
                    />
                  ) : (
                    <Globe aria-hidden="true" className="size-4 text-ink-3" key={source.n} />
                  ),
                )}
            </span>
          ) : null}
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">
              {cap.expanded ? t("show_less") : t("ai_search_view_more", { n: cap.hidden })}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={`size-3 shrink-0 transition-transform ${cap.expanded ? "rotate-180" : ""}`}
            />
          </span>
        </button>
      </div>
    </section>
  );
}

/** Streaming placeholder: pulsing source cards shown while the agent's
    searches are still running (or before the first sources arrive) so the
    section occupies its final footprint -- grid below lg, rail list from
    lg (the same two presentations as the real section). */
export function AiSearchSourcesSkeleton() {
  const t = useT();
  return (
    <section aria-busy="true" aria-label={t("ai_search_sources")}>
      <div className="flex items-center gap-2">
        <BookOpen aria-hidden="true" className="size-4.5 shrink-0 text-ink-3" />
        <h3 className="text-base font-semibold text-ink">{t("ai_search_sources")}</h3>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 lg:mt-2 lg:flex lg:flex-col">
        {[0, 1, 2, 3].map((i) => (
          <div className="h-[62px] animate-pulse rounded-lg bg-surface-2/70 lg:h-11" key={i} />
        ))}
      </div>
    </section>
  );
}
