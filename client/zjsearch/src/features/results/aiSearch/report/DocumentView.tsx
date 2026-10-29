// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Tape } from "@/components/Tape.tsx";
import { MarkdownAnswer } from "@/features/results/AIOverview.tsx";
import type { AiSearchGallery, AiSourceMeta } from "@/features/results/aiOverview.ts";
import { citedSourceRows, citeToLinks } from "@/lib/citations.ts";
import { useT } from "@/lib/i18n.ts";
import { holdBackTail } from "@/lib/markdownParts.ts";
import { scrollIntoViewAnimated } from "@/lib/motion.ts";
import { CHIP_BTN } from "@/lib/styles.ts";

/**
 * The REPORT document renderer: the run's outline becomes the document
 * (title + subtitle + a TOC + one rendered section per outline entry),
 * streamed section-by-section -- each section's markdown rides the same
 * `MarkdownAnswer` pipeline as the single-write answer (GFM tables,
 * mermaid, KaTeX, citation chips), so a report is the answer contract,
 * typographically elevated.  A section still writing carries the live
 * spinner in the TOC and at its heading; a FAILED section (its stream
 * died -- the server's gap placeholder shipped) carries the warning
 * mark and the rewrite chip beside its heading; the TOC row scrolls to
 * its section (the animated scroll -- rAF is not a safe primitive).  A
 * settled document carries the family postmark at its tail (DESIGN.md
 * §7 `.paper-postmark`, the LockScreen stamp's real-meta cousin): the
 * filing date + label, mono, deterministic 12° tilt, in flow.
 */

/** The server's gap placeholder (synth.py owns the string): a failed
    section whose buffer holds exactly this renders the localized note
    instead -- the English machine line is not report prose. */
const GAP_PLACEHOLDER = "*Section generation failed upstream*";

