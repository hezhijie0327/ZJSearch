// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Mixed search: one collapsible block per original search category (pure
 * relevance order inside), in tab order by default; every block renders the
 * same full presentation as its single-category page and can be folded away
 * via its header.
 */

import { useMemo } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import { AppsGrid } from "@/features/results/AppsGrid.tsx";
import { collectBlocks } from "@/features/results/blocks.ts";
import { CardList } from "@/features/results/CardList.tsx";
import { FilesGrid } from "@/features/results/FilesGrid.tsx";
import { GroupHeader } from "@/features/results/GroupHeader.tsx";
import { ImageGrid } from "@/features/results/image/ImageGrid.tsx";
import { MusicGrid } from "@/features/results/MusicGrid.tsx";
import { PackageGrid } from "@/features/results/PackageGrid.tsx";
import { PosterGrid } from "@/features/results/PosterGrid.tsx";
import { ProductGrid } from "@/features/results/ProductGrid.tsx";
import { VideoGrid } from "@/features/results/VideoGrid.tsx";
import { categoryLabel } from "@/lib/categories.ts";
import { useT } from "@/lib/i18n.ts";
import type { GlobalData, ResultItem } from "@/lib/types.ts";

/** The grid views for the categories that have one; everything else falls
    back to the standard card list (papers/packages cards dispatch inside).
    Grid cells take `indexOffset` so hotkey indices stay page-global. */
function CategoryCollectionView({
  category,
  results,
  globals,
  selected,
  indexOffset,
  autoOpenMap,
}: {
  category: string;
  results: ResultItem[];
  globals: GlobalData;
  selected: number;
  indexOffset: number;
  autoOpenMap: boolean;
}) {
  switch (category) {
    case "images":
    case "stock images":
      return <ImageGrid results={results} />;
    case "videos":
      return <VideoGrid globals={globals} indexOffset={indexOffset} results={results} selected={selected} />;
    case "music":
      return <MusicGrid globals={globals} indexOffset={indexOffset} results={results} selected={selected} />;
    case "files":
      return <FilesGrid globals={globals} indexOffset={indexOffset} results={results} selected={selected} />;
    case "movies":
      return <PosterGrid globals={globals} indexOffset={indexOffset} results={results} selected={selected} />;
    case "packages":
      return <PackageGrid globals={globals} indexOffset={indexOffset} results={results} selected={selected} />;
    case "apps":
      return <AppsGrid globals={globals} indexOffset={indexOffset} results={results} selected={selected} />;
    case "products":
      return <ProductGrid globals={globals} indexOffset={indexOffset} results={results} selected={selected} />;
    default:
      return (
        <CardList
          autoOpenMap={autoOpenMap}
          entries={results.map((result, index) => ({ result, index: indexOffset + index }))}
          globals={globals}
          selected={selected}
          spaced={false}
        />
      );
  }
}

export function CategoryBlocks({
  results,
  globals,
  selected,
  autoOpenMap,
  collapsedBlocks,
  onToggleBlock,
}: {
  results: ResultItem[];
  globals: GlobalData;
  selected: number;
  autoOpenMap: boolean;
  collapsedBlocks: Record<string, boolean>;
  onToggleBlock: (key: string) => void;
}) {
  const t = useT();
  // one block per original search category, in first-appearance (tab) order
  const blocks = useMemo(() => collectBlocks(results), [results]);
  const orderedKeys = [...blocks.keys()];
  return (
    <>
      {orderedKeys.map((key) => {
        const items = blocks.get(key) ?? [];
        const collapsed = Boolean(collapsedBlocks[key]);
        const blockResults = items.map(({ result }) => result);
        const indexOffset = items[0]?.index ?? 0;
        return (
          <section className="mt-6 first:mt-0" data-block-key={key} key={key}>
            <GroupHeader
              category={key}
              collapsed={collapsed}
              count={items.length}
              label={categoryLabel(key, t)}
              onToggle={() => {
                onToggleBlock(key);
              }}
            />
            <Collapse className={collapsed ? "" : "mt-1"} open={!collapsed} unmountAfterHide>
              <div className="space-y-1">
                <CategoryCollectionView
                  autoOpenMap={autoOpenMap}
                  category={key}
                  globals={globals}
                  indexOffset={indexOffset}
                  results={blockResults}
                  selected={selected}
                />
              </div>
            </Collapse>
          </section>
        );
      })}
    </>
  );
}
