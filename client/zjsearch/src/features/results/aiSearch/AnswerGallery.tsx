// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { type ReactNode, useState } from "react";
import { type AiSearchGallery, splitGallerySegments } from "@/features/results/aiAnswer.ts";

/**
 * One inline image group of the AI answer (the server-validated
 * ``zjs-images`` fence, rendered where the answer text carries its
 * ``{{zjs-gallery:i}}`` placeholder).  A MODEST inline strip — small
 * fixed-height thumbs in a wrapping row, not a hero block: the sources
 * rail already owns the page's visual weight, and a full-measure image
 * insert in flowing prose reads oversized (Vane keeps media thumbnails
 * small for the same reason).  The corner badge carries the source's
 * [n] and the tile click reuses the citation jump (scroll to the source
 * card + tint).  Images fade in on load (the house lazy-content rule).
 */

function GalleryTile({ item, onCite }: { item: AiSearchGallery; onCite?: (index: number) => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <button
      aria-label={item.title || `[${item.n}]`}
      className="group relative h-24 w-40 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2"
      onClick={() => {
        onCite?.(item.n);
      }}
      title={item.title || undefined}
      type="button"
    >
      <img
        alt={item.title || ""}
        className={`size-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        decoding="async"
        loading="lazy"
        onLoad={() => {
          setLoaded(true);
        }}
        referrerPolicy="no-referrer"
        src={item.url}
      />
      <span className="absolute bottom-1.5 end-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] font-medium leading-none text-white">
        [{item.n}]
      </span>
    </button>
  );
}

export function AnswerGallery({ gallery, onCite }: { gallery: AiSearchGallery[]; onCite?: (index: number) => void }) {
  if (!gallery.length) {
    return null;
  }
  return (
    <div className="my-3 flex flex-wrap gap-2">
      {gallery.map((item) => (
        <GalleryTile item={item} key={`${item.n}-${item.url}`} onCite={onCite} />
      ))}
    </div>
  );
}

/** Render an answer that may carry gallery placeholders: markdown segments
    and gallery groups interleaved, in the placeholder order.  With no
    galleries (the AI Overview, runs whose writer skipped images) this is
    the identity -- the markdown renders in one piece. */
export function renderWithGalleries(
  markdown: string,
  galleries: AiSearchGallery[][] | undefined,
  render: (text: string, key: string) => ReactNode,
  galleryNode: (index: number, key: string) => ReactNode,
): ReactNode {
  const segments = galleries?.length ? splitGallerySegments(markdown) : [{ kind: "md" as const, text: markdown }];
  if (segments.length === 1 && segments[0]?.kind === "md") {
    return render(segments[0].text, "md");
  }
  return segments.map((segment, i) =>
    segment.kind === "md" ? render(segment.text, `md-${i}`) : galleryNode(segment.index, `gallery-${i}`),
  );
}
