// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Files-intent layout: landscape file tiles mirroring the media grids.
    Torrents and file downloads have no cover art, so the tile shows a
    type icon with the detected extension; the filesize takes the badge
    slot and the magnet/torrent action sits in the tile center like the
    media play buttons. */

import { ArrowDown, ArrowUp, Download, FileText, Film, Magnet, Music } from "lucide-react";
import {
  TileBadge,
  TileCell,
  TileCenterAction,
  TileEngines,
  TileFavicon,
  TileMeta,
  TileMetaDate,
  TileTitle,
} from "@/features/results/Tile.tsx";
import { formatDate } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import type { GlobalData, ResultItem } from "@/lib/types.ts";

function detectExtension(title: string): string | null {
  const match = /\.([a-z0-9]{1,4})$/i.exec(title.trim());
  return match?.[1]?.toUpperCase() ?? null;
}

function TileIcon({ result, large = false }: { result: ResultItem; large?: boolean }) {
  const size = large ? "size-10" : "size-5";
  if (result.mtype === "audio") {
    return <Music className={size} />;
  }
  if (result.mtype === "video") {
    return <Film className={size} />;
  }
  return <FileText className={size} />;
}

export function FilesGrid({
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
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 @sm:grid-cols-3 @[46rem]:grid-cols-4 @5xl:grid-cols-5">
      {results.map((result, index) => {
        const extension = detectExtension(result.filename || result.title_text);
        const size = result.filesize || result.size || null;
        const date = result.published_date ? formatDate(result.published_date) : result.time || null;
        const health = result.seed !== undefined || result.leech !== undefined;
        const downloadHref =
          result.torrentfile ||
          (result.embedded && result.mtype !== "audio" && result.mtype !== "video" ? result.embedded : null);
        // the tile's primary action: magnet when present, otherwise the
        // torrent file / direct download
        const primaryHref = result.magnetlink || downloadHref || null;
        const primaryLabel = result.magnetlink
          ? t("magnet_link")
          : result.torrentfile
            ? t("torrent_file")
            : t("download");
        return (
          <TileCell hotkeyIndex={indexOffset + index} key={`${result.url}-${index}`} selected={selected}>
            <div className="relative aspect-video overflow-hidden rounded-xl border border-line bg-gradient-to-br from-surface-2 to-surface">
              <span className="absolute left-3 top-3 flex items-center gap-1.5 text-ink-3">
                <TileIcon result={result} />
                {extension ? (
                  <span className="text-[11px] font-medium uppercase tracking-widest">{extension}</span>
                ) : null}
              </span>
              {size ? <TileBadge>{size}</TileBadge> : null}
              {result.favicon ? <TileFavicon src={result.favicon} /> : null}
              {primaryHref ? (
                <TileCenterAction
                  download={!result.magnetlink}
                  href={primaryHref}
                  icon={result.magnetlink ? <Magnet className="size-5" /> : <Download className="size-5" />}
                  label={primaryLabel}
                />
              ) : null}
            </div>
            <TileTitle globals={globals} result={result} />
            <TileMeta
              left={
                health ? (
                  <span className="inline-flex items-center gap-2">
                    {result.seed !== undefined ? (
                      <span className="inline-flex items-center gap-0.5 font-medium text-ok">
                        <ArrowUp className="size-3" />
                        {result.seed}
                      </span>
                    ) : null}
                    {result.leech !== undefined ? (
                      <span className="inline-flex items-center gap-0.5 font-medium text-danger">
                        <ArrowDown className="size-3" />
                        {result.leech}
                      </span>
                    ) : null}
                  </span>
                ) : null
              }
              right={<TileMetaDate date={date} />}
            />
            <div className="mt-auto pt-1.5">
              <TileEngines result={result} />
            </div>
          </TileCell>
        );
      })}
    </div>
  );
}
