// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronLeft, Info, RefreshCw, Search, SearchX } from "lucide-react";
import { PaperEmpty } from "@/components/PaperEmpty.tsx";
import { useT } from "@/lib/i18n.ts";
import { PAPER_STRIP } from "@/lib/styles.ts";
import type { SearchPageData } from "@/lib/types.ts";

export function NoResults({
  pageno,
  hasInfobox,
  onPrev,
}: {
  pageno: number;
  hasInfobox: boolean;
  /** wired by ResultsPage: a real 「previous page」 action on later pages */
  onPrev?: () => void;
}) {
  const t = useT();
  const firstPage = pageno === 1;
  if (hasInfobox && firstPage) {
    // the infobox above already answers the query visually — a one-line
    // notice instead of the full empty-state composition
    return (
      <div className="rounded-2xl border border-line bg-surface p-4 text-sm text-ink-2 animate-fade-up">
        <p className="flex items-center gap-2">
          <Info className="size-4 shrink-0 text-accent" />
          {t("no_web_results")}
        </p>
      </div>
    );
  }
  return (
    <PaperEmpty
      hint={firstPage ? t("try_other_query") : undefined}
      icon={SearchX}
      line={firstPage ? t("no_results_found") : t("go_previous_page")}
      title={firstPage ? t("sorry") : t("no_more_results")}
    >
      {firstPage ? (
        <button
          className={`${PAPER_STRIP} -rotate-1 px-4 py-2 [--strip:var(--surface)]`}
          onClick={() => window.location.reload()}
          type="button"
        >
          <RefreshCw className="size-3.5" />
          {t("refresh_page")}
        </button>
      ) : onPrev ? (
        <button
          className={`${PAPER_STRIP} -rotate-1 px-4 py-2 [--strip:var(--surface)]`}
          onClick={onPrev}
          type="button"
        >
          <ChevronLeft className="size-3.5" />
          {t("previous_page")}
        </button>
      ) : null}
    </PaperEmpty>
  );
}

export function Corrections({ data, onSearch }: { data: SearchPageData; onSearch: (q: string) => void }) {
  const t = useT();
  if (data.corrections.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-ink-3">{t("try_searching_for")}</span>
      {data.corrections.map((correction) => (
        <button
          className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent-strong hover:text-accent-contrast"
          dir="auto"
          key={correction.q}
          onClick={() => {
            onSearch(correction.q);
          }}
          type="button"
        >
          <Search className="size-3.5 shrink-0" />
          {correction.title}
        </button>
      ))}
    </div>
  );
}
