// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  Brain,
  ChevronDown,
  CircleStop,
  Copy,
  CornerDownRight,
  Gauge,
  LayoutGrid,
  ListEnd,
  LoaderCircle,
  Paperclip,
  PenLine,
  Play,
  Printer,
  RefreshCw,
  Repeat2,
  Sparkles,
  Telescope,
  Waypoints,
  Zap,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClampReveal } from "@/components/ClampReveal.tsx";
import { Collapse } from "@/components/Collapse.tsx";
import { Tape } from "@/components/Tape.tsx";
import { AiRunFooter } from "@/features/aiAnswer/AiRunFooter.tsx";
import { Lightbox as AttachmentLightbox } from "@/features/aiAnswer/AttachmentLightbox.tsx";
import type { AiSourceMeta } from "@/features/aiAnswer/aiOverview.ts";
import { DeckView } from "@/features/aiAnswer/deck/DeckView.tsx";
import { haltText } from "@/features/aiAnswer/halts.ts";
import { MarkdownAnswer } from "@/features/aiAnswer/MarkdownAnswer.tsx";
import { DocumentView } from "@/features/aiAnswer/report/DocumentView.tsx";
import { ThinkScroll } from "@/features/aiAnswer/ThinkScroll.tsx";
import { AiSearchSources, AiSearchSourcesSkeleton } from "@/features/results/aiSearch/AiSearchSources.tsx";
import { AttachmentPreview } from "@/features/results/aiSearch/AttachmentPreview.tsx";
/** Collapsed run-title preview: three lines of text-3xl/leading-tight
    (30px × 1.25 ≈ 37.5px).  Matches the boot ghost's `line-clamp-3` and the
    static skeleton's `.zjs-boot-ai-title` clamp so the handover never
    shifts; deep-research briefs pasted as prompts read as a preview +
    expand chip instead of wall-to-wall 30px text. */
import { AskArchiveCard, ClarifyGate } from "@/features/results/aiSearch/askFlow.tsx";
import { BrowserMirrorSection } from "@/features/results/aiSearch/BrowserMirror.tsx";
import { DecisionsCard } from "@/features/results/aiSearch/DecisionsCard.tsx";
import { FindingsCard, GapsCard } from "@/features/results/aiSearch/ledgerCards.tsx";
import { PhaseStrip } from "@/features/results/aiSearch/PhaseStrip.tsx";
import { RailHeader } from "@/features/results/aiSearch/rail/RailSection.tsx";
import type { ReportTemplate, TemplateShape } from "@/features/results/aiSearch/reportTemplates.ts";
import { StepSegment } from "@/features/results/aiSearch/stepSegments.tsx";
import {
  ActiveStructureCard,
  OutputStructureCard,
  RunDeleteButton,
  StructureIdentityCard,
} from "@/features/results/aiSearch/structureCards.tsx";
import { TaskCard } from "@/features/results/aiSearch/taskCards.tsx";
import type { AiSearchRun } from "@/features/results/aiSearch/useAiSearch.ts";
import {
  applyLocalCiteNumbers,
  buildCitationMap,
  citedSourceNumbers,
  citedSourceRows,
  citeToLinks,
} from "@/lib/citations.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { buildAnswerMarkdown, buildReportMarkdown } from "@/lib/exporters.ts";
import { formatDuration } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { useImgFallback } from "@/lib/imgFallback.ts";
import { holdBackTail, inlineMdHtml } from "@/lib/markdownParts.ts";
import { animateScroll, scrollIntoViewAnimated } from "@/lib/motion.ts";
import { printDocument } from "@/lib/print.ts";
import {
  CHIP_ACCENT,
  CHIP_BTN,
  CHIP_OUTLINE,
  CHIP_OUTLINE_ACTIVE,
  CHIP_OUTLINE_IDLE,
  META_TOGGLE,
} from "@/lib/styles.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";

const RUN_TITLE_PREVIEW_PX = 113;

/**
 * One threaded Q&A section of the AI Search page: the question as a
 * heading, the collapsible Research box (the CHRONOLOGICAL step timeline
 * -- collapsible think segment, lightbulb-marked conclusion line, and
 * EXPANDABLE tool-call rows: a settled row with results opens a swipe
 * strip of that search's result cards), then the ANSWER+TWO-COLUMN body:
 * the flowing cited synthesis (with inline image groups) and the run's
 * Related questions keep the reading measure on the left while the run's
 * own source cards ride a sticky right rail from lg (stacked below on
 * narrow screens).  The FIRST section of the thread carries the large
 * page title; follow-up sections lead with a smaller heading behind a
 * thread divider.
 */

/** One tool-call row: status + query/url + result/char count, EXPANDABLE --
    a search row reveals its raw arguments (debug: exactly what the model
    passed) plus its result cards, a page read reveals the READING PANE
    (the crawled content itself).  The per-tool rows live in `calls/`;
    this is only the tool → row dispatch (an unknown tool falls through to
    the search-shaped row).  Memoized with the per-call merge INSIDE: the
    per-delta re-render of the steps tree re-invokes this map for every
    row, and the merge must not hand ToolRow a fresh array each time (a
    fresh `results` would defeat ToolRow's memo -- the write turn's
    per-token deltas would re-render every settled row, the audit
    round's hot-tree finding, 2026-11). */

function ElapsedTimer({ startedAt, endedAt }: { startedAt: number; endedAt: number | null }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt !== null) {
      return;
    }
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [endedAt]);
  const label = t("ai_elapsed_prefix", { time: formatDuration((endedAt ?? now) - startedAt) });
  return <span className="ms-auto shrink-0 tabular-nums text-xs text-ink-3">{label}</span>;
}

