// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useT } from "@/lib/i18n.ts";

/**
 * Clamp-and-reveal disclosure for long content (infobox abstract, AI
 * overview): the content shows a fixed-height preview with a gradient scrim
 * and one full-width expand pill.
 *
 * Expanding animates max-height to the measured content height and lifts the
 * cap entirely once the ease has played (late growth -- a diagram that renders
 * after the measurement, fonts, view switches -- must never sit under a stale
 * cap); collapsing re-applies the cap at the fresh content height first, so
 * the ease down to the preview interpolates instead of snapping.
 *
 * max-height cannot transition to `none`, which is why the expanded state
 * pins a real pixel value kept current by a ResizeObserver (+1 guards against
 * sub-pixel rounding clipping the last text line).  Content that fits the
 * preview renders without clamp, scrim or toggle.  While `active` is false
 * (a stream still growing) the height simply follows the content.
 */
export function ClampReveal({
  active = true,
  buttonClassName,
  className = "",
  children,
  previewPx,
}: {
  /** false while the content is still growing (streaming): never clamp */
  active?: boolean;
  /** full button classes for the expand/collapse pill */
  buttonClassName: string;
  /** extra classes on the capped wrapper (spacing) */
  className?: string;
  children: ReactNode;
  /** collapsed preview height in px */
  previewPx: number;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [capless, setCapless] = useState(false);
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentPx, setContentPx] = useState<number | null>(null);

  // the measured node is mounted by the time this component renders (callers
  // render it with the content), so a mount-only observer is enough
  useEffect(() => {
    const el = contentRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => {
      setContentPx(Math.ceil(el.getBoundingClientRect().height) + 1);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  // unmeasured content is assumed tall: the toggle exists from the first
  // frame instead of popping in after the observer's first tick
  const needsClamp = active && (contentPx === null || contentPx > previewPx + 24);

  const toggle = () => {
    setCapless(false);
    if (expanded) {
      // let the wrapper re-apply the pixel cap at the current height before
      // the collapsed state eases down to the preview
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setExpanded(false);
        });
      });
    } else {
      setExpanded(true);
    }
  };

  return (
    <>
      {/* overflow-hidden stays on in both states (without it inner margins
          collapse through the wrapper when expanded); flow-root keeps the
          inner's first-child margin inside the measured box */}
      <div
        className={`relative overflow-hidden transition-[max-height] duration-300 ease-out ${className}`}
        id={contentId}
        onTransitionEnd={(event) => {
          if (event.propertyName === "max-height" && expanded) {
            setCapless(true);
          }
        }}
        style={{
          maxHeight: needsClamp
            ? expanded
              ? capless
                ? undefined
                : (contentPx ?? previewPx)
              : previewPx
            : (contentPx ?? undefined),
        }}
      >
        <div className="relative flow-root" ref={contentRef}>
          {children}
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
          className={buttonClassName}
          onClick={toggle}
          type="button"
        >
          {expanded ? t("collapse") : t("expand")}
          <ChevronDown className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      ) : null}
    </>
  );
}
