// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
import { imageAlt } from "@/lib/format.ts";

/** Image results: borderless masonry grid; the lightbox opens through a portal. */

import { ImageOff } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { Lightbox } from "@/features/results/image/Lightbox.tsx";
import { useGraceThumb } from "@/features/results/Tile.tsx";
import type { ResultItem } from "@/lib/types.ts";

function ImageTile({
  results,
  index,
  thumbSrc,
  onOpen,
}: {
  results: ResultItem[];
  index: number;
  thumbSrc: string;
  onOpen: (index: number) => void;
}) {
  const result = results[index];
  // missing or unloadable thumbnails collapse to a quiet placeholder tile
  // (a hung request gets the same treatment after a grace period)
  const { failed, loaded, setFailed, setLoaded } = useGraceThumb(thumbSrc || undefined);
  if (!result) {
    return null;
  }
  if (failed) {
    return (
      <button
        aria-label={imageAlt(result)}
        className="flex h-44 w-full items-center justify-center rounded-xl bg-surface-2 text-ink-3"
        onClick={() => {
          onOpen(index);
        }}
        type="button"
      >
        <ImageOff className="size-8" />
      </button>
    );
  }
  return (
    <button
      aria-label={imageAlt(result)}
      className={`group relative block w-full break-inside-avoid overflow-hidden rounded-xl bg-surface-2 transition-opacity ${
        loaded ? "opacity-100" : "min-h-44 opacity-70 animate-pulse-soft"
      }`}
      onClick={() => {
        onOpen(index);
      }}
      type="button"
    >
      <img
        alt={imageAlt(result)}
        className={`w-full object-cover transition-all duration-300 group-hover:scale-[1.02] ${
          loaded ? "opacity-100" : "h-44 opacity-0"
        }`}
        decoding="async"
        fetchPriority={index < 4 ? "high" : undefined}
        loading={index < 4 ? "eager" : "lazy"}
        onError={() => {
          setFailed(true);
          setLoaded(true);
        }}
        onLoad={() => {
          setLoaded(true);
        }}
        src={thumbSrc}
      />
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      <span className="pointer-events-none absolute inset-x-2 bottom-2 line-clamp-2 text-[11px] font-medium leading-4 text-white opacity-0 transition-opacity group-hover:opacity-100">
        {result.title_text}
      </span>
    </button>
  );
}

/** Borderless masonry grid: pure images, info only on hover. */
export function ImageGrid({ results }: { results: ResultItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    // masonry density keys off the column width (container queries), like
    // every other grid: 3 base steps + a 5th/6th column on wide containers
    <div className="columns-2 gap-2 @[27rem]:columns-3 @[40rem]:columns-4 @[48rem]:columns-5 @5xl:columns-6 [&>*]:mb-2">
      {results.map((result, index) => {
        const thumbSrc = result.thumbnail_src || result.img_src || "";
        return (
          <ImageTile
            index={index}
            key={`${result.url}-${index}`}
            onOpen={setOpenIndex}
            results={results}
            thumbSrc={thumbSrc}
          />
        );
      })}
      {openIndex !== null
        ? createPortal(
            <Lightbox
              index={openIndex}
              onClose={() => {
                setOpenIndex(null);
              }}
              onNavigate={(index) => {
                setOpenIndex(index);
              }}
              results={results}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
