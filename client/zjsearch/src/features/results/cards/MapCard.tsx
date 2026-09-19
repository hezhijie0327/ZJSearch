// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ExternalLink, MapPin } from "lucide-react";
import {
  type CardProps,
  EnginesLine,
  MetaLine,
  PrettyUrl,
  ResultArticle,
  Title,
} from "@/features/results/cardParts.tsx";
import { MapResult } from "@/features/results/MapView.tsx";
import { useT } from "@/lib/i18n.ts";
import { CHIP, CHIP_HOVER, META_ROW } from "@/lib/styles.ts";

export function MapCard({ result, globals, autoOpenMap }: CardProps) {
  const t = useT();
  const address = result.address;
  const addressLine = address
    ? [address.name, address.road, address.house_number, address.postcode, address.locality, address.country]
        .filter(Boolean)
        .join(", ")
    : "";
  return (
    <ResultArticle priority={result.priority}>
      <PrettyUrl globals={globals} result={result} />
      <div className="mt-1">
        <Title globals={globals} result={result} />
      </div>
      <div className="mt-1">
        <MetaLine result={result} />
      </div>
      {result.content_html ? (
        <p
          className="mt-1.5 line-clamp-2 max-w-prose text-sm leading-relaxed text-ink-2"
          dangerouslySetInnerHTML={{ __html: result.content_html }}
          dir="auto"
        />
      ) : null}
      {addressLine ? (
        <p className="mt-2 flex items-start gap-1 text-sm text-ink-2">
          <MapPin className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
          <span dir="auto">{addressLine}</span>
        </p>
      ) : null}
      {result.data && result.data.length > 0 ? (
        <dl className={`${META_ROW} mt-1 gap-x-4 text-xs text-ink-3`}>
          {result.data.map((item) => (
            <div className="flex gap-1" key={item.label}>
              <dt>{item.label}:</dt>
              <dd className="text-ink-2">{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <MapResult
        autoOpen={autoOpenMap}
        boundingbox={result.boundingbox}
        geojson={result.geojson}
        label={t("show_map")}
        latitude={result.latitude}
        longitude={result.longitude}
      />
      {result.map_links && result.map_links.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {result.map_links.map((link) => (
            <a
              className={`${CHIP} ${CHIP_HOVER} text-ink-2`}
              href={link.url}
              key={link.url}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink className="size-3" />
              {link.label}
            </a>
          ))}
        </div>
      ) : null}
      <EnginesLine result={result} />
    </ResultArticle>
  );
}
