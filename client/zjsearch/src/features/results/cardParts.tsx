// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  Archive,
  Award,
  Calendar,
  ChevronLeft,
  Clock,
  Eye,
  Globe,
  ImageOff,
  Music,
  Play,
  Server,
  User,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import { useCacheUrl } from "@/features/results/CacheUrlProvider.tsx";
import { formatDate, formatLength, formatScore } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { newTabLinkProps } from "@/lib/link.ts";
import { CHIP, CHIP_HOVER, META_ROW, TILE_BADGE } from "@/lib/styles.ts";
import type { GlobalData, ResultItem } from "@/lib/types.ts";
import { useCapExpand } from "@/lib/useCapExpand.ts";

// ------------------------------------------------------------- shared parts

export function ResultLink({
  result,
  globals,
  href,
  className,
  children,
}: {
  result: ResultItem;
  globals: GlobalData;
  href?: string;
  className?: string;
  children: ReactNode;
}) {
  const url = href ?? result.url;
  return (
    <a className={className} href={url} {...newTabLinkProps(globals.results_on_new_tab)}>
      {children}
    </a>
  );
}

function Favicon({ result }: { result: ResultItem }) {
  const [failed, setFailed] = useState(!result.favicon);
  if (failed || !result.favicon) {
    return <Globe className="size-4 shrink-0 text-ink-3" />;
  }
  return (
    <img
      alt=""
      className="size-4 shrink-0 rounded-sm object-contain"
      decoding="async"
      loading="lazy"
      onError={() => setFailed(true)}
      src={result.favicon}
    />
  );
}

export function PrettyUrl({ result, globals }: { result: ResultItem; globals: GlobalData }) {
  if (!result.pretty_url || result.pretty_url.length === 0) {
    return null;
  }
  return (
    <ResultLink
      className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3 group-hover:text-ink-2"
      globals={globals}
      result={result}
    >
      <Favicon result={result} />
      <span className="truncate" dir="ltr">
        {result.pretty_url.join("")}
      </span>
    </ResultLink>
  );
}

export function Title({ result, globals }: { result: ResultItem; globals: GlobalData }) {
  return (
    <h2 className="line-clamp-1 text-base font-medium leading-6">
      <ResultLink
        className="text-ink decoration-accent/50 underline-offset-2 hover:text-accent hover:underline"
        globals={globals}
        result={result}
      >
        <span dangerouslySetInnerHTML={{ __html: result.title_html }} dir="auto" />
      </ResultLink>
    </h2>
  );
}

export function MetaLine({ result }: { result: ResultItem }) {
  const t = useT();
  const bits: ReactNode[] = [];
  if (result.published_date) {
    bits.push(
      <span className="inline-flex items-center gap-1" key="date">
        <Calendar className="size-3" />
        {formatDate(result.published_date)}
      </span>,
    );
  }
  if (result.author) {
    bits.push(
      <span className="inline-flex items-center gap-1" key="author">
        <User className="size-3 shrink-0" />
        {result.author}
      </span>,
    );
  }
  if (result.views) {
    bits.push(
      <span className="inline-flex items-center gap-1" key="views">
        <Eye className="size-3 shrink-0" />
        {result.views}
      </span>,
    );
  }
  const length = formatLength(result.length_display, result.length_seconds);
  if (length) {
    bits.push(
      <span className="inline-flex items-center gap-1" key="length">
        <Clock className="size-3" />
        {length}
      </span>,
    );
  }
  if (bits.length === 0) {
    return null;
  }
  return (
    <div className={`${META_ROW} gap-x-3 text-xs text-ink-3`}>
      {bits}
      {result.metadata ? (
        <span className="rounded bg-accent-soft px-1.5 py-0.5 text-accent" dir="auto">
          {result.metadata}
        </span>
      ) : null}
      <span className="sr-only">{t("response_time")}</span>
    </div>
  );
}

/** Unified engine attribution for EVERY view: [score] [first engine] [+N],
    expanding inline on demand.  The score leads as a tabular pill; the
    first pill's title always carries the full engine list.  `tone="dark"`
    renders the fixed-dark chip language of the image lightbox. */
