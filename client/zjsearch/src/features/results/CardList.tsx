// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import clsx from "clsx";
import type { ReactNode } from "react";
import { ResultCard } from "@/features/results/cards/ResultCard.tsx";
import { ResultRow } from "@/features/results/ResultRow.tsx";
import type { GlobalData, ResultItem } from "@/lib/types.ts";

/** One entry per rendered row, carrying its page-global hotkey index. */
interface CardListEntry {
  result: ResultItem;
  index: number;
}

export function entriesOf(results: readonly ResultItem[]): CardListEntry[] {
  return results.map((result, index) => ({ result, index }));
}

/**
 * Relevance-ordered card list: the presentation of category intent pages
 * without a dedicated grid and the fallback inside mixed-search blocks.
 * `renderItem` swaps the card (dictionary entries, papers); the default
 * renders the template-dispatched `ResultCard`.  `spaced` keeps highlighted
 * (selected / hovered) cards from touching — mixed blocks turn it off to
 * match their tighter rhythm.
 */
export function CardList({
  entries,
  globals,
  selected,
  autoOpenMap = false,
  spaced = true,
  className,
  renderItem,
}: {
  entries: CardListEntry[];
  globals: GlobalData;
  selected: number;
  autoOpenMap?: boolean;
  spaced?: boolean;
  className?: string;
  renderItem?: (result: ResultItem, index: number) => ReactNode;
}) {
  return (
    <div className={clsx(spaced && "space-y-1", className)}>
      {entries.map(({ result, index }) => (
        <ResultRow index={index} key={index} selected={selected === index}>
          {renderItem ? (
            renderItem(result, index)
          ) : (
            <ResultCard autoOpenMap={autoOpenMap} eager={index < 4} globals={globals} result={result} />
          )}
        </ResultRow>
      ))}
    </div>
  );
}
