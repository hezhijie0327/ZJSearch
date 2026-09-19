// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Calendar, ChevronLeft, Code, ExternalLink, Scale, Star, User } from "lucide-react";
import type { ReactNode } from "react";
import { type CardProps, EnginesLine, PrettyUrl, ResultArticle, Title } from "@/features/results/cardParts.tsx";
import { formatDate } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { CHIP, CHIP_HOVER, META_ROW } from "@/lib/styles.ts";
import { useCapExpand } from "@/lib/useCapExpand.ts";

export function PackageCard({ result, globals }: CardProps) {
  const t = useT();
  const { expanded: tagsExpanded, toggle: toggleTags, hidden: hiddenTags } = useCapExpand(result.tags?.length ?? 0, 4);
  // same slot rhythm as DefaultCard: url / title / meta / content / engines;
  // secondary links fold into the engines row so no card grows extra rows
  const links: Array<{ icon: ReactNode; label: string; url: string }> = [];
  if (result.homepage) {
    links.push({ icon: <ExternalLink className="size-3" />, label: t("homepage"), url: result.homepage });
  }
  if (result.source_code_url && result.source_code_url !== result.url) {
    links.push({ icon: <Code className="size-3" />, label: t("repository"), url: result.source_code_url });
  }
  for (const [name, url] of Object.entries(result.project_links ?? {})) {
    if (url !== result.url) {
      links.push({ icon: <ExternalLink className="size-3" />, label: name, url });
    }
  }
  return (
    <ResultArticle priority={result.priority}>
      <PrettyUrl globals={globals} result={result} />
      <div className="mt-1">
        <Title globals={globals} result={result} />
      </div>
      {result.published_date || result.maintainer || result.popularity || result.license_name || result.version ? (
        <div className={`${META_ROW} mt-1 gap-x-3 text-xs text-ink-3`}>
          {result.published_date ? (
            <span className="inline-flex items-center gap-1" key="date">
              <Calendar className="size-3" />
              {formatDate(result.published_date)}
            </span>
          ) : null}
          {result.maintainer ? (
            <span className="inline-flex items-center gap-1" key="author">
              <User className="size-3 shrink-0" />
              {t("author")}:
              <span className="text-ink-2" dir="auto">
                {result.maintainer}
              </span>
            </span>
          ) : null}
          {result.popularity ? (
            <span className="inline-flex items-center gap-1" key="popularity">
              <Star className="size-3" />
              <span className="text-ink-2">{result.popularity}</span>
            </span>
          ) : null}
          {result.license_name ? (
            <span className="inline-flex items-center gap-1" key="license">
              <Scale className="size-3 shrink-0" />
              {t("license")}:
              <span className="text-ink-2">
                {result.license_url ? (
                  <a
                    className="hover:text-accent hover:underline"
                    href={result.license_url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {result.license_name}
                  </a>
                ) : (
                  result.license_name
                )}
              </span>
            </span>
          ) : null}
          {result.version ? <span key="version">v{result.version}</span> : null}
        </div>
      ) : null}
      {result.content_html ? (
        <p
          className="mt-1.5 line-clamp-2 max-w-prose text-sm leading-relaxed text-ink-2"
          dangerouslySetInnerHTML={{ __html: result.content_html }}
          dir="auto"
        />
      ) : null}
      {result.tags && result.tags.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
          {result.tags.slice(0, tagsExpanded ? result.tags.length : 4).map((tag) => (
            <span className={CHIP} key={tag} title={tag}>
              #{tag}
            </span>
          ))}
          {hiddenTags > 0 ? (
            <button
              aria-expanded={tagsExpanded}
              className={`${CHIP} ${CHIP_HOVER}`}
              onClick={toggleTags}
              title={result.tags.join(", ")}
              type="button"
            >
              {tagsExpanded ? (
                <>
                  <ChevronLeft className="size-3 shrink-0" />
                  {t("show_less")}
                </>
              ) : (
                `+${hiddenTags}`
              )}
            </button>
          ) : null}
        </div>
      ) : null}
      <EnginesLine
        leading={
          links.length > 0
            ? links.map((link) => (
                <a
                  className={`${CHIP} ${CHIP_HOVER} text-ink-2`}
                  href={link.url}
                  key={link.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {link.icon}
                  {link.label}
                </a>
              ))
            : null
        }
        result={result}
      />
    </ResultArticle>
  );
}
