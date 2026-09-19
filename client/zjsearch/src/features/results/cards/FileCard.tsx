// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Download, FileText, Film, Music } from "lucide-react";
import {
  type CardProps,
  EnginesLine,
  MediaCollapse,
  PrettyUrl,
  ResultArticle,
  Title,
} from "@/features/results/cardParts.tsx";
import { useT } from "@/lib/i18n.ts";
import { META_ROW } from "@/lib/styles.ts";

/** General file-download layout, sharing the transfer-card language of the
    torrent card: type icon tile, compact stat strip, primary action. */

export function FileCard({ result, globals }: CardProps) {
  const t = useT();
  const isMedia = result.mtype === "audio" || result.mtype === "video";
  const tileClass = isMedia ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink-3";
  const tileIcon =
    result.mtype === "audio" ? (
      <Music className="size-6" />
    ) : result.mtype === "video" ? (
      <Film className="size-6" />
    ) : (
      <FileText className="size-6" />
    );
  const stats: Array<[string, string | undefined]> = [
    [t("author"), result.author],
    [t("filename"), result.filename],
    [t("filesize"), result.size],
    [t("date"), result.time],
    [t("type"), result.mimetype],
  ];
  return (
    <ResultArticle priority={result.priority}>
      <div className="flex gap-4">
        <span className={`grid size-14 shrink-0 self-start place-items-center rounded-xl ${tileClass}`}>
          {tileIcon}
        </span>
        <div className="min-w-0 flex-1">
          <PrettyUrl globals={globals} result={result} />
          <div className="mt-1">
            <Title globals={globals} result={result} />
          </div>
          <div className={`${META_ROW} mt-1 gap-x-4 text-xs text-ink-3`}>
            {stats
              .filter(([, value]) => Boolean(value))
              .map(([label, value]) => (
                <span className="inline-flex items-center gap-1" key={label}>
                  {label}:
                  <span className="text-ink-2" dir="auto">
                    {value}
                  </span>
                </span>
              ))}
          </div>
          {result.abstract_html ? (
            <p
              className="mt-1.5 line-clamp-2 max-w-prose text-sm leading-relaxed text-ink-2"
              dangerouslySetInnerHTML={{ __html: result.abstract_html }}
              dir="auto"
            />
          ) : null}
          {result.content_html ? (
            <p
              className="mt-1.5 line-clamp-2 max-w-prose text-sm leading-relaxed text-ink-2"
              dangerouslySetInnerHTML={{ __html: result.content_html }}
              dir="auto"
            />
          ) : null}
          {result.embedded ? (
            isMedia ? (
              result.mtype === "video" ? (
                <MediaCollapse hideLabel={t("hide_media")} showLabel={t("show_media")}>
                  {() => (
                    <video
                      className="w-full max-w-lg rounded-xl"
                      controls
                      poster={result.thumbnail}
                      preload="metadata"
                      src={result.embedded}
                    />
                  )}
                </MediaCollapse>
              ) : (
                // audio: inline player, no collapse - music results should be
                // playable in one click (preload="none" keeps it cheap)
                <div className="mt-2 flex max-w-md items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
                  <Music className="size-4 shrink-0 text-accent" />
                  <audio className="h-8 w-full" controls preload="none" src={result.embedded} />
                </div>
              )
            ) : (
              <a
                className="mt-2 inline-flex items-center gap-1 rounded-full bg-accent-soft px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent-strong hover:text-accent-contrast"
                download
                href={result.embedded}
                rel="noreferrer"
                target="_blank"
              >
                <Download className="size-3.5" />
                {t("download")}
              </a>
            )
          ) : null}
          <EnginesLine result={result} />
        </div>
      </div>
    </ResultArticle>
  );
}