export function EnginesLine({
  result,
  leading,
  compact = false,
  tone = "light",
}: {
  result: ResultItem;
  leading?: ReactNode;
  /** tile views: single-line row that swipes horizontally instead of wrapping */
  compact?: boolean;
  /** light: theme chips; dark: the lightbox's fixed-dark media chrome */
  tone?: "dark" | "light";
}) {
  const t = useT();
  const cacheUrl = useCacheUrl();
  // cap-and-expand: the first engine leads, "+N" reveals the rest
  const { expanded, toggle, hidden } = useCapExpand(result.engines.length, 1);
  const engines = result.engines;
  if (engines.length === 0 && !leading) {
    return null;
  }
  const chip =
    tone === "dark"
      ? "inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-xs text-zinc-300"
      : CHIP;
  const chipHover = tone === "dark" ? "transition-colors hover:text-white" : CHIP_HOVER;
  return (
    <div
      className={`mt-2 flex min-w-0 items-center gap-x-2 text-xs ${
        tone === "dark" ? "text-zinc-300" : "text-ink-3"
      } ${compact ? "flex-nowrap overflow-hidden" : "flex-wrap gap-y-1"}`}
    >
      {typeof result.score === "number" ? (
        <span className={`${chip} shrink-0 tabular-nums`} title={t("scores")}>
          <Award className="size-3 shrink-0" />
          {formatScore(result.score)}
        </span>
      ) : null}
      {leading}
      {engines.length > 0 ? (
        // the lead engine truncates inside the row (tiles pin this line to
        // the tile bottom — it must never overflow the tile edge)
        <span className={`${chip} min-w-0 max-w-full truncate`} title={engines.join(", ")}>
          <Server className="size-3 shrink-0" />
          {engines[0]}
        </span>
      ) : null}
      {expanded
        ? engines.slice(1).map((engine) => (
            <span className={`${chip} shrink-0`} key={engine}>
              <Server className="size-3 shrink-0" />
              {engine}
            </span>
          ))
        : null}
      {hidden > 0 ? (
        <button aria-expanded={expanded} className={`${chip} shrink-0 ${chipHover}`} onClick={toggle} type="button">
          {expanded ? (
            <>
              <ChevronLeft className="size-3 shrink-0" />
              {t("show_less")}
            </>
          ) : (
            `+${hidden}`
          )}
        </button>
      ) : null}
      {cacheUrl ? (
        compact ? (
          // tiles: icon-only so the pinned one-liner never overflows the tile
          <a
            aria-label={t("cached")}
            className={`${chip} shrink-0 ${chipHover}`}
            href={cacheUrl + result.url}
            {...newTabLinkProps(true)}
            title={t("cached")}
          >
            <Archive className="size-3 shrink-0" />
          </a>
        ) : (
          <a className={`${chip} ${chipHover}`} href={cacheUrl + result.url} {...newTabLinkProps(true)}>
            <Archive className="size-3 shrink-0" />
            {t("cached")}
          </a>
        )
      ) : null}
    </div>
  );
}

