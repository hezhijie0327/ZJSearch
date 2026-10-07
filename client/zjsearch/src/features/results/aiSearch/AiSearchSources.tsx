// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Award, BookOpen, Globe, History, Server } from "lucide-react";
import { useState } from "react";
import { CapChip } from "@/components/CapChip.tsx";
import { Collapse } from "@/components/Collapse.tsx";
import { RailHeader } from "@/features/results/aiSearch/rail/RailSection.tsx";
import type { AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { Snippet, Thumb } from "@/features/results/cardParts.tsx";
import { categoryLabel } from "@/lib/categories.ts";
import { formatScore } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { escapeHtml } from "@/lib/print.ts";
import { CHIP, CHIP_HOVER } from "@/lib/styles.ts";
import { useCapExpand } from "@/lib/useCapExpand.ts";

/**
 * The AI Search sources section (Vane's MessageSources): a compact set of
 * source cards — identity row (favicon + domain + global [n]), title link,
 * clamp-and-reveal snippet, attribution chips.  The list reads
 * NEWEST-FIRST and caps at four cards (cap-and-expand) so a 200-source
 * run leads with what the research just found; a citation click EXPANDS
 * the cap (the parent owns the state) and scrolls the card into view.
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

function SourceCard({ cited, source }: { cited: boolean; source: AiSearchSource }) {
  const t = useT();
  // the traditional presentations' type adaptation: videos carry their
  // duration, torrents their filesize -- one badge string either way
  const isMedia = source.category === "videos" || source.category === "files";
  const { expanded, toggle, hidden } = useCapExpand(source.engines?.length ?? 0, 1);
  return (
    // REDESIGNED narrow-first: each row has ONE job --
    //   identity row: favicon + netloc + read badges + #n (pinned right,
    //   never wraps: netloc truncates)
    //   title: the one and only link
    //   snippet: the clamp-and-reveal
    //   attribution row: the score / engines chips wrap as self-contained
    //   units -- no bare numbers or badges to orphan on a narrow card
    <div
      className="group relative rounded-2xl p-3 transition-colors hover:bg-surface sm:p-4"
      data-ai-cited={cited || undefined}
      data-ai-n={source.n}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
        <SourceFavicon source={source} />
        <span className="min-w-0 truncate" dir="ltr">
          {source.netloc}
        </span>
        {source.category && source.category !== "general" ? (
          <span className="shrink-0 rounded-md bg-surface-2 px-1.5 text-[11px] leading-4 text-ink-3">
            {categoryLabel(source.category, t)}
          </span>
        ) : null}
        <span className="ms-auto flex shrink-0 items-center gap-1.5">
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
          <span className="shrink-0 tabular-nums text-ink-3">#{source.n}</span>
        </span>
      </div>
      <a
        className="mt-1 line-clamp-2 block text-[13px] font-medium leading-5 text-ink decoration-accent/50 underline-offset-2 hover:text-accent hover:underline"
        dir="auto"
        href={source.url}
        rel="noreferrer"
        target="_blank"
      >
        {source.title}
      </a>
      {/* the snippet's toggle stays off the card's link */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only keeps the snippet's toggle off the card's link */}
      <div
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.stopPropagation();
          }
        }}
      >
        <div className="mt-1.5 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Snippet
              contentHtml={escapeHtml(source.content || t("no_description"))}
              textClass="text-[13px] leading-relaxed text-ink-2"
            />
          </div>
          {source.img ? (
            <div className="relative hidden shrink-0 self-start sm:block">
              <Thumb alt="" className="h-16 w-24" src={source.img} />
              {isMedia && source.meta ? (
                <span className="absolute bottom-1 end-1 rounded-md bg-black/70 px-1 py-0.5 text-[11px] font-medium leading-none text-white">
                  {source.meta}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {typeof source.score === "number" || (source.engines?.length ?? 0) > 0 ? (
        // the attribution chips: score + engines (cap-and-expand -- the
        // lead engine sits, "+N" folds the rest) -- chips wrap as
        // self-contained units, nothing bare to orphan
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
          {typeof source.score === "number" ? (
            <span className={`${CHIP} shrink-0 tabular-nums`} title={t("score")}>
              <Award aria-hidden="true" className="size-3 shrink-0" />
              {formatScore(source.score)}
            </span>
          ) : null}
          {source.engines && source.engines.length > 0 ? (
            <>
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
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const RAIL_CAP = 4;
/** The rail list's default footprint: the four newest cards. */

export function AiSearchSources({
  cited,
  sources,
  expanded,
  onToggleExpanded,
}: {
  sources: AiSearchSource[];
  /** the [n] numbers the ANSWER cites -- those cards wear the dashed
      frame (the AI Overview's own cited-source marking) */
  cited: Set<number>;
  /** CONTROLLED cap state (the parent expands it on a citation click and
      may clear it when the user folds the list again) */
  expanded: boolean;
  onToggleExpanded: (next: boolean) => void;
}) {
  const t = useT();
  if (sources.length === 0) {
    return null;
  }
  const hidden = Math.max(0, sources.length - RAIL_CAP);
  // numbering order: the evidence list reads [1] -> [N] (the [n] chips in
  // the answer index into this exact order); the older tail folds in a
  // Collapse (the +N reveal plays as a height animation)
  const view = sources.slice(0, RAIL_CAP);
  const extra = sources.slice(RAIL_CAP);
  return (
    // the rail is viewport-capped and scrolls INSIDE (the aside owns the
    // scroll); this section pins its heading and lists the cards
    <section aria-label={t("ai_search_sources")} className="mb-5">
      <RailHeader count={sources.length} icon={BookOpen} title={t("ai_search_sources")} />
      <div className="mt-3 flex flex-col gap-2 px-1">
        {view.map((source) => (
          <SourceCard cited={cited.has(source.n)} key={source.n} source={source} />
        ))}
      </div>
      <Collapse className={expanded && extra.length > 0 ? "mt-2" : ""} open={expanded && extra.length > 0}>
        <div className="flex flex-col gap-2 px-1">
          {extra.map((source) => (
            <SourceCard cited={cited.has(source.n)} key={source.n} source={source} />
          ))}
        </div>
      </Collapse>
      <CapChip
        className="mt-2 ms-1 inline-flex min-h-6 items-center gap-1 rounded-full border border-line px-2 text-[11px] text-ink-3 transition-colors hover:text-ink"
        expanded={expanded}
        hidden={hidden}
        onToggle={() => {
          onToggleExpanded(!expanded);
        }}
      />
    </section>
  );
}

/** Streaming placeholder: pulsing source cards shown while the agent's
    searches are still running (or before the first sources arrive) so the
    section occupies its final footprint -- four cells, the same cap the
    real section leads with. */
export function AiSearchSourcesSkeleton() {
  const t = useT();
  return (
    <section aria-busy="true" aria-label={t("ai_search_sources")}>
      <div className="flex items-center gap-2">
        <BookOpen aria-hidden="true" className="size-4.5 shrink-0 text-ink-3" />
        <h3 className="text-base font-semibold text-ink">{t("ai_search_sources")}</h3>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {/* one REAL card's resting height (title 2 lines + snippet slot +
            meta row) -- the swap must not grow the rail */}
        {[0, 1, 2, 3].map((i) => (
          <div className="h-[188px] animate-pulse rounded-lg bg-surface-2/70" key={i} />
        ))}
      </div>
    </section>
  );
}
