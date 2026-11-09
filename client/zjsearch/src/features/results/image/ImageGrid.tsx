// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
import { imageAlt } from "@/lib/format.ts";

/** Image results: borderless masonry grid; the lightbox opens through a portal. */

import { ImageOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Lightbox } from "@/features/results/image/Lightbox.tsx";
import { useT } from "@/lib/i18n.ts";
import type { ResultItem } from "@/lib/types.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";
import { useGraceThumb } from "@/lib/useGraceThumb.ts";

function ImageTile({
  results,
  index,
  thumbSrc,
  onOpen,
  onFailed,
}: {
  results: ResultItem[];
  index: number;
  thumbSrc: string;
  onOpen: (index: number) => void;
  onFailed?: () => void;
}) {
  const result = results[index];
  // missing or unloadable thumbnails collapse to a quiet placeholder tile
  // (a hung request gets the same treatment after a grace period)
  const { failed, loaded, setFailed, setLoaded } = useGraceThumb(thumbSrc || undefined);
  const reported = useRef(false);
  useEffect(() => {
    // one report per tile: the grid aggregates the count for its notice
    if (failed && !reported.current) {
      reported.current = true;
      onFailed?.();
    }
  }, [failed, onFailed]);
  if (!result) {
    return null;
  }
  if (failed) {
    return (
      <button
        aria-label={imageAlt(result)}
        className="flex h-44 w-full items-center justify-center rounded-xl bg-surface-2 text-ink-3"
        data-ai-url={result.url}
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
      data-ai-url={result.url}
      onClick={() => {
        onOpen(index);
      }}
      type="button"
    >
      <img
        alt={imageAlt(result)}
        className={`w-full object-cover transition-all duration-300 ${loaded ? "opacity-100" : "h-44 opacity-0"}`}
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
      <span className="pointer-events-none absolute inset-x-2 bottom-2 line-clamp-2 text-xs font-medium leading-4 text-white opacity-0 transition-opacity group-hover:opacity-100">
        {result.title_text}
      </span>
    </button>
  );
}

/** Borderless masonry grid: pure images, info only on hover. */
export function ImageGrid({ results }: { results: ResultItem[] }) {
  const t = useT();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // the viewer keeps fading after the index clears; the last index feeds the
  // exit render so the image does not vanish mid-fade
  const { render: renderViewer, closing: viewerClosing } = useExitPresence(openIndex !== null, 200);
  const lastIndex = useRef(0);
  if (openIndex !== null) {
    lastIndex.current = openIndex;
  }
  const viewIndex = openIndex ?? lastIndex.current;
  // THE FAILED-THUMB AGGREGATE: source hotlink blocks and dead CDNs take a
  // whole masonry of quiet placeholder tiles — past a handful, one muted
  // line above the grid names the cause instead of leaving a field of
  // broken tiles unexplained
  const failedKeys = useRef(new Set<string>());
  const [failedCount, setFailedCount] = useState(0);
  const reportFailed = useCallback((key: string) => {
    const seen = failedKeys.current;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    setFailedCount(seen.size);
  }, []);

  return (
    <>
      {failedCount >= 3 ? (
        <p className="mb-2 text-xs text-ink-3">{t("images_thumbs_failed", { n: failedCount })}</p>
      ) : null}
      <div className="columns-2 gap-2 @[27rem]:columns-3 @[40rem]:columns-4 @[48rem]:columns-5 @5xl:columns-6 [&>*]:mb-2">
        {results.map((result, index) => {
          const thumbSrc = result.thumbnail_src || result.img_src || "";
          return (
            <ImageTile
              index={index}
              key={`${result.url}-${index}`}
              onFailed={() => reportFailed(`${result.url}-${index}`)}
              onOpen={setOpenIndex}
              results={results}
              thumbSrc={thumbSrc}
            />
          );
        })}
        {renderViewer
          ? createPortal(
              <Lightbox
                closing={viewerClosing}
                index={viewIndex}
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
    </>
  );
}
