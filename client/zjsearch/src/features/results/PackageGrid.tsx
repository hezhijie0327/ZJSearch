// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Package results (crates.io, docker hub, pypi, ...): the file-tile
    language of FilesGrid applied to software packages - icon tile with the
    version badge, author/updated meta row, homepage/source actions. */

import { Code, ExternalLink, Package as PackageIcon } from "lucide-react";
import { ResultLink } from "@/features/results/cardParts.tsx";
import {
  TileCell,
  TileEngines,
  TileFavicon,
  TileMeta,
  TileMetaAuthor,
  TileMetaDate,
  TileTitle,
} from "@/features/results/Tile.tsx";
import { formatDate } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import type { GlobalData, ResultItem } from "@/lib/types.ts";

export function PackageGrid({
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
  const cells = results.map((result, index) => (
    <TileCell hotkeyIndex={indexOffset + index} key={`${result.url}-${index}`} selected={selected}>
      <ResultLink
        className="relative block aspect-square overflow-hidden rounded-xl border border-line bg-gradient-to-br from-surface-2 to-surface"
        globals={globals}
        result={result}
      >
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-3">
          <PackageIcon className="size-10" />
          {result.version ? (
            <span className="font-mono text-[11px] font-medium tracking-wide">{result.version}</span>
          ) : null}
        </span>
        {result.favicon ? <TileFavicon src={result.favicon} /> : null}
      </ResultLink>
      <TileTitle globals={globals} result={result} />
      <TileMeta
        left={<TileMetaAuthor author={result.maintainer || result.author} />}
        right={<TileMetaDate date={result.published_date ? formatDate(result.published_date) : null} />}
      />
      <div className="mt-auto pt-1.5">
        <TileEngines result={result} />
        {result.homepage || result.source_code_url ? (
          <div className="mt-1.5 flex items-center gap-1.5">
            {result.homepage ? (
              <a
                aria-label={t("homepage")}
                className="grid size-7 place-items-center rounded-full bg-accent-soft text-accent transition-colors hover:bg-accent-strong hover:text-accent-contrast"
                href={result.homepage}
                rel="noreferrer"
                target="_blank"
                title={t("homepage")}
              >
                <ExternalLink className="size-3.5" />
              </a>
            ) : null}
            {result.source_code_url ? (
              <a
                aria-label={t("repository")}
                className="grid size-7 place-items-center rounded-full bg-surface-2 text-ink-2 transition-colors hover:text-ink"
                href={result.source_code_url}
                rel="noreferrer"
                target="_blank"
                title={t("repository")}
              >
                <Code className="size-3.5" />
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </TileCell>
  ));
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 @sm:grid-cols-3 @[46rem]:grid-cols-4 @5xl:grid-cols-5">
      {cells}
    </div>
  );
}
