// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Globe, Package, Tag, Truck } from "lucide-react";
import { ResultLink } from "@/features/results/cardParts.tsx";
import { TileCell, TileEngines, TileThumb, TileTitle } from "@/features/results/Tile.tsx";
import { imageAlt } from "@/lib/format.ts";
import type { GlobalData, ResultItem } from "@/lib/types.ts";

export function ProductGrid({
  results,
  globals,
  selected,
  indexOffset = 0,
}: {
  results: ResultItem[];
  globals: GlobalData;
  selected?: number;
  /** hotkey indices are page-global: offset by the grid's first result index */
  indexOffset?: number;
}) {
  const cells = results.map((result, index) => (
    <TileCell hotkeyIndex={indexOffset + index} key={`${result.url}-${index}`} selected={selected}>
      <ResultLink
        className="relative block aspect-square overflow-hidden rounded-xl bg-surface-2"
        globals={globals}
        result={result}
      >
        <TileThumb
          alt={imageAlt(result)}
          placeholder={
            <span className="grid size-full place-items-center text-ink-3">
              <Package className="size-8" />
            </span>
          }
          src={result.thumbnail}
        />
      </ResultLink>
      <TileTitle globals={globals} result={result} />
      {result.price ? (
        <p className="mt-1 inline-flex items-center gap-1 text-base font-semibold text-ink">
          <Tag className="size-3 shrink-0 text-ink-3" />
          {result.price}
        </p>
      ) : null}
      <div className="mt-1.5 flex flex-col gap-0.5 text-xs text-ink-3">
        {result.shipping ? (
          <span className="inline-flex items-center gap-1">
            <Truck className="size-3 shrink-0" />
            {result.shipping}
          </span>
        ) : null}
        {result.source_country ? (
          <span className="inline-flex items-center gap-1">
            <Globe className="size-3 shrink-0" />
            {result.source_country}
          </span>
        ) : null}
      </div>
      <div className="mt-auto pt-1.5">
        <TileEngines result={result} />
      </div>
    </TileCell>
  ));
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 @sm:grid-cols-3 @[40rem]:grid-cols-4 @[46rem]:grid-cols-5">
      {cells}
    </div>
  );
}
