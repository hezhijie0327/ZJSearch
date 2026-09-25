// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ExternalLink, Search } from "lucide-react";
import { ClampReveal } from "@/components/ClampReveal.tsx";
import { newTabLinkProps } from "@/lib/link.ts";
import { PILL } from "@/lib/styles.ts";
import type { GlobalData, InfoboxData } from "@/lib/types.ts";

/** Collapsed infobox preview height (the old max-h-72 clamp). */
const INFOBOX_PREVIEW_PX = 288;

export function Infobox({
  infobox,
  globals,
  onSearch,
}: {
  infobox: InfoboxData;
  globals: GlobalData;
  onSearch: (q: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <div className={infobox.img_src ? "flex items-start gap-4" : ""}>
        {infobox.img_src ? (
          <img
            alt={infobox.title}
            className="aspect-square w-32 shrink-0 rounded-xl border border-line bg-surface-2 object-contain p-1 sm:w-36 2xl:w-40"
            decoding="async"
            loading="lazy"
            src={infobox.img_src}
          />
        ) : null}
        <h2 className="min-w-0 font-serif text-xl font-semibold leading-tight tracking-tight text-ink" dir="auto">
          {infobox.title}
        </h2>
      </div>

      <ClampReveal
        buttonClassName="mt-2 flex w-full items-center justify-center gap-1 border-t border-line pt-2.5 text-[13px] text-ink-3 transition-colors hover:text-ink"
        className="mt-3"
        previewPx={INFOBOX_PREVIEW_PX}
      >
        {infobox.attributes && infobox.attributes.length > 0 ? (
          <dl className="space-y-2.5 text-xs">
            {infobox.attributes.map((attribute, index) =>
              attribute.image_src ? (
                // image attributes read as captioned figures - a table row
                // with an inline image squeezes charts and misaligns labels
                <div key={index}>
                  <dt className="text-ink-3">{attribute.label}</dt>
                  <dd className="mt-1.5">
                    <img
                      alt={attribute.image_alt || attribute.label}
                      className="mx-auto max-h-56 max-w-full rounded-xl border border-line bg-surface-2 object-contain"
                      decoding="async"
                      loading="lazy"
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                      src={attribute.image_src}
                    />
                    {attribute.value ? (
                      <span className="mt-1 block leading-relaxed text-ink-2" dir="auto">
                        {attribute.value}
                      </span>
                    ) : null}
                  </dd>
                </div>
              ) : (
                <div className="flex gap-2" key={index}>
                  {/* dt capped: a long label must not squeeze the value out */}
                  <dt className="max-w-[40%] shrink-0 truncate text-ink-3" title={attribute.label}>
                    {attribute.label}:
                  </dt>
                  <dd className="min-w-0 text-ink-2">
                    <span dir="auto">{attribute.value}</span>
                  </dd>
                </div>
              ),
            )}
          </dl>
        ) : null}

        {infobox.content_html ? (
          <div
            className="mt-3 text-sm leading-relaxed text-ink-2 [&_a]:text-accent [&_a]:underline [&_a]:decoration-accent/40 [&_a]:underline-offset-2"
            dangerouslySetInnerHTML={{ __html: infobox.content_html }}
            dir="auto"
          />
        ) : null}

        {infobox.urls && infobox.urls.length > 0 ? (
          <ul className="mt-3 space-y-1 text-xs">
            {infobox.urls.map((url) => (
              <li className="min-w-0" key={url.url}>
                <a
                  className="flex min-h-6 min-w-0 max-w-full items-center gap-1 text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                  {...newTabLinkProps(globals.results_on_new_tab)}
                  href={url.url}
                >
                  <span className="min-w-0 truncate">{url.title}</span>
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              </li>
            ))}
          </ul>
        ) : null}

        {infobox.related_topics && infobox.related_topics.length > 0 ? (
          <div className="mt-4 space-y-2">
            {infobox.related_topics.map((topic) => (
              <div key={topic.name}>
                <h4 className="text-xs font-semibold text-ink" dir="auto">
                  {topic.name}
                </h4>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {topic.suggestions.map((suggestion) => (
                    <button
                      className={`${PILL} hover:bg-accent-soft hover:text-accent`}
                      key={suggestion}
                      onClick={() => {
                        onSearch(suggestion);
                      }}
                      type="button"
                    >
                      <Search className="size-3.5 shrink-0 text-ink-3" />
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </ClampReveal>
    </div>
  );
}
