// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookOpen, Globe } from "lucide-react";
import { CapChip } from "@/components/CapChip.tsx";
import type { AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";
import { useCapExpand } from "@/lib/useCapExpand.ts";

/**
 * The AI Search sources section (Vane's MessageSources): a compact grid of
 * source cards — title on top, favicon + domain + global [n] below — the
 * first four inline, the rest behind a view-all card that toggles back
 * (useCapExpand + CapChip, the house cap-and-expand pair).  A card opens
 * the source page; citation [n] chips in the answer jump instead.
 */

const INLINE_CARDS = 4;

export function AiSearchSources({ sources }: { sources: AiSearchSource[] }) {
  const t = useT();
  const cap = useCapExpand(sources.length, INLINE_CARDS);
  if (sources.length === 0) {
    return null;
  }
  const shown = cap.expanded ? sources : sources.slice(0, INLINE_CARDS);
  return (
    <section aria-label={t("ai_search_sources")}>
      <div className="flex items-center gap-2">
        <BookOpen aria-hidden="true" className="size-5 text-ink-3" />
        <h3 className="text-xl font-medium text-ink">{t("ai_search_sources")}</h3>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {shown.map((source) => (
          <a
            className="flex flex-col gap-2 rounded-lg bg-surface-2/70 p-3 transition-colors hover:bg-surface-2"
            href={source.url}
            key={source.n}
            rel="noreferrer"
            target="_blank"
          >
            <p className="truncate text-xs font-medium text-ink">{source.title}</p>
            <div className="flex items-center justify-between">
              <span className="flex min-w-0 items-center gap-1">
                {source.favicon ? (
                  <img alt="" aria-hidden="true" className="size-4 rounded-lg object-contain" src={source.favicon} />
                ) : (
                  <Globe aria-hidden="true" className="size-4 text-ink-3" />
                )}
                <span className="truncate text-xs text-ink-3">{source.netloc}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-ink-3">
                <span aria-hidden="true" className="size-1 rounded-full bg-ink-3" />
                {source.n}
              </span>
            </div>
          </a>
        ))}
        {!cap.expanded && cap.hidden > 0 ? (
          <button
            aria-expanded={false}
            aria-label={t("ai_search_view_more", { n: cap.hidden })}
            className="flex flex-col gap-2 rounded-lg bg-surface-2/70 p-3 transition-colors hover:bg-surface-2"
            onClick={cap.toggle}
            type="button"
          >
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
            <span className="truncate text-xs text-ink-3">{t("ai_search_view_more", { n: cap.hidden })}</span>
          </button>
        ) : null}
        {cap.expanded ? (
          <CapChip
            className="flex items-center justify-center rounded-lg bg-surface-2/70 p-3 text-xs text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            expanded
            hidden={cap.hidden}
            onToggle={cap.toggle}
          />
        ) : null}
      </div>
    </section>
  );
}

/** Streaming placeholder: pulsing source cards shown while the agent's
    searches are still running (or before the first sources arrive) so the
    section occupies its final footprint. */
export function AiSearchSourcesSkeleton() {
  const t = useT();
  return (
    <section aria-busy="true" aria-label={t("ai_search_sources")}>
      <div className="flex items-center gap-2">
        <BookOpen aria-hidden="true" className="size-5 text-ink-3" />
        <h3 className="text-xl font-medium text-ink">{t("ai_search_sources")}</h3>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div className="h-[62px] animate-pulse rounded-lg bg-surface-2/70" key={i} />
        ))}
      </div>
    </section>
  );
}
