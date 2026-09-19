// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
import { imageAlt } from "@/lib/format.ts";

/** Poster wall for the movies category (`!movies`, tmdb / imdb): portrait
    posters in a denser grid, mirroring the video grid's tile language. */

import { Clapperboard } from "lucide-react";
import { ResultLink } from "@/features/results/cardParts.tsx";
import { TileCell, TileEngines, TileFavicon, TileThumb, TileTitle } from "@/features/results/Tile.tsx";
import type { GlobalData, ResultItem } from "@/lib/types.ts";

export function PosterGrid({
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
        className="relative block aspect-[2/3] overflow-hidden rounded-xl bg-surface-2"
        globals={globals}
        result={result}
      >
        <TileThumb
          alt={imageAlt(result)}
          eager={indexOffset + index < 4}
          placeholder={
            <span className="grid size-full place-items-center text-ink-3">
              <Clapperboard className="size-8" />
            </span>
          }
          src={result.thumbnail}
        />
        {result.favicon ? <TileFavicon src={result.favicon} /> : null}
      </ResultLink>
      <TileTitle globals={globals} result={result} />
      {result.content_html ? (
        <p
          className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-2"
          dangerouslySetInnerHTML={{ __html: result.content_html }}
          dir="auto"
        />
      ) : null}
      <div className="mt-auto pt-1.5">
        <TileEngines result={result} />
      </div>
    </TileCell>
  ));
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 @sm:grid-cols-3 @[40rem]:grid-cols-4 @[46rem]:grid-cols-5 @5xl:grid-cols-6">
      {cells}
    </div>
  );
}
