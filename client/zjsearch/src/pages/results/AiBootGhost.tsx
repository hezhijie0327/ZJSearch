// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { AiSearchSourcesSkeleton } from "@/features/results/aiSearch/AiSearchSources.tsx";
import type { Translate } from "@/lib/i18n.ts";

/** The AI takeover's boot ghost (page-private): the shape
    AiSearchRunSection renders at zero events — run title, the research
    header with its planning note, the sources rail skeleton — so the
    static boot skeleton (skeleton.html's ai_mode branch + boot.css) hands
    over to React WITHOUT flashing the classic card-list geometry.  Keep
    the class values in sync with the .zjs-boot-ai* family in boot.css. */
export function AiBootGhost({ q, t }: { q: string; t: Translate }) {
  return (
    <div aria-busy="true" className="animate-fade-up space-y-5">
      {/* line-clamp-3 mirrors the run section's collapsed ClampReveal
          (RUN_TITLE_PREVIEW_PX) and the skeleton's .zjs-boot-ai-title clamp
          -- a pasted brief boots at the same three-line height it hands
          over to */}
      <h1 className="line-clamp-3 break-words text-3xl font-medium leading-tight text-ink" dir="auto">
        {q}
      </h1>
      <section aria-label={t("ai_search_process")}>
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true" className="size-5 animate-pulse rounded-full bg-surface-2" />
          <span className="text-xl font-medium text-ink">{t("ai_search_process")}</span>
          <span className="text-xs text-ink-3">{t("ai_elapsed_prefix", { time: "0s" })}</span>
        </div>
        {/* the phase strip's ghost: the three-segment spine paints the
            moment the first phase event lands -- the ghost holds its line
            so the swap never shifts */}
        <div aria-hidden="true" className="mt-2 flex items-center gap-2 px-1 text-xs">
          {["ai_phase_plan", "ai_phase_research", "ai_phase_write"].map((key) => (
            <span className="flex items-center gap-1.5" key={key}>
              <span className="size-1.5 shrink-0 rounded-full bg-ink-3/50" />
              <span className="whitespace-nowrap text-ink-3">{t(key as "ai_phase_plan")}</span>
            </span>
          ))}
        </div>
        <div className="mt-3 rounded-lg border border-line p-3">
          <p className="px-1 py-1 text-xs text-ink-3">{t("ai_search_thinking_plan")}</p>
        </div>
      </section>
      <div className="lg:flex lg:items-start lg:justify-between lg:gap-8">
        <div aria-hidden="true" className="min-w-0 flex-1" />
        <aside className="mt-5 w-full lg:mt-0 lg:w-80 lg:shrink-0 xl:w-96">
          <AiSearchSourcesSkeleton />
        </aside>
      </div>
    </div>
  );
}
