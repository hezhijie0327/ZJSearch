// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ArrowUpRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AiSourceMeta } from "@/features/aiAnswer/aiOverview.ts";
import { useHostFavicon } from "@/lib/favicons.ts";
import { useT } from "@/lib/i18n.ts";
import { useImgFallback } from "@/lib/imgFallback.ts";
import { hostnameOf } from "@/lib/link.ts";

/** The citation chips' shared hover-panel state: open on hover/focus with
    the anchor's rect (kept inside the viewport), a 120ms grace when the
    pointer leaves (moving onto the panel keeps it), unmount clears the
    timer.  Both the single chip and the group pill ride it. */
function useFloatPanel() {
  const [panel, setPanel] = useState<{ x: number; y: number; w: number } | null>(null);
  const hideTimer = useRef<number | null>(null);

  const keepPanel = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const closeSoon = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
    }
    hideTimer.current = window.setTimeout(() => {
      setPanel(null);
      hideTimer.current = null;
    }, 120);
  };

  const openPanel = (anchor: HTMLElement | null, width: number, height: number) => {
    keepPanel();
    const rect = anchor?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    // keep the floating panel inside the viewport
    const x = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const y = rect.bottom + 8 + height <= window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - height - 8);
    setPanel({ x, y, w: width });
  };

  useEffect(
    () => () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
      }
    },
    [],
  );

  return { panel, openPanel, keepPanel, closeSoon, close: () => setPanel(null) };
}

/** The hover panel's favicon cell: the source's wire favicon first, then
    the classic channel (lib/favicons' host route) for the hosts the wire
    left blank -- page reads, browser mints and recalled pages all carry
    favicon:"" on their sources events.  No icon anywhere: the caller's
    fallback keeps the row rhythm. */
function PanelFavicon({
  favicon,
  url,
  className,
  fallback,
}: {
  favicon?: string;
  url: string;
  className: string;
  fallback: ReactNode;
}) {
  const fetched = useHostFavicon(favicon ? null : hostnameOf(url));
  const src = favicon || fetched || "";
  const [failed, markFailed] = useImgFallback(src);
  return failed ? <>{fallback}</> : <img alt="" className={className} onError={markFailed} src={src} />;
}

/** Compact [n] citation chip: hovering opens a floating preview panel with
    the source favicon, site and title (portalled to <body> so the clamp
    wrapper's overflow-hidden cannot clip it); clicking jumps to the
    matching result row.  Moving between chip and panel keeps it open. */
export function CitationChip({
  n,
  source,
  onCite,
}: {
  n: number;
  source: AiSourceMeta;
  onCite?: (index: number) => void;
}) {
  const t = useT();
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const float = useFloatPanel();
  return (
    <>
      <button
        aria-label={`${t("open_source")} ${n}`}
        className="mx-0.5 inline-flex items-center rounded align-middle text-xs text-accent transition-colors hover:text-accent-hover hover:underline underline-offset-2"
        onBlur={float.closeSoon}
        onClick={() => {
          onCite?.(n);
          float.close();
        }}
        onFocus={() => float.openPanel(chipRef.current, 320, 150)}
        onMouseEnter={() => float.openPanel(chipRef.current, 320, 150)}
        onMouseLeave={float.closeSoon}
        ref={chipRef}
        type="button"
      >
        [{n}]
      </button>
      {float.panel
        ? createPortal(
            <div
              className="fixed z-50 cursor-pointer rounded-2xl border border-line bg-surface p-3 shadow-pop"
              onClick={() => {
                onCite?.(n);
                float.close();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onCite?.(n);
                  float.close();
                }
              }}
              onMouseEnter={float.keepPanel}
              onMouseLeave={float.closeSoon}
              role="button"
              style={{ left: float.panel.x, top: float.panel.y, width: float.panel.w }}
              tabIndex={0}
            >
              <div className="flex items-center gap-1.5 text-xs text-ink-3">
                <PanelFavicon
                  className="size-4 rounded-full object-contain"
                  fallback={null}
                  favicon={source.favicon}
                  url={source.u}
                />
                <span className="truncate">{source.domain}</span>
                <a
                  aria-label={t("open_source")}
                  className="ms-auto inline-flex items-center rounded p-0.5 transition-colors hover:bg-surface-2 hover:text-accent"
                  href={source.u}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                  rel="noreferrer"
                  target="_blank"
                  title={source.u}
                >
                  <ArrowUpRight className="size-3.5" />
                </a>
              </div>
              <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-ink">{source.t}</p>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** The GROUP pill ([1,2]): one button where the adjacent single chips used
    to cluster -- hovering/focusing opens a panel listing every member
    source (favicon + domain + title row), and each row jumps to the rail's
    matching #n card.  Members without a source behind them (phantoms) do
    not get a row; a group with NO resolvable member renders as the static
    fallback span (the `a` branch handles that before mounting this). */
export function CitationGroupChip({
  nums,
  sources,
  onCite,
}: {
  nums: number[];
  sources: Array<AiSourceMeta | undefined>;
  onCite?: (index: number) => void;
}) {
  const t = useT();
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const float = useFloatPanel();
  const rows = nums.map((n, i) => ({ n, source: sources[i] })).filter((row) => row.source);
  return (
    <>
      <button
        aria-expanded={float.panel !== null}
        aria-label={`${t("open_source")} ${nums.join(",")}`}
        className="mx-0.5 inline-flex items-center rounded align-middle text-xs text-accent transition-colors hover:text-accent-hover hover:underline underline-offset-2"
        onBlur={float.closeSoon}
        onClick={() => {
          // keyboard/touch activation opens the panel; a row click jumps
          const first = rows[0];
          if (first && float.panel) {
            onCite?.(first.n);
            float.close();
          } else {
            float.openPanel(chipRef.current, 320, Math.min(48 + rows.length * 44, 220));
          }
        }}
        onFocus={() => float.openPanel(chipRef.current, 320, Math.min(48 + rows.length * 44, 220))}
        onMouseEnter={() => float.openPanel(chipRef.current, 320, Math.min(48 + rows.length * 44, 220))}
        onMouseLeave={float.closeSoon}
        ref={chipRef}
        type="button"
      >
        [{nums.join(",")}]
      </button>
      {float.panel
        ? createPortal(
            <div
              aria-label={t("open_source")}
              className="fixed z-50 rounded-2xl border border-line bg-surface p-2 shadow-pop"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  float.close();
                }
              }}
              onMouseEnter={float.keepPanel}
              onMouseLeave={float.closeSoon}
              role="group"
              style={{ left: float.panel.x, top: float.panel.y, width: float.panel.w }}
              tabIndex={-1}
            >
              <div className="space-y-1">
                {rows.map(({ n, source }) => (
                  <button
                    className="flex w-full items-start gap-2 rounded-xl p-1.5 text-start transition-colors hover:bg-surface-2"
                    key={n}
                    onClick={() => {
                      onCite?.(n);
                      float.close();
                    }}
                    type="button"
                  >
                    <PanelFavicon
                      className="mt-0.5 size-4 shrink-0 rounded-full object-contain"
                      fallback={
                        <span aria-hidden="true" className="mt-0.5 size-4 shrink-0 rounded-full bg-surface-2" />
                      }
                      favicon={source?.favicon}
                      url={source?.u ?? ""}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-ink-3">
                        {source?.domain}
                        <span className="ms-1 text-ink-2">#{n}</span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-ink">{source?.t}</span>
                    </span>
                    <ArrowUpRight aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-ink-3" />
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
