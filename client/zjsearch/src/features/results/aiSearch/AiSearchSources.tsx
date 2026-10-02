// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookOpen, ChevronDown, Globe, History } from "lucide-react";
import { useState } from "react";
import type { AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";
import { useCapExpand } from "@/lib/useCapExpand.ts";

const INLINE_CARDS = 4;

/**
 * The AI Search sources section (Vane's MessageSources): a compact set of
 * source cards — title on top, favicon + domain + global [n] below — the
 * first four inline, the rest behind the section's toggle.  The toggle is
 * ALWAYS the section's last element (the original card shape with a
 * favicon preview of what's hidden): 查看全部 below the inline cards,
 * 收起 below the revealed ones -- it never sits mid-grid.  The revealed
 * list is HEIGHT-BOUNDED with its own scroll, so a 90-source run reads
 * as a bounded block, not an endless page.  A card opens the source
 * page; citation [n] chips in the answer jump instead.
 */

/** The uniform favicon frame: every card anchors its left edge with the
    same size/shape chip -- an image when the resolver has one, the Globe
    glyph when it does not OR the image fails at runtime, so with-icon and
    without-icon cards render identically. */
function SourceFavicon({ source }: { source: AiSearchSource }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[5px] bg-surface ring-1 ring-line">
      {source.favicon && !failed ? (
        <img
          alt=""
          aria-hidden="true"
          className="size-3.5 object-contain"
          onError={() => {
            setFailed(true);
          }}
          src={source.favicon}
        />
      ) : (
        <Globe aria-hidden="true" className="size-3 text-ink-3" />
      )}
    </span>
  );
}

function SourceCard({ source }: { source: AiSearchSource }) {
  const t = useT();
  return (
    <a
      className={`flex flex-col gap-2 rounded-lg bg-surface-2/70 p-3 transition-colors hover:bg-surface-2 lg:flex-row lg:items-center lg:gap-2.5 lg:p-2.5 ${
        // a read-in-full card carries a thin amber ring: the model verified
        // this source first-hand -- scannable at a glance, layout unchanged
        source.crawled ? "ring-1 ring-accent-soft" : ""
      }`}
      data-ai-n={source.n}
      href={source.url}
      rel="noreferrer"
      target="_blank"
    >
      <span className="hidden lg:flex">
        <SourceFavicon source={source} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-ink" dir="auto">
          {source.title}
        </span>
        {source.content ? (
          // the result's SearXNG snippet: two capped lines under the title
          // (mobile stacks it full-width, the desktop row keeps one line
          // before the domain strip)
          <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-ink-3 lg:mt-0.5" dir="auto">
            {source.content}
          </span>
        ) : null}
        <span className="mt-1.5 flex items-center justify-between gap-1.5 lg:mt-0.5">
          <span className="flex min-w-0 items-center gap-1">
            <span className="lg:hidden">
              <SourceFavicon source={source} />
            </span>
            <span className="truncate text-xs text-ink-3">{source.netloc}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-ink-3">
            {/* the read-in-full / history marks ride a FIXED-WIDTH slot:
                with a badge present or not, the [n] number stays
                right-aligned across crawled, recalled and plain cards */}
            <span className="flex w-4 shrink-0 items-center justify-end">
              {source.crawled ? (
                <span
                  aria-label={t("ai_source_crawled")}
                  className="inline-flex size-4 items-center justify-center rounded-full bg-accent-soft text-accent"
                  role="img"
                  title={t("ai_source_crawled")}
                >
                  <BookOpen aria-hidden="true" className="size-2.5" />
                </span>
              ) : source.history ? (
                <span
                  aria-label={t("ai_source_history")}
                  className="inline-flex size-4 items-center justify-center rounded-full bg-surface text-ink-3 ring-1 ring-line"
                  role="img"
                  title={t("ai_source_history")}
                >
                  <History aria-hidden="true" className="size-2.5" />
                </span>
              ) : source.pastRefs ? (
                // the cross-session trust mark: this url surfaced in N past
                // runs (the pre-run PGlite recall's count) -- the badge tier's
                // 11px floor, the count IS the label
                <span
                  aria-label={t("knowledge_source_refs", { n: String(source.pastRefs) })}
                  className="inline-flex size-4 items-center justify-center rounded-full bg-surface text-[11px] font-medium leading-none tabular-nums text-ink-3 ring-1 ring-line"
                  role="img"
                  title={t("knowledge_source_refs", { n: String(source.pastRefs) })}
                >
                  ×{source.pastRefs}
                </span>
              ) : null}
            </span>
            <span aria-hidden="true" className="size-1 rounded-full bg-ink-3" />
            {source.n}
          </span>
        </span>
      </span>
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
      {cap.expanded ? (
        // the revealed list is a scroll box sized to EIGHT visible cards
        // (4 rows x 2 cols on mobile, 8 rows on the desktop rail) -- the
        // rest scrolls inside, the 收起 toggle below stays reachable, and
        // the page height never moves with the run's source count
        <div
          aria-label={t("ai_search_sources")}
          className="mt-3 max-h-[17rem] overflow-y-auto overscroll-contain lg:mt-2 lg:max-h-[25.5rem] lg:pe-1"
          role="region"
        >
          <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-col">
            {sources.map((source) => (
              <SourceCard key={source.n} source={source} />
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2 lg:flex lg:flex-col">
          {sources.slice(0, INLINE_CARDS).map((source) => (
            <SourceCard key={source.n} source={source} />
          ))}
        </div>
      )}
      {/* the toggle is ALWAYS the section's last element: the original
          card-shaped 查看全部 (with a favicon preview of what's hidden)
          when collapsed, the same shape as 收起 below the bounded list
          when expanded -- it never sits mid-grid */}
      <button
        aria-expanded={cap.expanded}
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-surface-2/70 p-3 text-xs text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
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
      <div className="mt-3 grid max-h-[22rem] grid-cols-2 gap-2 overflow-y-auto lg:mt-2 lg:flex lg:max-h-[calc(100vh-6rem)] lg:flex-col">
        {[0, 1, 2, 3].map((i) => (
          <div className="h-[62px] animate-pulse rounded-lg bg-surface-2/70 lg:h-11" key={i} />
        ))}
      </div>
    </section>
  );
}