export function DocumentView({
  run,
  meta,
  onCite,
  onRewrite,
  rewritingId,
  settled,
  stamp,
}: {
  run: {
    runNo: number;
    outline: NonNullable<{
      title: string;
      subtitle?: string;
      sections: Array<{ id: string; title: string; status: "pending" | "writing" | "done" | "failed" }>;
    }>;
    sections?: Record<string, string>;
    galleries: AiSearchGallery[][];
  };
  meta: AiSourceMeta[];
  onCite: (n: number) => void;
  /** the failed section's rewrite action (absent while the run's host
      is unreachable -- the chip is then warning-only) */
  onRewrite?: (sectionId: string) => void;
  /** the section a rewrite is currently streaming (its chip spins) */
  rewritingId?: string | null;
  settled: boolean;
  /** the run's settle client-clock (ms) — the tail postmark's filing date;
      absent/0 renders no stamp */
  stamp?: number | null;
}) {
  const t = useT();
  const outline = run.outline;
  // THE RUN PAGE SPEAKS GLOBAL: the rail's #n source cards sit right
  // beside the document, so body chips render the run's registry numbers
  // 1:1 -- an IDENTITY map over the known sources (phantom [n]s stay
  // unlinked verbatim; streaming can never renumber chips mid-read).  The
  // document-local [1..N] first-citation renumbering stays with the
  // SELF-CONTAINED surfaces (knowledge inspector, markdown exports):
  // there the reader has no rail to match against.
  const citationMap = useMemo(() => {
    const knownNs = new Set(meta.map((source) => source.n).filter((n): n is number => Number.isInteger(n)));
    // possibly EMPTY == the old undefined: verbatim global chips, no rows
    const map = new Map<number, number>();
    for (const n of [...knownNs].sort((a, b) => a - b)) {
      map.set(n, n);
    }
    return map;
  }, [meta]);
  const citedMeta = useMemo(() => citedSourceRows(citationMap, meta), [citationMap, meta]);
  // the chips carry global numbers now -- a click hands the rail its
  // registry number directly
  const onCiteLocal = (local: number) => {
    onCite(local);
  };
  // the anchor prefix is a STABLE string per run (the effect below reads it
  // directly -- a fresh anchorId closure would re-run the observer every render)
  const anchorPrefix = `zjs-report-${run.runNo}-`;
  const anchorId = (id: string) => `${anchorPrefix}${id}`;
  const doneCount = useMemo(() => outline.sections.filter((s) => s.status === "done").length, [outline.sections]);
  // scroll-spy: the TOC row of the section nearest the viewport top gets
  // the active accent (IntersectionObserver -- rootMargin picks whichever
  // section crosses the upper third of the document pane)
  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = (entry.target as HTMLElement).id.replace(anchorPrefix, "");
            setActiveId(id);
          }
        }
      },
      { rootMargin: "-15% 0px -70% 0px" },
    );
    for (const section of outline.sections) {
      const el = document.getElementById(`${anchorPrefix}${section.id}`);
      if (el) {
        io.observe(el);
      }
    }
    return () => {
      io.disconnect();
    };
  }, [outline.sections, anchorPrefix]);
  const jump = (id: string) => {
    document.getElementById(anchorId(id)) &&
      scrollIntoViewAnimated(document.getElementById(anchorId(id)) as HTMLElement);
  };
  // the postmark's filing date: an ABSOLUTE local YYYY-MM-DD (a stamp is
  // bureaucratic, never relative) — deterministic per settle clock
  const stampDate = (() => {
    if (!stamp) {
      return null;
    }
    const d = new Date(stamp);
    if (Number.isNaN(d.getTime())) {
      return null;
    }
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  return (
    // the long-form reading scale (DESIGN.md §4, the fluid .prose root --
    // the CJK serif long-form voice, headings/tables ride em so they
    // follow the root; the base ramps 16px @320 → 17px desktop cap)
    <div className="zjs-answer-body zjs-prose text-ink">
      {/* the document header: title + subtitle (the report cover's text
          half -- the classification chip and meta window are the outline's
          own data, not invented chrome).  The title takes the blog's
          page-H1 prescription (§4). */}
      <header className="mb-4 border-b border-line pb-4">
        <h1 className="font-serif text-3xl font-black leading-tight tracking-tight text-ink sm:text-4xl" dir="auto">
          {outline.title}
        </h1>
        {outline.subtitle ? (
          <p className="mt-1 text-[13px] text-ink-3" dir="auto">
            {outline.subtitle}
          </p>
        ) : null}
      </header>
      {/* the TOC: the outline IS the progress surface -- pending hollow,
          writing spinner, done clean; clicking jumps (animated, reduced-
          motion aware).  The family paper ground (DESIGN.md §7): a torn
          note with one tape corner -- the report's own quick-reference
          slip, tape a SIBLING of the clipped note */}
      <div className="relative mb-5">
        <Tape className="w-16 bg-accent-soft/80" corner="start" seed={outline.title} />
        <nav aria-label={t("ai_report_toc")} className="paper-note px-4 py-3">
          <ol className="space-y-1">
            {outline.sections.map((section, index) => (
              <li key={section.id}>
                <button
                  className={`group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-[13px] transition-colors hover:bg-surface-2/70 ${
                    activeId === section.id ? "bg-surface-2/70 font-medium text-accent" : "text-ink-2 hover:text-ink"
                  }`}
                  onClick={() => {
                    jump(section.id);
                  }}
                  type="button"
                >
                  <span className="w-4 shrink-0 text-end font-mono text-xs tabular-nums text-ink-3">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    {section.title}
                  </span>
                  {section.status === "writing" ? (
                    <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin text-accent" />
                  ) : section.status === "failed" ? (
                    <AlertTriangle aria-hidden="true" className="size-3 shrink-0 text-warning" />
                  ) : section.status === "pending" ? (
                    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full border border-ink-3/50" />
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
          {doneCount < outline.sections.length ? (
            <p className="mt-1 px-1.5 text-xs text-ink-3">
              {t("ai_report_progress", { done: String(doneCount), total: String(outline.sections.length) })}
            </p>
          ) : null}
        </nav>
      </div>
      {outline.sections.map((section) => {
        const raw = run.sections?.[section.id] ?? "";
        // the failed section's gap placeholder is the server's machine
        // line, not report prose -- the localized failure note takes its
        // place (partial streamed text stands as written)
        const isGap = section.status === "failed" && raw.trim() === GAP_PLACEHOLDER;
        const text = isGap ? "" : raw;
        // a PENDING section renders NOTHING in the document body -- its
        // existence is the TOC's hollow dot; a bare heading column would
        // read as empty chapters while the report streams.  A FAILED one
        // renders its heading + the failure note -- the rewrite chip's
        // home.
        if (section.status === "pending" && !text) {
          return null;
        }
        const busy = rewritingId === section.id;
        return (
          <section className="scroll-mt-20" id={anchorId(section.id)} key={section.id}>
            <h2
              className="mt-6 flex items-center gap-2 text-[1.5em] font-semibold tracking-tight text-ink first:mt-0"
              dir="auto"
            >
              {section.status === "writing" || busy ? (
                <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-accent" />
              ) : section.status === "failed" ? (
                <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
              ) : null}
              {section.title}
              {section.status === "failed" && onRewrite ? (
                <button
                  aria-label={busy ? t("ai_section_rewriting") : t("ai_section_rewrite")}
                  className={`${CHIP_BTN} ms-1`}
                  onClick={() => onRewrite(section.id)}
                  title={busy ? t("ai_section_rewriting") : t("ai_section_rewrite")}
                  type="button"
                >
                  {busy ? (
                    <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                </button>
              ) : null}
            </h2>
            {text ? (
              <MarkdownAnswer
                figureLightbox
                galleries={run.galleries}
                markdown={citeToLinks(holdBackTail(text, settled), citationMap)}
                meta={citedMeta}
                onCite={onCiteLocal}
                settled={settled}
              />
            ) : section.status === "writing" || busy ? (
              <div aria-hidden="true" className="mt-2 space-y-2">
                <div className="h-3 w-full animate-pulse rounded bg-surface-2/70" />
                <div className="h-3 w-4/5 animate-pulse rounded bg-surface-2/70" />
                <div className="h-3 w-3/5 animate-pulse rounded bg-surface-2/70" />
              </div>
            ) : section.status === "failed" ? (
              <p className="mt-2 text-[13px] text-warning" dir="auto">
                {t("ai_section_rewrite_note")}
              </p>
            ) : null}
          </section>
        );
      })}
      {/* the filing postmark (DESIGN.md §7 .paper-postmark): the report is
          a delivered document — date + label, real meta (not aria-hidden),
          in flow so it never overlaps text at any width and prints with
          the paper (export/print contract) */}
      {settled && stampDate ? (
        <p className="paper-postmark mt-10 ms-auto size-24 rotate-12 text-ink-3">
          {/* negative end margin cancels the tracking's trailing gap, so the
              stamp text optically centers in the ring (same as the blog's
              SEALED postmark) */}
          <span className="-me-[0.14em] font-mono text-[10px] leading-none tracking-[0.14em] tabular-nums">
            {stampDate}
          </span>
          <span className="-me-[0.22em] font-mono text-[8px] leading-none tracking-[0.22em] uppercase">
            {t("ai_report_stamp_label")}
          </span>
        </p>
      ) : null}
    </div>
  );
}
