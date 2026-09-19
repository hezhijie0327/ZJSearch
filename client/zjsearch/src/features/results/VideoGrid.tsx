// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Play } from "lucide-react";
import { useState } from "react";
import { ResultLink } from "@/features/results/cardParts.tsx";
import {
  TileBadge,
  TileCell,
  TileCenterAction,
  TileCloseAction,
  TileEngines,
  TileFavicon,
  TileMeta,
  TileMetaAuthor,
  TileMetaDate,
  TileMetaViews,
  TileThumb,
  TileTitle,
} from "@/features/results/Tile.tsx";
import { formatDate, formatLength, imageAlt } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import type { GlobalData, ResultItem } from "@/lib/types.ts";

export function VideoGrid({
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
  const t = useT();
  const [playing, setPlaying] = useState<number | null>(null);
  const cells = results.map((result, index) => {
    const length = formatLength(result.length_display, result.length_seconds);
    const isPlaying = playing === index;
    return (
      <TileCell hotkeyIndex={indexOffset + index} key={`${result.url}-${index}`} selected={selected}>
        <div className="relative">
          <ResultLink
            className="relative block aspect-video overflow-hidden rounded-xl bg-surface-2"
            globals={globals}
            result={result}
          >
            <TileThumb
              alt={imageAlt(result)}
              eager={indexOffset + index < 4}
              placeholder={null}
              src={result.thumbnail}
            />
            {length ? <TileBadge>{length}</TileBadge> : null}
            {result.favicon ? <TileFavicon src={result.favicon} /> : null}
          </ResultLink>
          {result.iframe_src && isPlaying ? (
            <div className="absolute inset-0 z-10 animate-fade-in overflow-hidden rounded-xl border border-line bg-black">
              <iframe
                allowFullScreen
                className="size-full"
                referrerPolicy="origin"
                src={result.iframe_src ?? ""}
                title={result.title_text}
              />
            </div>
          ) : null}
          {result.iframe_src && isPlaying ? (
            <TileCloseAction
              label={t("hide_video")}
              onClick={() => {
                setPlaying(null);
              }}
            />
          ) : result.iframe_src ? (
            <TileCenterAction
              icon={<Play className="size-5 translate-x-px" />}
              label={t("play")}
              onClick={() => {
                setPlaying(index);
              }}
            />
          ) : null}
        </div>
        <TileTitle globals={globals} result={result} />
        <TileMeta
          left={<TileMetaAuthor author={result.author} />}
          right={
            <>
              <TileMetaViews views={result.views} />
              <TileMetaDate date={result.published_date ? formatDate(result.published_date) : null} />
            </>
          }
        />
        <div className="mt-auto pt-1.5">
          <TileEngines result={result} />
        </div>
      </TileCell>
    );
  });
  // density keys off the column width (container queries from the results
  // wrapper): widescreen grows to 4 columns, centered mode drops to 2-3
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-8 @sm:grid-cols-2 @[46rem]:grid-cols-3 @[54rem]:grid-cols-4">
      {cells}
    </div>
  );
}
