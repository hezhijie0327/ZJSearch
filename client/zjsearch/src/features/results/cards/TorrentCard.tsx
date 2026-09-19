// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ArrowDown, ArrowUp, Calendar, Download, FileText, Magnet, Package } from "lucide-react";
import { type CardProps, EnginesLine, PrettyUrl, ResultArticle, Title } from "@/features/results/cardParts.tsx";
import { formatDate } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { CHIP, META_ROW } from "@/lib/styles.ts";

/** File-share layout: the magnet link doubles as the card's primary action
    tile, health stats read as a colored seeder/leecher strip - the
    "transfer" reading of the files category. */

export function TorrentCard({ result, globals }: CardProps) {
  const t = useT();
  return (
    <ResultArticle priority={result.priority}>
      <div className="flex gap-4">
        {result.magnetlink ? (
          <a
            aria-label={t("magnet_link")}
            className="grid size-14 shrink-0 self-start place-items-center rounded-xl bg-accent-soft text-accent transition-colors hover:bg-accent-strong hover:text-accent-contrast"
            href={result.magnetlink}
            title={t("magnet_link")}
          >
            <Magnet className="size-6" />
          </a>
        ) : (
          <span className="grid size-14 shrink-0 self-start place-items-center rounded-xl bg-surface-2 text-ink-3">
            <FileText className="size-6" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <PrettyUrl globals={globals} result={result} />
          <div className="mt-1">
            <Title globals={globals} result={result} />
          </div>
          <div className={`${META_ROW} mt-1 gap-x-4 text-xs text-ink-3`}>
            {result.seed !== undefined ? (
              <span className="inline-flex items-center gap-1">
                <ArrowUp className="size-3 text-ok" />
                <span className="font-semibold text-ok">{result.seed}</span>
                {t("seeder")}
              </span>
            ) : null}
            {result.leech !== undefined ? (
              <span className="inline-flex items-center gap-1">
                <ArrowDown className="size-3 text-danger" />
                <span className="font-semibold text-danger">{result.leech}</span>
                {t("leecher")}
              </span>
            ) : null}
            {result.filesize ? (
              <span className="inline-flex items-center gap-1">
                <FileText className="size-3" />
                {result.filesize}
              </span>
            ) : null}
            {result.files ? (
              <span className="inline-flex items-center gap-1">
                <Package className="size-3" />
                {result.files} {t("files")}
              </span>
            ) : null}
            {result.published_date ? (
              <span className="inline-flex items-center gap-1">
                <Calendar className="size-3" />
                {formatDate(result.published_date)}
              </span>
            ) : null}
          </div>
          {result.content_html ? (
            <p
              className="mt-1.5 line-clamp-2 max-w-prose text-sm leading-relaxed text-ink-2"
              dangerouslySetInnerHTML={{ __html: result.content_html }}
              dir="auto"
            />
          ) : null}
          {result.torrentfile ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <a className={`${CHIP} text-ink-2 transition-colors hover:text-ink`} href={result.torrentfile}>
                <Download className="size-3" />
                {t("torrent_file")}
              </a>
            </div>
          ) : null}
          <EnginesLine result={result} />
        </div>
      </div>
    </ResultArticle>
  );
}
