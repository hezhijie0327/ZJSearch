// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { LoaderCircle } from "lucide-react";
import { useMemo } from "react";
import { MarkdownAnswer } from "@/features/results/AiSummary.tsx";
import type { AiSearchGallery, AiSourceMeta } from "@/features/results/aiOverview.ts";
import { citeToLinks } from "@/lib/citations.ts";
import { useT } from "@/lib/i18n.ts";
import { scrollIntoViewAnimated } from "@/lib/motion.ts";

/**
 * The REPORT document renderer: the run's outline becomes the document
 * (title + subtitle + a TOC + one rendered section per outline entry),
 * streamed section-by-section -- each section's markdown rides the same
 * `MarkdownAnswer` pipeline as the single-write answer (GFM tables,
 * mermaid, KaTeX, citation chips), so a report is the answer contract,
 * typographically elevated.  A section still writing carries the live
 * spinner in the TOC and at its heading; the TOC row scrolls to its
 * section (the animated scroll -- rAF is not a safe primitive).
 */

export function DocumentView({
  run,
  meta,
  onCite,
  settled,
}: {
  run: {
    runNo: number;
    outline: NonNullable<{
      title: string;
      subtitle?: string;
      sections: Array<{ id: string; title: string; status: "pending" | "writing" | "done" }>;
    }>;
    sections?: Record<string, string>;
    galleries: AiSearchGallery[][];
  };
  meta: AiSourceMeta[];
  onCite: (n: number) => void;
  settled: boolean;
}) {
  const t = useT();
  const outline = run.outline;
  const anchorId = (id: string) => `zjs-report-${run.runNo}-${id}`;
  const doneCount = useMemo(() => outline.sections.filter((s) => s.status === "done").length, [outline.sections]);
  const jump = (id: string) => {
    document.getElementById(anchorId(id)) &&
      scrollIntoViewAnimated(document.getElementById(anchorId(id)) as HTMLElement);
  };
  return (
    <div className="zjs-answer-body text-sm leading-relaxed text-ink">
      {/* the document header: title + subtitle (the report cover's text
          half -- the classification chip and meta window are the outline's
          own data, not invented chrome) */}
      <header className="mb-4 border-b border-line pb-4">
        <h1 className="text-2xl font-semibold leading-snug text-ink" dir="auto">
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
          motion aware) */}
      <nav aria-label={t("ai_report_toc")} className="mb-5 rounded-xl bg-surface-2/40 px-3 py-2.5">
        <ol className="space-y-1">
          {outline.sections.map((section, index) => (
            <li key={section.id}>
              <button
                className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-[13px] text-ink-2 transition-colors hover:bg-surface-2/70 hover:text-ink"
                onClick={() => {
                  jump(section.id);
                }}
                type="button"
              >
                <span className="w-4 shrink-0 text-end font-mono text-[11px] tabular-nums text-ink-3">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {section.title}
                </span>
                {section.status === "writing" ? (
                  <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin text-accent" />
                ) : section.status === "pending" ? (
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full border border-ink-3/50" />
                ) : null}
              </button>
            </li>
          ))}
        </ol>
        {doneCount < outline.sections.length ? (
          <p className="mt-1 px-1.5 text-[11px] text-ink-3">
            {t("ai_report_progress", { done: String(doneCount), total: String(outline.sections.length) })}
          </p>
        ) : null}
      </nav>
      {outline.sections.map((section) => {
        const text = run.sections?.[section.id] ?? "";
        // a PENDING section renders NOTHING in the document body -- its
        // existence is the TOC's hollow dot; a bare heading column would
        // read as empty chapters while the report streams
        if (section.status === "pending" && !text) {
          return null;
        }
        return (
          <section className="scroll-mt-20" id={anchorId(section.id)} key={section.id}>
            <h2 className="mt-6 flex items-center gap-2 text-lg font-semibold text-ink first:mt-0" dir="auto">
              {section.status === "writing" ? (
                <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-accent" />
              ) : null}
              {section.title}
            </h2>
            {text ? (
              <MarkdownAnswer
                galleries={run.galleries}
                markdown={citeToLinks(text)}
                meta={meta}
                onCite={onCite}
                settled={settled}
              />
            ) : section.status === "writing" ? (
              <div aria-hidden="true" className="mt-2 space-y-2">
                <div className="h-3 w-full animate-pulse rounded bg-surface-2/70" />
                <div className="h-3 w-4/5 animate-pulse rounded bg-surface-2/70" />
                <div className="h-3 w-3/5 animate-pulse rounded bg-surface-2/70" />
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
