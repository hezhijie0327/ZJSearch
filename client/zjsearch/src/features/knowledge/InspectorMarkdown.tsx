// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useMemo } from "react";
import { MarkdownAnswer } from "@/features/results/AIOverview.tsx";
import type { AiSourceMeta } from "@/features/results/aiOverview.ts";
import { type CitationMap, citedOrder, citedSourceRows, citeToLinks } from "@/lib/citations.ts";

/**
 * The knowledge inspector's markdown renderer (overview answers, archived
 * reader full texts, pre-report glued answers): NOT a second renderer -- the
 * ONE shared answer pipeline (`MarkdownAnswer`, DESIGN.md §5.1) with the
 * inspector's own citation wiring.  [n] chips behave like the research
 * page's, except a click OPENS the source (the knowledge base's honest
 * action -- the rail scroll has no counterpart in the panel); without meta
 * the [n]s degrade to the same inert chips the thread shows for unknown
 * sources.  The root carries the §4 long-form scale (17px/1.8) so a stored
 * answer reads exactly like it did on the thread page.  With a citation
 * map the chips read the DOCUMENT-LOCAL numbers and the onCite callback
 * keeps its global contract (the translation is internal).
 */
export function InspectorMarkdown({
  text,
  meta = [],
  onCite,
  map,
}: {
  text: string;
  meta?: AiSourceMeta[];
  onCite?: (index: number) => void;
  /** the document-local citation map (built by the caller over the SAME
      text -- the sources card and the print tail share it) */
  map?: CitationMap;
}) {
  const citedMeta = useMemo(() => (map ? citedSourceRows(map, meta) : meta), [map, meta]);
  const order = map ? citedOrder(map) : null;
  return (
    <div className="zjs-answer-body text-[17px] font-serif leading-[1.8] text-ink">
      <MarkdownAnswer
        figureLightbox
        galleries={[]}
        markdown={citeToLinks(text, map)}
        meta={citedMeta}
        onCite={
          order
            ? (local) => {
                const globalN = order[local - 1];
                if (globalN != null) {
                  onCite?.(globalN);
                }
              }
            : onCite
        }
        settled
      />
    </div>
  );
}
