// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookOpen, ChevronDown, Globe, History } from "lucide-react";
import { useState } from "react";
import type { AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { Snippet } from "@/features/results/cardParts.tsx";
import { useT } from "@/lib/i18n.ts";
import { escapeHtml } from "@/lib/print.ts";
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
  const open = () => {
    window.open(source.url, "_blank", "noopener");
  };
  return (
    // the REGULAR result card's chrome (rounded-2xl, borderless, p-4,
    // hover:bg-surface) and hierarchy (pretty-url line, title, snippet):
    // one design system -- the AI-specific extras (#n, the read marks)
    // ride the footer where the engines chips would sit
    <div
      className="group relative rounded-2xl p-4 transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      data-ai-n={source.n}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          open();
        }
      }}
      role="link"
      tabIndex={0}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
        <SourceFavicon source={source} />
        <span className="truncate" dir="ltr">
          {source.netloc}
        </span>
      </div>
      <a
        className="mt-1 line-clamp-1 block text-base font-medium leading-6 text-ink decoration-accent/50 underline-offset-2 hover:text-accent hover:underline"
        dir="auto"
        href={source.url}
        onClick={(event) => event.stopPropagation()}
        rel="noreferrer"
        target="_blank"
      >
        {source.title}
      </a>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only keeps the snippet's toggle off the card's link */}
      <div
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.stopPropagation();
          }
        }}
      >
        <Snippet className="mt-1.5" contentHtml={escapeHtml(source.content || t("no_description"))} />
      </div>
      <div className="mt-1.5 flex items-center gap-1 text-xs tabular-nums text-ink-3">
        {/* the read marks ride a FIXED-WIDTH slot: with a badge present or
            not, the #n stays aligned across crawled, recalled and plain
            cards */}
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
        <span>#{source.n}</span>
      </div>
    </div>
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
          className="mt-3 max-h-[17rem] overflow-y-auto overscroll-contain [scrollbar-gutter:stable] lg:mt-2 lg:max-h-[25.5rem] lg:pe-1"
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
