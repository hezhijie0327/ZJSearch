// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Renders the result collection for the page's detected layout — one switch
 * as the single category → presentation mapping (the mixed-search blocks
 * reuse the same views per category in CategoryBlocks).
 */

import type { ReactNode } from "react";
import { AppsGrid } from "@/features/results/AppsGrid.tsx";
import { CardList, entriesOf } from "@/features/results/CardList.tsx";
import { CategoryBlocks } from "@/features/results/CategoryBlocks.tsx";
import { DictionaryCard } from "@/features/results/cards/DictionaryCard.tsx";
import { PaperCard } from "@/features/results/cards/PaperCard.tsx";
import { FilesGrid } from "@/features/results/FilesGrid.tsx";
import { ImageGrid } from "@/features/results/image/ImageGrid.tsx";
import type { ResultsLayout } from "@/features/results/layout.ts";
import { MusicGrid } from "@/features/results/MusicGrid.tsx";
import { PackageGrid } from "@/features/results/PackageGrid.tsx";
import { PosterGrid } from "@/features/results/PosterGrid.tsx";
import { ProductGrid } from "@/features/results/ProductGrid.tsx";
import { VideoGrid } from "@/features/results/VideoGrid.tsx";
import type { GlobalData, ResultItem } from "@/lib/types.ts";

export function ResultsView({
  layout,
  results,
  globals,
  selected,
  collapsedBlocks,
  onToggleBlock,
}: {
  layout: ResultsLayout;
  results: ResultItem[];
  globals: GlobalData;
  selected: number;
  collapsedBlocks: Record<string, boolean>;
  onToggleBlock: (key: string) => void;
}) {
  let view: ReactNode;
  switch (layout.kind) {
    case "images":
      view = <ImageGrid results={results} />;
      break;
    case "videos":
      view = <VideoGrid globals={globals} results={results} selected={selected} />;
      break;
    case "music":
      view = <MusicGrid globals={globals} results={results} selected={selected} />;
      break;
    case "movies":
      view = <PosterGrid globals={globals} results={results} selected={selected} />;
      break;
    case "apps":
      view = <AppsGrid globals={globals} results={results} selected={selected} />;
      break;
    case "packages":
      view = <PackageGrid globals={globals} results={results} selected={selected} />;
      break;
    case "files":
      view = <FilesGrid globals={globals} results={results} selected={selected} />;
      break;
    case "products":
      view = <ProductGrid globals={globals} results={results} selected={selected} />;
      break;
    case "dictionary":
      view = <DictionaryCardList globals={globals} results={results} selected={selected} />;
      break;
    case "science":
      view = <PaperCardList globals={globals} results={results} selected={selected} />;
      break;
    case "list":
      // category intent page: a pure relevance-ordered list in which every
      // type keeps its own card - extracting a type into a strip would break
      // the relevance order. space-y keeps highlighted (selected / hovered)
      // cards from touching, matching the mixed-block lists.
      view = (
        <CardList autoOpenMap={layout.autoOpenMap} entries={entriesOf(results)} globals={globals} selected={selected} />
      );
      break;
    case "mixed":
      view = (
        <CategoryBlocks
          autoOpenMap={layout.autoOpenMap}
          collapsedBlocks={collapsedBlocks}
          globals={globals}
          onToggleBlock={onToggleBlock}
          results={results}
          selected={selected}
        />
      );
      break;
  }
  // one breathing offset below the filter row: grids get more, card lists
  // and blocks sit tighter; mixed needs the relative wrapper for stacking
  const wrapper =
    layout.kind === "mixed"
      ? "relative mt-2"
      : layout.kind === "list" || layout.kind === "dictionary" || layout.kind === "science"
        ? "mt-2"
        : "mt-4";
  return <div className={wrapper}>{view}</div>;
}

function DictionaryCardList({
  globals,
  results,
  selected,
}: {
  globals: GlobalData;
  results: ResultItem[];
  selected: number;
}) {
  return (
    <CardList
      entries={entriesOf(results)}
      globals={globals}
      renderItem={(result) => <DictionaryCard globals={globals} result={result} />}
      selected={selected}
    />
  );
}

function PaperCardList({
  globals,
  results,
  selected,
}: {
  globals: GlobalData;
  results: ResultItem[];
  selected: number;
}) {
  return (
    <CardList
      entries={entriesOf(results)}
      globals={globals}
      renderItem={(result) => <PaperCard globals={globals} result={result} />}
      selected={selected}
    />
  );
}
