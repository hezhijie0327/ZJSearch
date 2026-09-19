// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Globe, Tag, Truck } from "lucide-react";
import {
  type CardProps,
  EnginesLine,
  MetaLine,
  PrettyUrl,
  ResultArticle,
  ResultLink,
  Thumb,
  Title,
} from "@/features/results/cardParts.tsx";
import { imageAlt } from "@/lib/format.ts";
import { META_ROW } from "@/lib/styles.ts";

export function ProductCard({ result, globals }: CardProps) {
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
          <div className={`${META_ROW} mt-1 gap-x-3`}>
            {result.price ? (
              <span className="inline-flex items-center gap-1 text-lg font-semibold text-ink">
                <Tag className="size-4 shrink-0 text-ink-3" />
                {result.price}
              </span>
            ) : null}
            {result.shipping ? (
              <span className="inline-flex items-center gap-1 text-xs text-ink-3">
                <Truck className="size-3 shrink-0" />
                {result.shipping}
              </span>
            ) : null}
            {result.source_country ? (
              <span className="inline-flex items-center gap-1 text-xs text-ink-3">
                <Globe className="size-3 shrink-0" />
                {result.source_country}
              </span>
            ) : null}
          </div>
          {result.content_html ? (
            <p
              className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-ink-2"
              dangerouslySetInnerHTML={{ __html: result.content_html }}
              dir="auto"
            />
          ) : null}
        </div>
        {result.thumbnail ? (
          <ResultLink className="ms-auto shrink-0 self-start" globals={globals} result={result}>
            <Thumb alt={imageAlt(result)} className="h-28 w-28" src={result.thumbnail} />
          </ResultLink>
        ) : null}
      </div>
      <EnginesLine result={result} />
    </ResultArticle>
  );
}
