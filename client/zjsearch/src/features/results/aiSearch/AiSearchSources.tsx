// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Award, BookOpen, Globe, History, Server } from "lucide-react";
import { useState } from "react";
import { CapChip } from "@/components/CapChip.tsx";
import type { AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { Snippet } from "@/features/results/cardParts.tsx";
import { categoryLabel } from "@/lib/categories.ts";
import { formatScore } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { escapeHtml } from "@/lib/print.ts";
import { CHIP, CHIP_HOVER } from "@/lib/styles.ts";
import { useCapExpand } from "@/lib/useCapExpand.ts";

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
  // the traditional presentations' type adaptation: videos carry their
  // duration, torrents their filesize -- one badge string either way
  const isMedia = source.category === "videos" || source.category === "files";
  const { expanded, toggle, hidden } = useCapExpand(source.engines?.length ?? 0, 1);
  return (
    // the REGULAR result card's chrome (rounded-2xl, borderless, p-3/4,
    // hover:bg-surface) and hierarchy (pretty-url line, title, snippet):
    // one design system -- the AI extras (category chip, read marks, #n)
    // and the engines/score row ride where the classic card puts them
    <div className="group relative rounded-2xl p-3 transition-colors hover:bg-surface sm:p-4" data-ai-n={source.n}>
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
            <SourceFavicon source={source} />
            <span className="truncate" dir="ltr">
              {source.netloc}
            </span>
            {source.category && source.category !== "general" ? (
              <span className="shrink-0 rounded-md bg-surface-2 px-1.5 text-[11px] leading-4 text-ink-3">
                {categoryLabel(source.category, t)}
              </span>
            ) : null}
          </div>
          <a
            className="mt-1 line-clamp-2 block min-h-12 text-base font-medium leading-6 text-ink decoration-accent/50 underline-offset-2 hover:text-accent hover:underline"
            dir="auto"
            href={source.url}
            onClick={(event) => event.stopPropagation()}
            rel="noreferrer"
            target="_blank"
          >
            {source.title}
          </a>
          {/* the snippet's toggle stays off the card's link */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only keeps the snippet's toggle off the card's link */}
          <div
            className="min-h-[4.5rem]"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.stopPropagation();
              }
            }}
          >
            <Snippet className="mt-1.5" contentHtml={escapeHtml(source.content || t("no_description"))} />
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
            {typeof source.score === "number" ? (
              <span className={`${CHIP} shrink-0 tabular-nums`} title={t("score")}>
                <Award aria-hidden="true" className="size-3 shrink-0" />
                {formatScore(source.score)}
              </span>
            ) : null}
            {source.engines && source.engines.length > 0 ? (
              // cap-and-expand (the EnginesLine language): the lead engine
              // sits, "+N" folds the rest -- the reveal and its collapse
              // travel as ONE wrapping unit so the chip never orphans
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <span className={`${CHIP} shrink-0`} title={source.engines.join(", ")}>
                  <Server aria-hidden="true" className="size-3 shrink-0" />
                  {source.engines[0]}
                </span>
                {expanded
                  ? source.engines.slice(1).map((engine) => (
                      <span className={`${CHIP} shrink-0`} key={engine}>
                        <Server aria-hidden="true" className="size-3 shrink-0" />
                        {engine}
                      </span>
                    ))
                  : null}
                {hidden > 0 ? (
                  <CapChip
                    className={`${CHIP} shrink-0 ${CHIP_HOVER}`}
                    expanded={expanded}
                    hidden={hidden}
                    onToggle={toggle}
                  />
                ) : null}
              </span>
            ) : null}
            <span className="flex shrink-0 items-center gap-1.5 self-center">
              {/* the read marks ride a FIXED-WIDTH slot: with a badge
                  present or not, the #n stays aligned across crawled,
                  recalled and plain cards */}
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
                    className="inline-flex items-center gap-0.5"
                    title={t("knowledge_source_refs", { n: String(source.pastRefs) })}
                  >
                    <History aria-hidden="true" className="size-3" />
                    {source.pastRefs}×
                  </span>
                ) : null}
              </span>
              <span>#{source.n}</span>
            </span>
          </div>
        </div>
        {source.img ? (
          <div className="relative hidden shrink-0 self-start sm:block">
            <img
              alt=""
              className="h-20 w-28 rounded-lg border border-line object-cover"
              loading="lazy"
              src={source.img}
            />
            {isMedia && source.meta ? (
              <span className="absolute bottom-1 end-1 rounded-md bg-black/70 px-1 py-0.5 text-[11px] font-medium leading-none text-white">
                {source.meta}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AiSearchSources({ sources }: { sources: AiSearchSource[] }) {
  const t = useT();
  if (sources.length === 0) {
    return null;
  }
  return (
    // the rail is viewport-capped and scrolls INSIDE (the aside owns the
    // cap; this section pins its heading and scrolls the cards) -- no
    // expand/collapse toggle: every source is always one scroll away
    <section aria-label={t("ai_search_sources")} className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2">
        <BookOpen aria-hidden="true" className="size-4.5 shrink-0 text-ink-3" />
        <h3 className="text-base font-semibold text-ink">{t("ai_search_sources")}</h3>
        <span className="shrink-0 text-xs tabular-nums text-ink-3">{sources.length}</span>
      </div>
      {/* ~4 cards visible, the rest scroll inside -- on every breakpoint */}
      <div className="mt-3 grid max-h-[22rem] grid-cols-2 gap-2 overflow-y-auto overscroll-contain lg:mt-2 lg:max-h-[42rem] lg:flex lg:flex-col">
        {sources.map((source) => (
          <SourceCard key={source.n} source={source} />
        ))}
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
      <div className="mt-3 grid max-h-[22rem] grid-cols-2 gap-2 overflow-y-auto lg:mt-2 lg:flex lg:max-h-[42rem] lg:flex-col">
        {/* one REAL card's resting height (title 2 lines + snippet slot +
            meta row) -- the swap must not grow the rail */}
        {[0, 1, 2, 3].map((i) => (
          <div className="h-[208px] animate-pulse rounded-lg bg-surface-2/70 lg:h-[188px]" key={i} />
        ))}
      </div>
    </section>
  );
}
