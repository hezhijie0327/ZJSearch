// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronDown, ExternalLink } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "@/lib/i18n.ts";
import { newTabLinkProps } from "@/lib/link.ts";
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
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  // natural content height, kept current by a ResizeObserver: max-height
  // cannot transition to `none`, so the expanded state must pin a real
  // pixel value for the browser to animate to
  const [contentPx, setContentPx] = useState<number | null>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => {
      // +1 guards against sub-pixel rounding clipping the last text line
      setContentPx(Math.ceil(el.getBoundingClientRect().height) + 1);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  // content that fits the preview needs no clamp, gradient or toggle
  const needsClamp = contentPx === null || contentPx > INFOBOX_PREVIEW_PX + 24;

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
        <h2 className="min-w-0 text-xl font-semibold leading-tight tracking-tight text-ink" dir="auto">
          {infobox.title}
        </h2>
      </div>

      {/* animated disclosure: overflow-hidden stays on in both states (without
          it the inner mt-3 collapses through the wrapper when expanded and
          the visible content jumps up 12px on toggle); flow-root keeps the
          inner's first-child margin inside the measured box */}
      <div
        className="relative mt-3 overflow-hidden transition-[max-height] duration-300 ease-out"
        id={contentId}
        style={{
          maxHeight: needsClamp ? (expanded ? (contentPx ?? INFOBOX_PREVIEW_PX) : INFOBOX_PREVIEW_PX) : undefined,
        }}
      >
        <div className="relative flow-root" ref={contentRef}>
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
                        className="rounded-full bg-surface-2 px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-accent-soft hover:text-accent"
                        key={suggestion}
                        onClick={() => {
                          onSearch(suggestion);
                        }}
                        type="button"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {needsClamp ? (
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent transition-opacity duration-300 ${
              expanded ? "opacity-0" : "opacity-100"
            }`}
          />
        ) : null}
      </div>
      {needsClamp ? (
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          className="mt-2 flex w-full items-center justify-center gap-1 border-t border-line pt-2.5 text-[13px] text-ink-3 transition-colors hover:text-ink"
          onClick={() => {
            setExpanded((value) => !value);
          }}
          type="button"
        >
          {expanded ? t("collapse") : t("expand")}
          <ChevronDown className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      ) : null}
    </div>
  );
}
