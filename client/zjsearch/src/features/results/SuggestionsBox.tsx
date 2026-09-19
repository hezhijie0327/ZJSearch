// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n.ts";
import { scrollBehavior } from "@/lib/motion.ts";
import { DISABLED, SCROLLBAR_NONE } from "@/lib/styles.ts";
import type { SearchPageData } from "@/lib/types.ts";

export function SuggestionsBox({ data, onSearch }: { data: SearchPageData; onSearch: (q: string) => void }) {
  const t = useT();
  const stripRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }
    const maxScroll = strip.scrollWidth - strip.clientWidth;
    setCanLeft(strip.scrollLeft > 2);
    setCanRight(strip.scrollLeft < maxScroll - 2);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when a new query swaps the suggestion set
  useLayoutEffect(() => {
    measure();
  }, [data.suggestions, measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  if (data.suggestions.length === 0) {
    return null;
  }

  const page = (direction: -1 | 1) => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }
    strip.scrollBy({ left: direction * strip.clientWidth * 0.8, behavior: scrollBehavior() });
  };

  // buttons are persistent so flipping state never shifts the chips; a
  // larger touch target on mobile (36px) collapsing to 28px with a pointer
  const arrowClass = `flex size-9 shrink-0 items-center justify-center rounded-full text-ink-3 transition hover:bg-surface-2 hover:text-ink sm:size-7 ${DISABLED}`;
  return (
    <div className="flex items-center gap-1">
      <button
        aria-label={t("previous_page")}
        className={arrowClass}
        disabled={!canLeft}
        onClick={() => {
          page(-1);
        }}
        type="button"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <div
        className={`flex min-w-0 flex-1 gap-1.5 overflow-x-auto ${SCROLLBAR_NONE}`}
        onScroll={measure}
        ref={stripRef}
      >
        {data.suggestions.map((suggestion) => (
          <button
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-accent-soft hover:text-accent"
            dir="auto"
            key={suggestion.q}
            onClick={() => {
              onSearch(suggestion.q);
            }}
            type="button"
          >
            <Search className="size-3.5 shrink-0 text-ink-3" />
            <span className="max-w-40 truncate">{suggestion.title}</span>
          </button>
        ))}
      </div>
      <button
        aria-label={t("next_page")}
        className={arrowClass}
        disabled={!canRight}
        onClick={() => {
          page(1);
        }}
        type="button"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  );
}