/** The clarify gate's question card: the run waits for the user's
    direction -- chips pick the options, one free-text line adds nuance,
    and the skip link researches without answers. */

function AiSearchRunSectionImpl({
  run,
  isFirst,
  isLast,
  live,
  sourceMeta,
  onCite,
  onRegenerate,
  onContinue,
  onFallback,
  onRelated,
  onGapsFollowup,
  onStop,
  onWrap,
  onSetTemplate,
  onClearTemplate,
  onSetShape,
  onDeleteRun,
  onSubmitClarify,
}: {
  run: AiSearchRun;
  isFirst: boolean;
  isLast: boolean;
  /** true while THIS run is the one streaming */
  live: boolean;
  /** citation-chip meta: the thread's sources up to and including this run */
  sourceMeta: AiSourceMeta[];
  onCite?: (index: number) => void;
  onRegenerate?: () => void;
  /** continue an INTERRUPTED research IN PLACE (the failed box's primary
      action when research gathered material -- the same run's stored
      conversation replays as the request's context) */
  onContinue?: () => void;
  onFallback?: () => void;
  /** a Related question was picked: start a follow-up run */
  onRelated?: (question: string) => void;
  /** the open-questions card's continue-research action: launch a follow-up run on this
      run's open gaps (the host composes the message) */
  onGapsFollowup?: (gaps: { q: string }[]) => void;
  onStop?: () => void;
  /** the report rail's output-structure control (research phase only) */
  onSetTemplate?: (template: ReportTemplate) => Promise<boolean>;
  /** withdraw a previously-picked template (the picker's free options) */
  onClearTemplate?: () => Promise<boolean>;
  /** the report rail's shape flip (report | deck | null = the
      direct-answer pick, research phase only): the server pairs the
      pending write-boundary shape with a canonical steer notice that
      adapts the researcher's remaining rounds; null withdraws every
      pending deliverable signal (a route-outline run rejects it) */
  onSetShape?: (shape: TemplateShape | null) => Promise<boolean>;
  /** delete THIS run (storage + timeline fold) -- settled runs only */
  onDeleteRun?: (runNo: number) => void;
  /** Wrap-up: the run finishes its round and the writer answers from the
      material gathered (the graceful end beside the hard stop) */
  onWrap?: () => void;
  /** the awaiting run's clarify card was answered (null = skipped) */
  onSubmitClarify?: (text: string | null) => void;
}) {
  const t = useT();
  const copyToast = useCopyToast();
  const [researchForced, setResearchForced] = useState<boolean | null>(null);
  // the writer's reasoning toggle (the OverviewCard pattern): the think
  // block stays ABOVE the answer for the run's whole life -- expanded
  // while the think streams, folded once the answer takes over, still
  // re-openable after the settle (never folded back into the research
  // record); the manual override wins over the auto behaviour, and a
  // re-run drops it so the new think follows the auto pattern again
  const [writeThinkForced, setWriteThinkForced] = useState<boolean | null>(null);
  // the citation-locate flow: an [n] click (answer chip, gallery tile,
  // findings-fact chip) EXPANDS the sources cap and forces the card past
  // the list's filter, then scrolls the target source card into view
  // inside the rail's own scroll and flashes it -- the cap and the filter
  // must never eat a citation
  const [locate, setLocate] = useState<{ n: number; seq: number } | null>(null);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [findingsExpanded, setFindingsExpanded] = useState(false);
  const [gapsExpanded, setGapsExpanded] = useState(false);
  const locateSeq = useRef(0);
  /** the attached image being viewed fullscreen (index into run.attachments) */
  const [viewAttachment, setViewAttachment] = useState<number | null>(null);
  /** the attached DOCUMENT being previewed (index into run.attachments) */
  const [viewFile, setViewFile] = useState<number | null>(null);
  // the exit-presence window: a dismissal plays the preview's fade-out
  // instead of snapping it out of the DOM (the lightbox contract)
  const { render: previewMounted, closing: previewClosing } = useExitPresence(viewFile !== null, 160);
  /** the rendered answer document (the 🖨 print action's clone source) */
  const answerBodyRef = useRef<HTMLDivElement | null>(null);
  // THE RUN PAGE SPEAKS GLOBAL: the rail's #n source cards sit right
  // beside the answer document, so body chips render the run's registry
  // numbers 1:1 -- an IDENTITY map over the known sources (phantom [n]s
  // stay unlinked verbatim; a chip's number IS the rail card's number).
  // The document-local [1..N] first-citation renumbering stays with the
  // SELF-CONTAINED surfaces (knowledge inspector, markdown exports).
  const citationMap = useMemo(() => {
    const knownNs = new Set(sourceMeta.map((source) => source.n).filter((n): n is number => Number.isInteger(n)));
    // possibly EMPTY == the old undefined: citeToLinks renders the same
    // verbatim global chips, citedSourceRows just yields no rows
    const map = new Map<number, number>();
    for (const n of [...knownNs].sort((a, b) => a - b)) {
      map.set(n, n);
    }
    return map;
  }, [sourceMeta]);
  const handleCite = (n: number) => {
    // a cited [n] this run never gathered (a past-research recall, a
    // previous run's numbering) has no rail card -- the page-level
    // handler takes it (opens the recalled page)
    if (!run.sources.some((source) => source.n === n)) {
      onCite?.(n);
      return;
    }
    locateSeq.current += 1;
    setLocate({ n, seq: locateSeq.current });
    // ONLY the sources list opens -- its [n] cards are the locate target.
    // The findings and gaps caps used to open with it: both sit ABOVE the
    // sources in the rail, so their reveal shifted the very card the scroll
    // was measured against (and a plan chip unfolding twenty facts reads as
    // a glitch); their own chips stay the only way to open them
    setSourcesExpanded(true);
  };
  useEffect(() => {
    if (!locate) {
      return;
    }
    // setTimeout, not rAF: the expansion must mount the card first, and a
    // jammed/starved compositor (occluded tab, in-app webview) never fires
    // rAF -- a timer always does (clamped, but it fires).  The scroll goes
    // through the rail's own scrollTop; the page scroll is the fallback.
    const timer = window.setTimeout(() => {
      const root = document.getElementById(`ai-run-${run.runNo}`);
      const card = root?.querySelector<HTMLElement>(`[data-ai-n="${locate.n}"]`);
      const rail = root?.querySelector("aside");
      if (!card) {
        return;
      }
      const flash = () => {
        card.removeAttribute("data-ai-flash");
        void card.offsetWidth;
        card.setAttribute("data-ai-flash", "");
        window.setTimeout(() => card.removeAttribute("data-ai-flash"), 1900);
      };
      if (rail && rail.scrollHeight > rail.clientHeight) {
        const railRect = rail.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const target = rail.scrollTop + (cardRect.top - railRect.top - railRect.height / 2 + cardRect.height / 2);
        animateScroll(rail, { top: target });
        flash();
        return;
      }
      scrollIntoViewAnimated(card, "center");
      flash();
    }, 60);
    return () => {
      window.clearTimeout(timer);
    };
  }, [locate, run.runNo]);
  const streaming = run.status === "streaming" && live;
  // a re-run reuses this section: drop the manual fold so the new think
  // follows the auto behaviour again (the OverviewCard reset pattern)
  useEffect(() => {
    if (streaming) {
      setWriteThinkForced(null);
    }
  }, [streaming]);
  // the sources the ANSWER actually cites wear the same dashed frame the
  // AI Overview draws on the classic page (data-ai-cited in base.css)
  const citedSet = useMemo(() => new Set(citedSourceNumbers(run.answer)), [run.answer]);
  const totalCalls = run.steps.reduce((sum, step) => sum + (step.kind === "calls" ? step.calls.length : 0), 0);
  // the round counter (round N): the executed steps' count -- while a
  // round streams, its calls step already exists, so N names the round
  // in flight
  const roundCount = run.steps.filter((step) => step.kind === "calls").length;
  // the process timeline is the record of how the report was made: OPEN
  // through the research phase, FOLDED the moment the writer takes over
  // (the phase(write) flip -- the answer/report becomes the focus, the
  // record is one click away) -- an explicit user toggle always wins
  const researchOpen =
    researchForced ??
    ((streaming && run.answer === "" && run.stage !== "write" && !run.direct) ||
      (run.status === "awaiting" && run.ask !== null));
  // the WRITE phase's reasoning: with the research box folded, the writer's
  // think stream would flow into an invisible pane and the run reads as
  // frozen ("nothing is moving").  Keyed on the write turn's OPEN, not
  // the phase event: the wire can deliver either first, and the
  // direct/wrap paths skip the phase spine entirely.  The writer's thinks
  // are every think step AFTER the last research calls step (a round is
  // think→calls; what follows the final settle is the write turn's --
  // reports may reopen entries per section, so the steps JOIN).
  // writeThinkFrom is that boundary: everything at/after it is the write
  // turn's material.  Gated on the write turn's OPEN (wrappingUp): a
  // research round's own think streams BEFORE its calls step lands and
  // must stay inside the process record.
  const writeThinkFrom = (() => {
    if (!run.wrappingUp) {
      return run.steps.length;
    }
    let lastCalls = -1;
    run.steps.forEach((step, index) => {
      if (step.kind === "calls") {
        lastCalls = index;
      }
    });
    return lastCalls + 1;
  })();
  const writeThinkText = run.steps
    .slice(writeThinkFrom)
    .filter((step) => step.kind === "think")
    .map((step) => step.text)
    .join("\n\n");
  // the process record renders the RESEARCH turns only: the write turn's
  // think steps live in the standalone thinking toggle below (the
  // machine-voice content never folds back into the research-process
  // record) -- left in, an expanded process box shows the SAME text
  // twice, once per surface.
  const researchSteps = run.steps.filter((step, index) => !(index >= writeThinkFrom && step.kind === "think"));
  // expanded while the think streams, folded once the answer starts
  // arriving, re-openable after the settle (the toggle never leaves).
  // The outline shapes show it only SETTLED: while a report/deck writes,
  // the document itself is the progress surface and an expanded think
  // pane above it would fight it for the column.
  const writeThinkVisible = run.wrappingUp && writeThinkText.trim() !== "" && (!run.outline || !streaming);
  const writeThinkOpen = writeThinkForced ?? (streaming && !run.answer);
  // a settled run without an answer is a FAILURE the user must see (the
  // writer can degrade to an empty/fence-only stream after a full
  // research phase -- silent nothing reads as a hung page), EXCEPT when
  // the user's own stop button cut the run
  const failed = run.status === "error" || (run.status === "done" && !run.stopped && !run.answer.trim());
  const awaiting = run.status === "awaiting" && run.ask !== null;

  // the run's research-mode chip: the composer's depth choice, always
  // visible on the run (the phase strip shows WHERE, this shows HOW deep)
  // the mode chip's icon + label: the depth dropdown's own vocabulary
  const ModeGlyph =
    run.mode === "speed" ? Zap : run.mode === "balanced" ? Gauge : run.mode === "overview" ? Sparkles : Telescope;
  const modeLabel = t(
    run.mode === "speed"
      ? "mode_speed"
      : run.mode === "balanced"
        ? "mode_balanced"
        : run.mode === "overview"
          ? "mode_overview"
          : "mode_deep",
  );
  // this run's follow-up suggestions, rendered TWICE by breakpoint: inside
  // the column at lg -- its height extends the rail's sticky constraint
  // (a block hanging after the row would push the pinned rail up through
  // the page's last viewport, see the last-run column runway) -- and after
  // the row below lg, keeping the stacked order answer → actions → sources
  // → related unchanged
  const relatedBlock =
    run.related.length > 0 ? (
      <section aria-label={t("related")}>
        <div className="flex items-center gap-2">
          <Repeat2 aria-hidden="true" className="size-4.5 text-ink-3" />
          <h3 className="text-base font-semibold text-ink">{t("related")}</h3>
        </div>
        <div className="mt-1">
          {run.related.map((question, i) => (
            <div key={i}>
              <div className="h-px bg-line" />
              <button
                className="group flex w-full items-center justify-between gap-3 py-2.5 text-left"
                onClick={() => {
                  onRelated?.(question);
                }}
                type="button"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <CornerDownRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-ink-3 transition-colors group-hover:text-accent"
                  />
                  <span className="text-sm leading-relaxed text-ink-2 transition-colors group-hover:text-accent">
                    {question}
                  </span>
                </span>
              </button>
            </div>
          ))}
        </div>
      </section>
    ) : null;
  return (
    <section
      aria-busy={streaming}
      aria-label={run.q}
      className={`animate-fade-up space-y-5 ${isFirst ? "" : "border-t border-line pt-8"}`}
      id={`ai-run-${run.runNo}`}
    >
      <div className="group/run flex items-start justify-between gap-3">
        {/* the question heading -- text-3xl, the takeover page's run title
            tier (ResultsPage h1 + the boot ghost mirror it at 3xl) -- with
            the run's RESEARCH MODE beside it (the composer's depth choice:
            speed/balanced/deep; a report/deck birth reads as its deep
            tier) so the current mode is always visible on the run.
            ClampReveal caps it at three lines: a pasted multi-KB brief
            must not wall the whole page behind its own title. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <div className="min-w-0 flex-1">
            <ClampReveal
              buttonClassName="-ms-1 mt-1 inline-flex min-h-6 items-center gap-1 px-2 text-xs text-ink-3 transition-colors hover:text-ink"
              previewPx={RUN_TITLE_PREVIEW_PX}
              scrimClassName="from-bg"
            >
              <h2
                className="break-words font-medium leading-tight text-ink text-3xl"
                dangerouslySetInnerHTML={{ __html: inlineMdHtml(run.q) }}
                dir="auto"
              />
            </ClampReveal>
          </div>
          {run.mode ? (
            <span
              className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-ink-3"
              title={t(
                run.mode === "speed"
                  ? "mode_speed_desc"
                  : run.mode === "balanced"
                    ? "mode_balanced_desc"
                    : "mode_deep_desc",
              )}
            >
              <ModeGlyph aria-hidden="true" className="size-3" />
              {modeLabel}
            </span>
          ) : null}
        </div>
        {/* the ROOT run anchors the thread (every later run is its
            sub-topic) -- it is not deletable; killing the whole thread is
            the knowledge directory's delete */}
        {onDeleteRun && !streaming && !isFirst ? <RunDeleteButton onConfirm={() => onDeleteRun(run.runNo)} /> : null}
      </div>

      {/* the run's macro-stage spine: the RUN's own line under the title --
          it covers write/verify which live outside the research box, so it
          must not read as part of the collapsible */}
      <PhaseStrip
        stage={run.stage}
        state={
          run.status === "streaming"
            ? "streaming"
            : run.status === "awaiting"
              ? "awaiting"
              : run.stopped
                ? "stopped"
                : failed
                  ? "error"
                  : "done"
        }
      />

      {/* the clarify modal floats OVER the page -- PORTALed to the body:
          the run section's animate-fade-up leaves a residual transform and
          a fixed child of a transformed ancestor positions (and clips)
          against THAT box, not the viewport.  FULL dialog contract: the
          run blocks on these questions, so focus moves in and is trapped
          (useDialogFocus), Escape means skip, the scrim fades (never
          pops). */}
      {viewAttachment !== null && run.attachments?.some((attachment) => attachment.kind === "image")
        ? createPortal(
            <AttachmentLightbox
              initialIndex={Math.max(
                0,
                run.attachments.slice(0, viewAttachment).filter((attachment) => attachment.kind === "image").length,
              )}
              items={run.attachments
                .filter((attachment) => attachment.kind === "image")
                .map((attachment) => ({
                  alt: attachment.name ?? t("attach_files"),
                  kind: "img" as const,
                  src: attachment.data ?? "",
                }))}
              onClose={() => setViewAttachment(null)}
            />,
            document.body,
          )
        : null}
      {previewMounted && viewFile !== null && run.attachments?.[viewFile]
        ? createPortal(
            <AttachmentPreview
              attachment={run.attachments[viewFile]}
              closing={previewClosing}
              onClose={() => setViewFile(null)}
            />,
            document.body,
          )
        : null}

      <ClarifyGate ask={run.ask} onSubmit={onSubmitClarify} open={awaiting && run.ask !== null} />

      {/* answer + sources: TWO-COLUMN from lg (Perplexity's shape) --
              the prose keeps its reading measure on the left, the run's
              source cards become a sticky rail on the right; below lg
              everything stacks: answer, related, actions, sources.  The
              answer carries no header row -- the prose is the anchor; one
              compact line covers the writer's silent start.  On lg the
              related block renders as the COLUMN's tail (inside this row,
              see relatedBlock): its height extends the rail's sticky
              constraint instead of hanging after the row. */}
      <div className="relative lg:flex lg:items-start lg:justify-between lg:gap-8">
        {/* the LAST run's column carries the page's bottom clearance as
            its own padding: a sticky element can never leave its
            containing block (this row's content box -- PADDING on the row
            itself does not count), so at the page's end the rail rides up
            through the last viewport unless the row's content box reaches
            the document's tail.  The padding is the follow-up composer's
            clearance AND the landing zone the footer overlap (the pages'
            lg:mb-[-3.5rem] on main) tucks into -- together they hold the
            pinned rail to the very bottom instead of dragging it up by
            main's old pb-44 + footer height.  Earlier runs stay tight:
            their rails hand off at the conversation boundary. */}
        <div className={`min-w-0 flex-1 space-y-5 lg:max-w-3xl ${isLast ? "lg:pb-44" : ""}`}>
          {/* research: think stream + intent + parallel tool calls */}
          <section aria-busy={streaming} aria-label={t("ai_search_process")}>
            <div className="flex flex-wrap items-center gap-2">
              <Waypoints
                aria-hidden="true"
                className={`size-5 shrink-0 ${streaming ? "animate-pulse text-ink-2" : "text-ink-3"}`}
              />
              <button
                aria-expanded={researchOpen}
                className="inline-flex min-h-6 items-center gap-1.5 text-xl font-medium text-ink transition-colors hover:text-ink-2"
                onClick={() => {
                  setResearchForced(!researchOpen);
                }}
                type="button"
              >
                {t("ai_search_process")}
                <ChevronDown
                  aria-hidden="true"
                  className={`size-4 transition-transform ${researchOpen ? "rotate-180" : ""}`}
                />
              </button>
              {/* the research shape at a glance (morphic/Vane carry a step
                  count in the collapsed label too) */}
              {totalCalls > 0 ? (
                <span className="shrink-0 text-xs text-ink-3">
                  {t("ai_search_calls_count", { n: String(totalCalls) })}
                </span>
              ) : null}
              <ElapsedTimer endedAt={run.endedAt} startedAt={run.startedAt} />
              {streaming && roundCount > 0 ? (
                <span className="shrink-0 text-xs tabular-nums text-ink-3">
                  {t("ai_phase_round", { n: String(roundCount) })}
                </span>
              ) : null}
              {streaming ? (
                <>
                  {onWrap ? (
                    <button
                      aria-label={t("ai_wrap_up")}
                      className={`${CHIP_BTN} shrink-0`}
                      onClick={onWrap}
                      title={t("ai_wrap_up")}
                      type="button"
                    >
                      <ListEnd className="size-3.5" />
                    </button>
                  ) : null}
                  <button
                    aria-label={t("stop")}
                    className={`${CHIP_BTN} shrink-0`}
                    onClick={onStop}
                    title={t("stop")}
                    type="button"
                  >
                    <CircleStop className="size-3.5" />
                  </button>
                </>
              ) : null}
            </div>
            {/* the macro-stage spine: visible even when the timeline folds --
            this is the orientation element for a ~10-minute deep run */}
            <Collapse className={researchOpen ? "mt-3" : ""} open={researchOpen}>
              <div className="break-words rounded-lg border border-line p-3">
                {researchSteps.map((step, index) => (
                  <StepSegment
                    index={index}
                    isLast={index === researchSteps.length - 1}
                    key={`${step.kind}-${index}`}
                    run={run}
                    step={step}
                    streaming={streaming}
                  />
                ))}
                {streaming && !researchSteps.length ? (
                  <p className="px-1 py-1 text-xs text-ink-3">{t("ai_search_thinking_plan")}</p>
                ) : null}
              </div>
            </Collapse>
          </section>
          {/* the writer's reasoning: the OverviewCard toggle language --
              a header row that stays above the answer/document for the
              run's whole life (expanded live while the think streams,
              folded once the answer takes over, re-openable after the
              settle -- the machine-voice content never folds back into
              the research-process record).  Report/deck runs surface it at the
              document's top once SETTLED; while they write, the document
              is the progress surface. */}
          {writeThinkVisible ? (
            <div className="zjs-print-hide mt-2">
              <button
                aria-expanded={writeThinkOpen}
                className={`${META_TOGGLE} text-xs`}
                onClick={() => {
                  setWriteThinkForced(!writeThinkOpen);
                }}
                type="button"
              >
                <Brain aria-hidden="true" className="size-3 shrink-0" />
                {t("ai_thinking")}
                <ChevronDown
                  aria-hidden="true"
                  className={`size-3.5 transition-transform ${writeThinkOpen ? "rotate-180" : ""}`}
                />
              </button>
              <Collapse className={writeThinkOpen ? "mt-1" : ""} open={writeThinkOpen}>
                <ThinkScroll active={streaming && !run.answer} text={writeThinkText} />
              </Collapse>
            </div>
          ) : null}
          {/* THE one write-turn progress line: the silence cover from the
              write-open (or a direct run's start) until the first answer
              delta -- the think block above only exists once think text
              streams, and the streaming answer itself is the progress
              after.  The budget wrap-up (the wrap-up directive took the
              tools away and the complete answer is being rewritten,
              partial prose discarded) rides the same line -- wrappingUp
              is set either way.  The REPORT shape renders no line: its
              progress surface is the document itself (the TOC's
              per-section spinners and the N/M counter); a spinner here
              would read as a stalled run. */}
          {streaming && !run.answer && (run.wrappingUp || run.direct) && !run.outline ? (
            <p className="flex items-center gap-1.5 text-xs text-ink-3">
              <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin" />
              {t("ai_answer_writing")}
            </p>
          ) : null}

          {/* synthesis */}

          {/* zjs-answer-body: PrintView's strip keeps the citation chips
              (buttons) that live inside it — they are report content */}
          {run.answer ? (
            // the CONTENT tier: the family editorial voice (DESIGN.md §5.1)
            // -- serif at the long-form scale (§4, the fluid .prose root:
            // 16px @320 → 17px desktop cap), the blog prose rhythm
            <div className="zjs-answer-body zjs-prose text-ink" ref={answerBodyRef}>
              {run.outline && run.deck && run.sections && Object.keys(run.sections).length > 0 ? (
                <DeckView
                  meta={sourceMeta}
                  onCite={handleCite}
                  outline={run.outline}
                  sections={run.sections ?? {}}
                  settled={!streaming}
                />
              ) : run.outline && run.sections && Object.keys(run.sections).length > 0 ? (
                <DocumentView
                  meta={sourceMeta}
                  onCite={handleCite}
                  run={{
                    galleries: run.galleries,
                    outline: run.outline,
                    runNo: run.runNo,
                    sections: run.sections,
                    sectionThink: run.sectionThink,
                  }}
                  settled={!streaming}
                  stamp={run.endedAt}
                />
              ) : (
                <MarkdownAnswer
                  figureLightbox
                  galleries={run.galleries}
                  markdown={citeToLinks(holdBackTail(run.answer, !streaming), citationMap)}
                  meta={citedSourceRows(citationMap, sourceMeta)}
                  onCite={(local) => {
                    // the identity map: a chip's number IS the rail card's
                    handleCite(local);
                  }}
                  settled={!streaming}
                />
              )}
            </div>
          ) : null}
          {!streaming && isLast && run.answer ? (
            <div className="flex items-center gap-1">
              {/* [retry | copy | print] -- twin ghost circles + the paper
                  action: the fill is HOVER feedback only (a persistent disc
                  reads as a selected state).  The 🖨 print rides HERE too
                  now (the same printDocument pipeline the knowledge
                  inspector uses) -- the report is a deliverable and the
                  user asked for paper at the surface that produced it. */}
              <button
                aria-label={t("regenerate")}
                className={CHIP_BTN}
                onClick={onRegenerate}
                title={t("regenerate")}
                type="button"
              >
                <RefreshCw className="size-3.5" />
              </button>
              <button
                aria-label={t("copy")}
                className={CHIP_BTN}
                onClick={() => {
                  // THE COPY IS THE SELF-CONTAINED EXPORT: the raw stored
                  // answer carries the run's global registry numbers --
                  // exactly the litter the export exists to strip.  The
                  // builders renumber the body [1..N] in first-citation
                  // order and append the matching source tail (the same
                  // document the knowledge page exports).
                  const exportSources = run.sources
                    .filter((source) => Number.isInteger(source.n))
                    .map((source) => ({ n: source.n as number, title: source.title || source.url, url: source.url }));
                  const md = run.outline
                    ? buildReportMarkdown(
                        {
                          title: run.outline.title,
                          subtitle: run.outline.subtitle,
                          sections: run.outline.sections.map((section) => ({
                            title: section.title,
                            text: run.sections?.[section.id] ?? "",
                          })),
                          sources: exportSources,
                        },
                        { sources: t("knowledge_inspector_sources") },
                      )
                    : buildAnswerMarkdown(run.q.slice(0, 120), run.answer, exportSources, {
                        sources: t("knowledge_inspector_sources"),
                      });
                  copyToast(md);
                }}
                title={t("copy")}
                type="button"
              >
                <Copy className="size-3.5" />
              </button>
              <button
                aria-label={t("print")}
                className={CHIP_BTN}
                onClick={() => {
                  const el = answerBodyRef.current;
                  if (!el) {
                    return;
                  }
                  // THE PAPER IS SELF-CONTAINED: the screen's chips speak
                  // global (the rail matches), but the paper renumbers its
                  // body to [1..N] in first-citation order and the tail
                  // follows the SAME document-local map -- [1] up top is
                  // exactly the tail's first row.  The rewrite runs on the
                  // CLONE (the live screen keeps its global chips).
                  const texts = run.outline
                    ? run.outline.sections.map((section) => run.sections?.[section.id] ?? "").filter(Boolean)
                    : [run.answer];
                  const knownNs = new Set(
                    sourceMeta.map((source) => source.n).filter((n): n is number => Number.isInteger(n)),
                  );
                  const printMap = buildCitationMap(texts, knownNs.size > 0 ? knownNs : undefined);
                  const clone = el.cloneNode(true) as HTMLElement;
                  applyLocalCiteNumbers(clone, printMap);
                  printDocument({
                    // a report carries its own H1 (the injected heading
                    // would print it twice); a single-write answer takes
                    // the question as its title line
                    heading: run.outline ? null : run.q.slice(0, 120),
                    hint: t("print_hint_webview"),
                    closeLabel: t("print_close"),
                    sources: citedSourceRows(printMap, run.sources).map((source) => ({
                      n: source.local,
                      title: source.title || source.url,
                      netloc: source.netloc,
                    })),
                    sourcesLabel: t("knowledge_inspector_sources"),
                    source: clone,
                    title: run.outline?.title || run.q,
                  });
                }}
                title={t("print")}
                type="button"
              >
                <Printer className="size-3.5" />
              </button>
            </div>
          ) : null}
          {/* the run's meta line at the END of the output (lobehub's
              message footer): model + tokens + transport outcome */}
          {!streaming && !failed ? (
            <AiRunFooter
              finish={run.finish ?? null}
              haltReason={run.haltReason ?? null}
              model={run.model ?? null}
              usage={run.usage ?? null}
            />
          ) : null}
          {/* a USER-STOPPED run keeps its checkpoint (the user may reverse
              the stop) but wears NO red failed box -- the quiet continue
              pill IS the reversal entry point; without it the checkpoint
              was unreachable from the UI.  THE SAME PILL covers the
              writer-died-without-output case: a run that gathered real
              material but produced NO answer has no [retry|copy|print]
              footer (those require an answer) and no failed box (it did
              not fail) -- "regenerate with the writer" resumes the stored
              conversation straight into the write (the research survives,
              only the writing re-runs). */}
          {!streaming && !failed && !run.answer.trim() && totalCalls > 0 && isLast && onContinue ? (
            <div className="mt-1">
              <button className={CHIP_ACCENT} onClick={onContinue} type="button">
                {run.stopped ? (
                  <Play aria-hidden="true" className="size-3.5" />
                ) : (
                  <PenLine aria-hidden="true" className="size-3.5" />
                )}
                {run.stopped ? t("ai_continue_research") : t("ai_regen_write")}
              </button>
            </div>
          ) : null}

          {/* the failed box acts on THE LAST run only (continue/regenerate
              target core.runs[end] -- on an earlier run they were a
              misleading silent no-op; a mid-thread failure is history) */}
          {failed && isLast ? (
            // the failure notice on the family paper ground (DESIGN.md §7):
            // a torn note pinned by two tape corners, the actions riding it
            <div className="relative -rotate-[0.35deg]">
              <Tape className="w-20 bg-accent-soft/80" corner="start" seed={`failed-${run.runNo}-a`} />
              <Tape className="w-16 bg-accent-soft/60" corner="end" seed={`failed-${run.runNo}-b`} />
              <div className="paper-note px-4 py-3 text-xs text-danger">
                <p className="font-medium">{t("ai_search_failed")}</p>
                {run.error ? (
                  <p className="mt-1 break-words text-danger/80" dir="auto">
                    {haltText(run.error, t)}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {/* an INTERRUPTED research keeps its ledger: continue resumes
                      THE SAME RUN in place -- the stored conversation replays
                      as the request's context, numbering and findings stay,
                      the researcher continues the open ledger items (the
                      primary action whenever this run actually gathered
                      material) */}
                  {onContinue && !run.answer.trim() && totalCalls > 0 ? (
                    <button className={CHIP_ACCENT} onClick={onContinue} type="button">
                      <Play aria-hidden="true" className="size-3.5" />
                      {t("ai_continue_research")}
                    </button>
                  ) : null}
                  {/* a transient failure (gateway hiccup, rate limit, a
                      wrong model id that has since been fixed) is worth one
                      click to re-run -- the retry re-asks the SAME question
                      as a fresh run */}
                  <button
                    className={`${CHIP_OUTLINE} ${onContinue && !run.answer.trim() && totalCalls > 0 ? CHIP_OUTLINE_IDLE : CHIP_OUTLINE_ACTIVE}`}
                    onClick={onRegenerate}
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" className="size-3.5" />
                    {t("regenerate")}
                  </button>
                  {onFallback ? (
                    <button className={`${CHIP_OUTLINE} ${CHIP_OUTLINE_IDLE}`} onClick={onFallback} type="button">
                      <LayoutGrid aria-hidden="true" className="size-3.5" />
                      {t("ai_search_try_classic")}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
          {relatedBlock ? <div className="hidden lg:block">{relatedBlock}</div> : null}
        </div>

        {/* this run's own source cards -- the evidence behind the
            answer; the sticky right rail from lg, stacked below it on
            narrow screens (the run hides the slot entirely when it can
            never get content: a settled no-source run) */}
        {run.sources.length > 0 || streaming ? (
          <aside className="mt-5 w-full lg:sticky lg:top-14 lg:mt-0 lg:flex lg:h-[calc(100vh-3.5rem)] lg:w-80 lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:overscroll-contain lg:pb-10 lg:pe-0.5 xl:w-96">
            {/* FIXED-HEIGHT SCROLLER, not a max-h: flex children never
                shrink below their content, so a capped aside only clips
                its paint -- the bottom sat unreachable under the floating
                follow-up box.  The rail owns THE scroll; every section is
                an ordinary block (cap-4 each), and the pb-44 keeps the
                last card reachable above the follow-up box. */}
            {(() => {
              const mirror: AiSearchRun["browser"] =
                run.browser ?? Object.values(run.browserSessions ?? {}).find((item) => item.img) ?? null;
              return mirror ? <BrowserMirrorSection sessions={run.browserSessions} view={mirror} /> : null;
            })()}
            {/* the output-structure card lives through EVERY run's whole
                life now (all three tiers can flip the deliverable -- the
                model's set_deliverable and the reader's pick share one
                write-boundary lane), and the structure is FIXED once the
                writer takes over: before that the card is the run-time
                pick (the write boundary is the last chance to re-mint --
                research streaming and the clarify wait alike); from the
                write boundary on it is read-only -- the outline landed
                (the active structure's identity face + status rows) or
                the single-write fallback runs without one (the shape
                identity alone).  EVERY settled record keeps the card: a
                shaped run wears its report/deck identity, a plain run
                wears the direct-answer face -- the structure section is
                the run's format record, never a hole. */}
            {(() => {
              const shapeSignal = run.mode === "report" || run.mode === "deck";
              const live = streaming || run.status === "awaiting";
              if (run.outline) {
                return <ActiveStructureCard deck={run.deck === true} outline={run.outline} />;
              }
              if (live && run.stage !== "write" && onSetTemplate) {
                return (
                  <OutputStructureCard
                    onClearTemplate={() => onClearTemplate?.() ?? Promise.resolve(false)}
                    onPick={onSetTemplate}
                    onSetShape={onSetShape}
                    shape={run.mode === "report" || run.mode === "deck" ? run.mode : null}
                  />
                );
              }
              return <StructureIdentityCard deck={run.mode === "deck"} direct={!shapeSignal} />;
            })()}
            {run.attachments?.length ? (
              <section aria-label={t("ai_attach_section")} className="mb-5">
                <RailHeader count={run.attachments.length} icon={Paperclip} title={t("ai_attach_section")} />
                <div className="mt-3 flex flex-wrap gap-2">
                  {run.attachments.map((attachment, index) =>
                    attachment.kind === "file" ? (
                      <button
                        className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-accent"
                        key={index}
                        onClick={() => {
                          setViewFile(index);
                        }}
                        title={t("ai_attach_preview")}
                        type="button"
                      >
                        {attachment.name}
                        {attachment.bytes ? (
                          <span className="font-mono text-ink-3">
                            {attachment.bytes < 1024
                              ? `${attachment.bytes}B`
                              : `${Math.max(1, Math.round(attachment.bytes / 1024))}K`}
                          </span>
                        ) : null}
                      </button>
                    ) : (
                      <button
                        aria-label={attachment.name ?? t("attach_files")}
                        className="group relative block cursor-zoom-in overflow-hidden rounded-lg border border-line"
                        key={index}
                        onClick={() => {
                          setViewAttachment(index);
                        }}
                        type="button"
                      >
                        <AttachmentThumb attachment={attachment} />
                      </button>
                    ),
                  )}
                </div>
              </section>
            ) : null}
            {run.clarify !== undefined ? <AskArchiveCard clarify={run.clarify} /> : null}
            <DecisionsCard decisions={run.decisions ?? []} />
            {run.plan.length > 0 ? (
              <TaskCard live={run.status === "streaming"} onCiteN={handleCite} plan={run.plan} />
            ) : null}
            {(run.findings ?? []).length > 0 ? (
              <FindingsCard
                expanded={findingsExpanded}
                findings={run.findings ?? []}
                onCiteN={handleCite}
                onToggleExpanded={setFindingsExpanded}
              />
            ) : null}
            {(run.gaps ?? []).length > 0 ? (
              <GapsCard
                expanded={gapsExpanded}
                gaps={run.gaps ?? []}
                onCiteN={handleCite}
                onFollowup={onGapsFollowup}
                onToggleExpanded={setGapsExpanded}
              />
            ) : null}
            {run.sources.length > 0 ? (
              <AiSearchSources
                cited={citedSet}
                expanded={sourcesExpanded}
                locateN={locate?.n ?? null}
                onFilter={() => {
                  setLocate(null);
                }}
                onToggleExpanded={setSourcesExpanded}
                sources={run.sources}
              />
            ) : (
              // the aside only mounts with sources or a live stream, so the
              // only face here is the streaming skeleton (a settled
              // no-source run hides the slot entirely)
              <AiSearchSourcesSkeleton />
            )}
          </aside>
        ) : null}

        {/* the MOBILE face of the related block (the lg copy rides the
            column above): the stacked order still reads answer → actions
            → sources → related */}
        {relatedBlock ? <div className="lg:hidden">{relatedBlock}</div> : null}
      </div>
    </section>
  );
}

/**
 * Memoized against the NDJSON stream: every chunk rebuilds the runs array,
 * but only the LAST run object is recreated — settled sections keep their
 * `run`/`sourceMeta` identity and skip re-render (a settled section's
 * markdown would otherwise re-parse on every live chunk).  The callback
 * props are event handlers only, so they are deliberately excluded from
 * the comparison.
 */
/** The attachment strip's image thumb (per-item state): dead bytes swap
    to the mime glyph -- the strip's own empty shape, honest at 64px. */
function AttachmentThumb({ attachment }: { attachment: { data?: string; mime: string; name?: string } }) {
  const [failed, markFailed] = useImgFallback(attachment.data);
  return failed ? (
    <span className="grid h-16 w-16 place-items-center bg-surface-2/50 text-xs text-ink-3">
      {attachment.mime.replace("image/", "")}
    </span>
  ) : (
    <img alt={attachment.name ?? ""} className="h-16 w-16 object-cover" onError={markFailed} src={attachment.data} />
  );
}

export const AiSearchRunSection = memo(
  AiSearchRunSectionImpl,
  (prev, next) =>
    prev.run === next.run &&
    prev.sourceMeta === next.sourceMeta &&
    prev.isFirst === next.isFirst &&
    prev.isLast === next.isLast &&
    prev.live === next.live,
);