export function Thumb({
  src,
  alt,
  className,
  lengthDisplay,
  eager,
}: {
  src: string;
  alt: string;
  className?: string;
  lengthDisplay?: string | null;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(!src);
  const [loaded, setLoaded] = useState(false);
  if (failed) {
    return (
      <span className={`flex items-center justify-center rounded-xl bg-surface-2 text-ink-3 ${className ?? ""}`}>
        <ImageOff className="size-4" />
      </span>
    );
  }
  return (
    <div className={`relative shrink-0 overflow-hidden rounded-xl bg-surface-2 ${className ?? ""}`}>
      <img
        alt={alt}
        /* lazy images fade in on load (bg-surface-2 shows through), eager
           ones paint immediately (LCP) */
        className={`size-full object-cover transition-[transform,opacity] duration-300 group-hover:scale-[1.04] ${eager || loaded ? "opacity-100" : "opacity-0"}`}
        decoding="async"
        loading={eager ? "eager" : "lazy"}
        onError={() => {
          setFailed(true);
        }}
        onLoad={() => {
          setLoaded(true);
        }}
        src={src}
      />
      {lengthDisplay ? <span className={`bottom-1 right-1 ${TILE_BADGE}`}>{lengthDisplay}</span> : null}
    </div>
  );
}

export function ResultArticle({ children, priority, id }: { children: ReactNode; priority?: string; id?: string }) {
  return (
    <article
      className={`group relative scroll-mt-32 rounded-2xl border border-transparent p-4 transition-colors hover:bg-surface ${
        priority === "low" ? "opacity-70" : ""
      }`}
      data-priority={priority || undefined}
      id={id}
    >
      {children}
    </article>
  );
}

export function MediaCollapse({
  showLabel,
  hideLabel,
  children,
}: {
  showLabel: string;
  hideLabel: string;
  children: (open: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div>
      <button
        aria-controls={panelId}
        aria-expanded={open}
        className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink"
        onClick={() => {
          setOpen((prev) => !prev);
        }}
        type="button"
      >
        <Play className="size-3.5" />
        {open ? hideLabel : showLabel}
      </button>
      {/* unmount after the close animation: folded embeds must not keep
          streaming video/audio */}
      <Collapse className={open ? "mt-2" : ""} id={panelId} open={open} unmountAfterHide>
        {children(open)}
      </Collapse>
    </div>
  );
}

export function EmbedFrame({ src }: { src: string }) {
  const t = useT();
  return (
    // the embed grows with the results column (container queries on the
    // results wrapper) instead of capping at the list-text width
    <div className="aspect-video w-full max-w-3xl overflow-hidden rounded-2xl border border-line bg-black @4xl:max-w-4xl @5xl:max-w-5xl">
      <iframe allowFullScreen className="size-full" referrerPolicy="origin" src={src} title={t("embedded_content")} />
    </div>
  );
}

/** Always-visible preview (music intent): prefer our own audio player for
    stream URLs; when the source is not raw audio fall back to the embed. */
export function MediaPreview({ src, video = false }: { src: string; video?: boolean }) {
  const [audioFailed, setAudioFailed] = useState(false);
  if (video || audioFailed) {
    return <EmbedFrame src={src} />;
  }
  return (
    <div className="flex max-w-3xl items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 @4xl:max-w-4xl @5xl:max-w-5xl">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
        <Music className="size-4.5" />
      </span>
      <audio
        className="h-9 w-full"
        controls
        onError={() => {
          setAudioFailed(true);
        }}
        preload="none"
        src={src}
      />
    </div>
  );
}

// -------------------------------------------------------------- card shells

export interface CardProps {
  result: ResultItem;
  globals: GlobalData;
  /** map-intent pages open the inline OSM map automatically (upstream simple behaviour) */
  autoOpenMap?: boolean;
  /** music-intent pages show the media preview expanded with our own player */
  mediaOpen?: boolean;
  /** first results load their thumbnail eagerly (LCP) */
  eager?: boolean;
}
/** Placeholder of a text card, in the loaded card's exact slot rhythm
    (url / mt-1 title / mt-1.5 snippet ×2 / mt-2 engines pill) so the swap to
    the real cards does not shift heights.  The streamed server skeleton
    (skeleton.html) mirrors these bars — keep both in sync. */
export function ResultSkeleton() {
  return (
    <div className="rounded-2xl p-4">
      <div className="zjs-skeleton h-4 w-40" />
      <div className="zjs-skeleton mt-1 h-6 w-3/4" />
      <div className="zjs-skeleton mt-1.5 h-5.5 w-full" />
      <div className="zjs-skeleton mt-1.5 h-5.5 w-5/6" />
      {/* engines-row slot so the skeleton matches the loaded card height */}
      <div className="zjs-skeleton mt-2 h-5.5 w-28 rounded-full" />
    </div>
  );
}
