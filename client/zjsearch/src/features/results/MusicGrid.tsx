// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Music-intent layout: square album-art tiles mirroring the video grid.
    Playable results swap the tile for an in-place player - raw audio
    streams get a custom mini player (blur + play/pause + seek), embeddable
    sources play inside the tile like videos do. */

import { Music as MusicIcon, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ResultLink } from "@/features/results/cardParts.tsx";
import {
  TileBadge,
  TileCell,
  TileCenterAction,
  TileCloseAction,
  TileEngines,
  TileFavicon,
  TileMeta,
  TileMetaAuthor,
  TileMetaDate,
  TileThumb,
  TileTitle,
} from "@/features/results/Tile.tsx";
import { formatClock, formatDate, formatLength, imageAlt } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { DISABLED } from "@/lib/styles.ts";
import type { GlobalData, ResultItem } from "@/lib/types.ts";

/** In-tile mini player for raw audio streams.  Reports playback failure so
    the grid can fall back to the embeddable player when one exists. */
function AudioTilePlayer({ src, onClose, onError }: { src: string; onClose: () => void; onError: () => void }) {
  const t = useT();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const hasDuration = Number.isFinite(duration) && duration > 0;

  useEffect(() => {
    // the player mounts right after a click, so user activation allows this
    audioRef.current?.play().catch(() => {});
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  };

  return (
    <div className="absolute inset-0 z-10 flex animate-fade-in flex-col overflow-hidden rounded-xl border border-line bg-black/75 text-white backdrop-blur-md">
      <audio
        onError={onError}
        onLoadedMetadata={(event) => {
          setDuration(event.currentTarget.duration);
        }}
        onPause={() => {
          setPlaying(false);
        }}
        onPlay={() => {
          setPlaying(true);
        }}
        onTimeUpdate={(event) => {
          setTime(event.currentTarget.currentTime);
        }}
        preload="metadata"
        ref={audioRef}
        src={src}
      />
      <TileCloseAction label={t("close")} onClick={onClose} />
      <div className="flex flex-1 items-center justify-center">
        <button
          aria-label={playing ? t("pause") : t("play")}
          // always-white disc: the player backdrop is fixed-dark in every
          // palette, so a themed surface token would vanish in dark mode
          className="grid size-14 place-items-center rounded-full bg-white text-black shadow-pop transition-transform hover:scale-105"
          onClick={toggle}
          title={playing ? t("pause") : t("play")}
          type="button"
        >
          {playing ? <Pause className="size-6" /> : <Play className="size-6 translate-x-px" />}
        </button>
      </div>
      <div className="flex items-center gap-2 px-3 pb-3 text-[11px] font-medium tabular-nums">
        <span>{formatClock(time)}</span>
        <input
          aria-label={t("length")}
          className={`w-full accent-white ${DISABLED}`}
          disabled={!hasDuration}
          max={hasDuration ? duration : 1}
          min={0}
          onChange={(event) => {
            const audio = audioRef.current;
            const value = Number(event.target.value);
            if (audio && Number.isFinite(value)) {
              audio.currentTime = value;
              setTime(value);
            }
          }}
          step={0.1}
          type="range"
          value={hasDuration ? Math.min(time, duration) : 0}
        />
        <span>{formatClock(duration)}</span>
      </div>
    </div>
  );
}

function EmbedTile({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const t = useT();
  return (
    <div className="absolute inset-0 z-10 animate-fade-in overflow-hidden rounded-xl border border-line bg-black">
      <iframe allowFullScreen className="size-full" referrerPolicy="origin" src={src} title={title} />
      <TileCloseAction label={t("close")} onClick={onClose} />
    </div>
  );
}

export function MusicGrid({
  results,
  globals,
  selected,
  indexOffset = 0,
}: {
  results: ResultItem[];
  globals: GlobalData;
  selected?: number;
  /** hotkey indices are page-global: offset by the grid's first result index */
  indexOffset?: number;
}) {
  const t = useT();
  const [playing, setPlaying] = useState<number | null>(null);
  const [mode, setMode] = useState<"audio" | "embed">("audio");
  const cells = results.map((result, index) => {
    const length = formatLength(result.length_display, result.length_seconds);
    const isPlaying = playing === index;
    const audioSrc = result.audio_src || "";
    const embedSrc = result.iframe_src || "";
    const playable = Boolean(audioSrc || embedSrc);
    return (
      <TileCell hotkeyIndex={indexOffset + index} key={`${result.url}-${index}`} selected={selected}>
        <div className="relative">
          <ResultLink
            className="relative block aspect-square overflow-hidden rounded-xl bg-surface-2"
            globals={globals}
            result={result}
          >
            <TileThumb
              alt={imageAlt(result)}
              eager={indexOffset + index < 4}
              placeholder={
                <span className="grid size-full place-items-center bg-gradient-to-br from-surface-2 to-surface text-ink-3">
                  <MusicIcon className="size-10" />
                </span>
              }
              src={result.thumbnail}
            />
            {length ? <TileBadge>{length}</TileBadge> : null}
            {result.favicon ? <TileFavicon src={result.favicon} /> : null}
          </ResultLink>
          {playable && isPlaying ? (
            mode === "audio" && audioSrc ? (
              <AudioTilePlayer
                onClose={() => {
                  setPlaying(null);
                }}
                onError={() => {
                  // raw stream failed - fall back to the embed when one exists
                  if (embedSrc) {
                    setMode("embed");
                  } else {
                    setPlaying(null);
                  }
                }}
                src={audioSrc}
              />
            ) : (
              <EmbedTile
                onClose={() => {
                  setPlaying(null);
                }}
                src={embedSrc}
                title={result.title_text}
              />
            )
          ) : null}
          {playable && !isPlaying ? (
            <TileCenterAction
              icon={<Play className="size-5 translate-x-px" />}
              label={t("play")}
              onClick={() => {
                setMode(audioSrc ? "audio" : "embed");
                setPlaying(index);
              }}
            />
          ) : null}
        </div>
        <TileTitle globals={globals} result={result} />
        <TileMeta
          left={<TileMetaAuthor author={result.author} />}
          right={<TileMetaDate date={result.published_date ? formatDate(result.published_date) : null} />}
        />
        <div className="mt-auto pt-1.5">
          <TileEngines result={result} />
        </div>
      </TileCell>
    );
  });
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 @sm:grid-cols-3 @[46rem]:grid-cols-4 @5xl:grid-cols-5">
      {cells}
    </div>
  );
}
