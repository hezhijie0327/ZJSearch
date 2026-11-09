// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "@/lib/i18n.ts";
import { OUTLINE_PILL } from "@/lib/styles.ts";

/** Shared pill button for the prev/next arrows (numbered pages swap the
    border for the accent fill when current); the px-3/h-9 trim is the
    compact pager variant of the outlined pill. */
const pageBtn = `${OUTLINE_PILL} px-3 h-9`;

/** Numbered pagination window (up to 11 pages, sliding after page 5). */
export function Pagination({
  pageno,
  paging,
  onPage,
}: {
  pageno: number;
  paging: boolean;
  onPage: (pageno: number) => void;
}) {
  const t = useT();
  if (!paging && pageno <= 1) {
    return null;
  }
  const hasPrev = pageno > 1;
  const hasNext = paging;
  let start = 1;
  let end = 11;
  if (pageno > 5) {
    start = pageno - 4;
    end = pageno + 6;
  }
  const pages: number[] = [];
  for (let page = start; page < end; page += 1) {
    pages.push(page);
  }

  return (
    <nav aria-label={t("pagination")} className="mt-6 flex flex-wrap items-center justify-center gap-1.5 pb-4">
      {hasPrev ? (
        <button
          aria-label={t("previous_page")}
          className={pageBtn}
          onClick={() => {
            onPage(pageno - 1);
          }}
          type="button"
        >
          <ChevronLeft className="size-3.5" />
          <span className="hidden sm:inline">{t("previous_page")}</span>
        </button>
      ) : null}
      {pages.map((page) => (
        <button
          aria-current={page === pageno ? "page" : undefined}
          className={`grid size-9 place-items-center rounded-full text-[13px] transition-colors ${
            page === pageno
              ? "bg-accent-strong font-medium text-accent-contrast"
              : "border border-line bg-surface text-ink-2 hover:border-accent hover:text-accent"
          }`}
          key={page}
          onClick={() => {
            if (page !== pageno) {
              onPage(page);
            }
          }}
          type="button"
        >
          {page}
        </button>
      ))}
      {hasNext ? (
        <button
          aria-label={t("next_page")}
          className={pageBtn}
          onClick={() => {
            onPage(pageno + 1);
          }}
          type="button"
        >
          <span className="hidden sm:inline">{t("next_page")}</span>
          <ChevronRight className="size-3.5" />
        </button>
      ) : null}
    </nav>
  );
}
