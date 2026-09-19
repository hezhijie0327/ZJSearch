// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  type CardProps,
  EmbedFrame,
  EnginesLine,
  MediaCollapse,
  MediaPreview,
  MetaLine,
  PrettyUrl,
  ResultArticle,
  ResultLink,
  Thumb,
  Title,
} from "@/features/results/cardParts.tsx";
import { formatLength, imageAlt } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";

/** News results share the DefaultCard anatomy (thumbnail on the right, same
    slot rhythm) so with-image and without-image news stay structurally
    identical to every other result. */

export function DefaultCard({ eager, result, globals, mediaOpen }: CardProps) {
  const t = useT();
  return (
    <ResultArticle priority={result.priority}>
      <div className="flex gap-4">
        <div className="min-w-0 w-full max-w-2xl">
          <PrettyUrl globals={globals} result={result} />
          <div className="mt-1">
            <Title globals={globals} result={result} />
          </div>
          <div className="mt-1">
            <MetaLine result={result} />
          </div>
          {result.iframe_src ? (
            <div className="mt-2">
              {mediaOpen ? (
                <MediaPreview src={result.iframe_src} />
              ) : (
                <MediaCollapse hideLabel={t("hide_media")} showLabel={t("show_media")}>
                  {() => <EmbedFrame src={result.iframe_src ?? ""} />}
                </MediaCollapse>
              )}
            </div>
          ) : null}
          <p
            className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-ink-2"
            dangerouslySetInnerHTML={{
              __html: result.content_html || t("no_description"),
            }}
            dir="auto"
          />
          {result.audio_src ? (
            <audio className="mt-2 w-full max-w-md" controls preload="none" src={result.audio_src} />
          ) : null}
        </div>
        {result.thumbnail ? (
          <ResultLink className="ms-auto shrink-0 self-start" globals={globals} result={result}>
            <Thumb
              alt={imageAlt(result)}
              className="h-24 w-28 sm:w-40"
              eager={eager}
              lengthDisplay={formatLength(result.length_display, result.length_seconds)}
              src={result.thumbnail}
            />
          </ResultLink>
        ) : null}
      </div>
      <EnginesLine result={result} />
    </ResultArticle>
  );
}
