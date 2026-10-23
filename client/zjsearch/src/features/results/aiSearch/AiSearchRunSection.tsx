// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  CircleStop,
  Compass,
  Copy,
  CornerDownRight,
  FoldVertical,
  Lightbulb,
  ListEnd,
  ListTodo,
  ListTree,
  LoaderCircle,
  MessageCircleQuestion,
  NotebookPen,
  Paperclip,
  PenLine,
  Play,
  Printer,
  RefreshCw,
  Repeat2,
  Trash2,
  Waypoints,
  X,
  Zap,
} from "lucide-react";
import { memo, type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CAP_CHIP_CLASS, CapChip } from "@/components/CapChip.tsx";
import { Collapse } from "@/components/Collapse.tsx";
import { Tape } from "@/components/Tape.tsx";
import { AiRunFooter } from "@/features/results/AiRunFooter.tsx";
import { MarkdownAnswer, ThinkScroll } from "@/features/results/AiSummary.tsx";
import type { AiSourceMeta } from "@/features/results/aiOverview.ts";
import { AiSearchSources, AiSearchSourcesSkeleton } from "@/features/results/aiSearch/AiSearchSources.tsx";
import { Lightbox as AttachmentLightbox } from "@/features/results/aiSearch/AttachmentLightbox.tsx";
import { AttachmentPreview } from "@/features/results/aiSearch/AttachmentPreview.tsx";
import { BrowserMirrorSection } from "@/features/results/aiSearch/BrowserMirror.tsx";
import { ToolRow } from "@/features/results/aiSearch/calls/ToolRow.tsx";
import { DecisionsCard } from "@/features/results/aiSearch/DecisionsCard.tsx";
import { DeckView } from "@/features/results/aiSearch/deck/DeckView.tsx";
import { haltText } from "@/features/results/aiSearch/halts.ts";
import { type LedgerFact, type LedgerGap, parseClarifyPairs } from "@/features/results/aiSearch/ledger.ts";
import { PhaseStrip } from "@/features/results/aiSearch/PhaseStrip.tsx";
import { RailHeader } from "@/features/results/aiSearch/rail/RailSection.tsx";
import { DocumentView } from "@/features/results/aiSearch/report/DocumentView.tsx";
import {
  type ReportTemplate,
  TEMPLATE_SHAPE_ICONS,
  type TemplateShape,
  templatePresets,
} from "@/features/results/aiSearch/reportTemplates.ts";
import type { AiSearchOutline } from "@/features/results/aiSearch/timeline.ts";
import type {
  AiAskQuestion,
  AiSearchCall,
  AiSearchRun,
  AiSearchSource,
  AiSearchStep,
} from "@/features/results/aiSearch/useAiSearch.ts";
import { Snippet } from "@/features/results/cardParts.tsx";
import {
  applyLocalCiteNumbers,
  buildCitationMap,
  citedSourceNumbers,
  citedSourceRows,
  citeToLinks,
} from "@/lib/citations.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { buildAnswerMarkdown, buildReportMarkdown } from "@/lib/exporters.ts";
import { formatDuration } from "@/lib/format.ts";
import { themeLocaleTag, useLocale, useT } from "@/lib/i18n.ts";
import { listTemplates } from "@/lib/kb/templates.ts";
import { holdBackTail } from "@/lib/markdownParts.ts";
import { animateScroll, scrollIntoViewAnimated } from "@/lib/motion.ts";
import { escapeHtml, printDocument } from "@/lib/print.ts";
import { CHIP, CHIP_BTN, META_TOGGLE, PAPER_STRIP } from "@/lib/styles.ts";
import { flashToast } from "@/lib/toast.ts";

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
    the search-shaped row). */
function CallRow({
  call,
  results,
  allSources,
}: {
  call: AiSearchCall;
  results: AiSearchSource[];
  allSources: AiSearchSource[];
}) {
  // a re-search whose hits were all already-numbered emits no new
  // sources -- the call's dupes ARE its results (their existing [n]s)
  const dupes = (call.dupes ?? [])
    .map((n) => allSources.find((source) => source.n === n))
    .filter((source): source is AiSearchSource => Boolean(source));
  const merged = [...results, ...dupes.filter((dup) => !results.some((result) => result.n === dup.n))];
  return <ToolRow call={call} results={merged} />;
}

/** The living task list (the update_plan tool maintains it): a STATUS-ONLY
    card -- one colored mark per state (pending dot, active ping, done
    check, uncovered warning), a done/total counter in the header.  How
    each subtask was researched is the research process timeline's job;
    this card never expands. */
function TaskCard({ plan, live }: { plan: AiSearchRun["plan"]; live: boolean }) {
  const t = useT();
  if (plan.length === 0) {
    return null;
  }
  const done = plan.filter((task) => task.status === "done").length;
  return (
    <div className="mb-5">
      <RailHeader count={`${done}/${plan.length}`} icon={ListTodo} title={t("ai_task_card")} />
      <ul className="mt-3 space-y-1.5">
        {plan.map((task, index) => (
          <TaskItem key={`${index}-${task.title}`} live={live} task={task} />
        ))}
      </ul>
    </div>
  );
}

/** The BELIEF LEDGER card (Findings): active facts carry the accent dot,
    superseded facts stay visible (retired, struck) and retracted ones
    drop their claim (struck, warning) -- the revision history IS the
    honesty.  Each fact renders through the SAME measured clamp+expand as
    a source card's snippet, with inline [n] marks as accent chip buttons
    that locate the source in the rail.  The list reads NEWEST-FIRST and
    caps at four entries (one chip unfolds both the facts and the gaps
    partition); open gaps render under the facts: an OPEN gap is a
    colored dot (an owed question, not an achievement), a closed one
    settles as a check + its answer. */
function factHtml(text: string): string {
  return escapeHtml(text).replace(/\[(\d{1,3})\]/g, (_mark, n: string) => {
    const num = Number(n);
    if (!(num > 0)) {
      return `[${n}]`;
    }
    return (
      `<button type="button" data-cite-n="${num}" title="Source [${num}]"` +
      ` class="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-accent-soft px-1 align-baseline text-xs font-medium leading-4 text-accent transition-colors hover:text-accent-hover">[${num}]</button>`
    );
  });
}

/** One fact's meta tail: a retracted/superseded fact's status label, an
    active fact's CONFLICT FLAG as a warning chip with visible text (the
    old icon-only badge hid its meaning behind a hover tooltip), then the
    fact's concept tags (the findings tool's tags field) — one wrapping
    meta row at the 12px chip tier, identical in both list partitions. */
function FactMeta({ fact }: { fact: LedgerFact }) {
  const t = useT();
  const conflict = fact.status === "active" && fact.conflict_with != null;
  return (
    <>
      {fact.status !== "active" ? (
        <span className="ms-1.5 whitespace-nowrap text-xs text-ink-3">
          {fact.status === "retracted" ? t("ai_finding_retracted") : t("ai_finding_superseded")}
        </span>
      ) : null}
      {conflict || fact.tags?.length ? (
        <span className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink-3">
          {conflict ? (
            <span className={`${CHIP} bg-warning/10 font-medium text-warning`}>
              <Zap aria-hidden="true" className="size-3" />
              {t("ai_finding_conflict")}
            </span>
          ) : null}
          {fact.tags?.map((tag) => (
            <span className={CHIP} key={tag}>
              {tag}
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}

/** One gap's snippet html: the question, and a CLOSED gap's settlement as
    a muted tail -- both with the same [n] chip rendering as a fact. */
function gapHtml(gap: LedgerGap): string {
  const tail =
    gap.status === "closed" && gap.close_as ? ` <span class="text-ink-3">${factHtml(gap.close_as)}</span>` : "";
  return factHtml(gap.q) + tail;
}

/** The [n]-chip click delegation shared by every ledger row (the chips
    live INSIDE the snippet html, so the wrapper catches them). */
function citeHandlers(onCiteN: (n: number) => void) {
  const locate = (event: { target: EventTarget | null }) => {
    const chip = (event.target as HTMLElement).closest("[data-cite-n]");
    if (chip) {
      onCiteN(Number(chip.getAttribute("data-cite-n")));
    }
  };
  return {
    onClick: locate,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter") {
        locate(event);
      }
    },
  };
}

/** The BELIEF LEDGER card (Findings): what the sources ESTABLISHED --
    active facts carry the accent dot, superseded stay struck, retracted
    ones drop their claim; each fact renders through the SAME measured
    clamp-and-reveal with inline [n] chip buttons, NEWEST-FIRST, capped
    at four. */
function FindingsCard({
  findings,
  expanded,
  onToggleExpanded,
  onCiteN,
}: {
  findings: LedgerFact[];
  /** CONTROLLED cap state (a [n] click expands it; the chip may fold) */
  expanded: boolean;
  onToggleExpanded: (next: boolean) => void;
  onCiteN: (n: number) => void;
}) {
  const t = useT();
  if (findings.length === 0) {
    return null;
  }
  const active = findings.filter((fact) => fact.status === "active");
  const factsHidden = Math.max(0, findings.length - 4);
  // the newest four lead; the OLDER tail sits inside a Collapse so the
  // +N reveal (and the collapse) plays as a height animation
  const factView = [...findings.slice(-4)].reverse();
  const factExtra = [...findings.slice(0, Math.max(0, findings.length - 4))].reverse();
  return (
    <div className="mb-5">
      <RailHeader count={active.length} icon={NotebookPen} title={t("ai_findings_card")} />
      <ul className="mt-3 space-y-1.5">
        {factView.map((fact) => (
          <li className="flex items-start gap-2" key={fact.id}>
            {fact.status === "active" ? (
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent/70" />
            ) : fact.status === "retracted" ? (
              <CircleAlert aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-warning" />
            ) : (
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-3/40" />
            )}
            <div className="min-w-0 flex-1">
              <div {...citeHandlers(onCiteN)}>
                <Snippet
                  className={fact.status === "active" ? "" : "text-ink-3 line-through decoration-ink-3/60"}
                  contentHtml={factHtml(fact.text)}
                  textClass="text-[13px] leading-relaxed text-ink-2"
                />
              </div>
              <FactMeta fact={fact} />
            </div>
          </li>
        ))}
      </ul>
      <Collapse className={expanded && factExtra.length > 0 ? "mt-1.5" : ""} open={expanded && factExtra.length > 0}>
        <ul className="space-y-1.5">
          {factExtra.map((fact) => (
            <li className="flex items-start gap-2" key={fact.id}>
              {fact.status === "active" ? (
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent/70" />
              ) : fact.status === "retracted" ? (
                <CircleAlert aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-warning" />
              ) : (
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-3/40" />
              )}
              <div className="min-w-0 flex-1">
                <div {...citeHandlers(onCiteN)}>
                  <Snippet
                    className={fact.status === "active" ? "" : "text-ink-3 line-through decoration-ink-3/60"}
                    contentHtml={factHtml(fact.text)}
                    textClass="text-[13px] leading-relaxed text-ink-2"
                  />
                </div>
                <FactMeta fact={fact} />
              </div>
            </li>
          ))}
        </ul>
      </Collapse>
      <CapChip
        className={CAP_CHIP_CLASS}
        expanded={expanded}
        hidden={factsHidden}
        onToggle={() => {
          onToggleExpanded(!expanded);
        }}
      />
    </div>
  );
}

/** The OPEN QUESTIONS card (open gaps): the ledger's gap partition as its
    own section beside the findings -- an open gap is a colored dot (an
    owed question, not an achievement), a closed one settles as a check
    with its answer as a muted tail.  The SAME row machinery as a fact:
    [n] chip buttons + the measured clamp-and-reveal, newest first,
    capped at four; the header counts the CARD'S rows (the per-row dot /
    check already tells open from settled). */
function GapsCard({
  gaps,
  expanded,
  onToggleExpanded,
  onCiteN,
  onFollowup,
}: {
  gaps: LedgerGap[];
  expanded: boolean;
  onToggleExpanded: (next: boolean) => void;
  onCiteN: (n: number) => void;
  /** the gap-driven follow-up: launch a research run on the open gaps
      (the host composes the message; absent on surfaces without a
      composer) */
  onFollowup?: (gaps: { q: string }[]) => void;
}) {
  const t = useT();
  if (gaps.length === 0) {
    return null;
  }
  const openGaps = gaps.filter((gap) => gap.status === "open" && gap.q);
  const gapsHidden = Math.max(0, gaps.length - 4);
  const gapView = [...gaps.slice(-4)].reverse();
  const gapExtra = [...gaps.slice(0, Math.max(0, gaps.length - 4))].reverse();
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <RailHeader count={gaps.length} icon={CircleHelp} title={t("ai_findings_gaps")} />
        </div>
        {onFollowup && openGaps.length > 0 ? (
          <button
            className={`shrink-0 rounded-full border border-accent-strong/40 bg-accent-soft px-2.5 py-1 text-[13px] font-medium text-accent transition-colors hover:text-accent-hover`}
            onClick={() => {
              onFollowup(openGaps.slice(-5).map((gap) => ({ q: gap.q })));
            }}
            title={t("ai_gaps_followup")}
            type="button"
          >
            {t("ai_gaps_followup")}
          </button>
        ) : null}
      </div>
      <ul className="mt-3 space-y-1.5">
        {gapView.map((gap) => (
          <li className="flex items-start gap-2" key={gap.id}>
            {gap.status === "open" ? (
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
            ) : (
              <Check aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-ok" />
            )}
            <div className="min-w-0 flex-1" {...citeHandlers(onCiteN)}>
              <Snippet
                contentHtml={gapHtml(gap)}
                textClass={`text-[13px] leading-relaxed ${gap.status === "open" ? "text-ink" : "text-ink-3"}`}
              />
            </div>
          </li>
        ))}
      </ul>
      <Collapse className={expanded && gapExtra.length > 0 ? "mt-1.5" : ""} open={expanded && gapExtra.length > 0}>
        <ul className="space-y-1.5">
          {gapExtra.map((gap) => (
            <li className="flex items-start gap-2" key={gap.id}>
              {gap.status === "open" ? (
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
              ) : (
                <Check aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-ok" />
              )}
              <div className="min-w-0 flex-1" {...citeHandlers(onCiteN)}>
                <Snippet
                  contentHtml={gapHtml(gap)}
                  textClass={`text-[13px] leading-relaxed ${gap.status === "open" ? "text-ink" : "text-ink-3"}`}
                />
              </div>
            </li>
          ))}
        </ul>
      </Collapse>
      <CapChip
        className={CAP_CHIP_CLASS}
        expanded={expanded}
        hidden={gapsHidden}
        onToggle={() => {
          onToggleExpanded(!expanded);
        }}
      />
    </div>
  );
}

/** One task row: the colored status mark + the subtask title (+ its source
    count once covered).  Not interactive -- the process lives in the
    research timeline. */
function TaskItem({ task, live }: { task: AiSearchRun["plan"][number]; live: boolean }) {
  const t = useT();
  return (
    <li>
      <div className="flex items-start gap-2 text-[13px]">
        <span className="sr-only">
          {t(
            task.status === "done"
              ? "ai_task_status_done"
              : task.status === "active"
                ? "ai_task_status_active"
                : task.status === "missed"
                  ? "ai_task_status_missed"
                  : "ai_task_status_pending",
          )}
        </span>
        <span className="relative mt-0.5 flex size-3 shrink-0 items-center justify-center">
          {task.status === "done" ? (
            <Check aria-hidden="true" className="size-3 text-ok" />
          ) : task.status === "active" ? (
            <>
              {/* the ping animates ONLY while the run streams: a settled
                  run's never-finished subtask must not leave a permanent
                  animation on the page (the occluded-webview jam feeder) */}
              {live ? (
                <span aria-hidden="true" className="absolute size-3 animate-ping rounded-full bg-accent/40" />
              ) : null}
              <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
            </>
          ) : task.status === "missed" ? (
            <CircleAlert aria-hidden="true" className="size-3 text-warning" />
          ) : (
            <span aria-hidden="true" className="size-1.5 rounded-full bg-ink-3/50" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <Snippet
            contentHtml={escapeHtml(task.title)}
            textClass={`text-[13px] leading-relaxed ${task.status === "done" ? "text-ink-3" : "text-ink"}`}
          />
          {task.status === "missed" ? (
            <span className="whitespace-nowrap text-xs text-warning">{t("ai_task_missed")}</span>
          ) : null}
        </div>
        {task.status === "done" && (task.sources?.length ?? 0) > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-ink-3">
            {t((task.sources?.length ?? 0) === 1 ? "ai_task_source_one" : "ai_task_sources", {
              n: String(task.sources?.length ?? 0),
            })}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** One collapsible reasoning segment: the header carries the Brain icon,
    the label and the segment's streaming duration; the raw think stream
    stays inside.  Open while THIS segment is the one streaming (unless
    the user toggled), folded once later steps take over. */
function ThinkSegment({
  step,
  open,
  live,
}: {
  step: Extract<AiSearchStep, { kind: "think" }>;
  open: boolean;
  /** true while this segment's think stream is still growing */
  live: boolean;
}) {
  const t = useT();
  const [forced, setForced] = useState<boolean | null>(null);
  const expanded = forced ?? open;
  return (
    <div>
      <button
        aria-expanded={expanded}
        className={`${META_TOGGLE} text-xs`}
        onClick={() => {
          setForced(!expanded);
        }}
        type="button"
      >
        <Brain aria-hidden="true" className="size-3 shrink-0" />
        {t("ai_thinking")}
        <ChevronDown aria-hidden="true" className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      <Collapse className={expanded ? "mt-1" : ""} open={expanded}>
        <ThinkScroll active={live && expanded} text={step.text} />
      </Collapse>
    </div>
  );
}

/** The SUBAGENT row: folded to ONE line (title + live meta), the
    mini-timeline (the delegation header + the child's own think/call
    stream) opens on click -- the read-row fold doctrine, one level
    deeper.  The expanded pane sits on the machine-voice ground; the
    digest arrives as the delegation call's own tool result beside it. */
function SubSegment({
  index,
  run,
  step,
  streaming,
}: {
  index: number;
  run: AiSearchRun;
  step: Extract<AiSearchStep, { kind: "sub" }>;
  streaming: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const live = streaming && step.status === "active";
  const okCalls = step.inner.reduce(
    (acc, inner) => acc + (inner.kind === "calls" ? inner.calls.filter((call) => call.status === "ok").length : 0),
    0,
  );
  return (
    <div className={index > 0 ? "mt-2" : ""}>
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-start transition-colors hover:bg-surface-2/50"
        onClick={() => {
          setOpen(!open);
        }}
        type="button"
      >
        {live ? (
          <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-accent" />
        ) : (
          <span className="grid size-3.5 shrink-0 place-items-center">
            <Check aria-hidden="true" className="size-3 text-ok" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-2" dir="auto">
          {step.title || step.objective.slice(0, 48)}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-ink-3">
          {live ? t("ai_sub_running") : t("ai_sub_done", { n: String(okCalls) })}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`size-3.5 shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <Collapse className={open ? "mt-1" : ""} open={open}>
        <div className="ms-4 rounded-lg border border-line/70 bg-surface-2/30 p-2">
          {step.objective ? (
            <p className="px-1 pb-1 text-xs leading-relaxed text-ink-3" dir="auto">
              <span className="font-medium text-ink-2">{t("ai_sub_brief")}:</span> {step.objective}
            </p>
          ) : null}
          {step.inner.map((inner, innerIdx) => (
            <StepSegment index={innerIdx} key={`${inner.kind}-${innerIdx}`} run={run} step={inner} streaming={live} />
          ))}
          {!step.inner.length ? <p className="px-1 py-1 text-xs text-ink-3">{t("ai_search_thinking_plan")}</p> : null}
        </div>
      </Collapse>
    </div>
  );
}

function StepSegment({
  index,
  run,
  step,
  streaming,
}: {
  index: number;
  run: AiSearchRun;
  step: AiSearchStep;
  streaming: boolean;
}) {
  const t = useT();
  if (step.kind === "think") {
    return (
      <div className={index > 0 ? "mt-2" : ""}>
        <ThinkSegment
          live={streaming && index === run.steps.length - 1}
          // ONLY the LIVE segment opens by default (the reasoning you are
          // watching); every other segment -- earlier rounds AND the whole
          // run once settled -- stays folded behind its one-click toggle
          // (a dozen open think panes read as a wall of machine voice)
          open={streaming && index === run.steps.length - 1}
          step={step}
        />
      </div>
    );
  }
  if (step.kind === "clarify") {
    // the confirmed direction OPENS the process record: the questions the
    // clarify gate asked and the answers that steered the research --
    // parsed from the same "1. Question<sep>Answer" lines the rail segment
    // shows (how this report's direction was decided)
    return (
      <div className={`flex items-start gap-1.5 px-1 ${index > 0 ? "mt-1.5" : ""}`}>
        <Compass aria-hidden="true" className="mt-1 size-3 shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1 py-0.5">
          <p className="text-[13px] font-medium text-ink-2">{t("ai_clarify_summary")}</p>
          <ul className="mt-0.5 space-y-0.5">
            {step.pairs.map((pair, pi) => (
              <li className="text-xs leading-relaxed text-ink-2" dir="auto" key={pi}>
                <span className="text-ink-3">
                  {pair.q}
                  {t("ai_clarify_pair_sep")}
                </span>
                {pair.a}
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  if (step.kind === "steer") {
    // the user's live course correction: a quote line in the record (WHERE
    // the run changed direction and why); a discarded steer (the write
    // phase had closed the guide lane) reads dimmed with the undelivered mark
    return (
      <div className={`flex items-start gap-1.5 px-1 ${index > 0 ? "mt-1.5" : ""}`}>
        <Compass
          aria-hidden="true"
          className={`mt-1 size-3 shrink-0 ${step.status === "discarded" ? "text-ink-3/50" : "text-accent"}`}
        />
        <p
          className={`py-0.5 text-[13px] leading-relaxed ${
            step.status === "discarded" ? "text-ink-3 line-through decoration-ink-3/40" : "font-medium text-ink-2"
          }`}
          dir="auto"
        >
          {step.text}
          {step.status === "discarded" ? (
            <span className="ms-1.5 text-xs text-ink-3 no-underline">{t("ai_steer_undelivered")}</span>
          ) : null}
        </p>
      </div>
    );
  }
  if (step.kind === "compact") {
    // the compaction separator: the moment the research context shed its
    // weight (micro: old page bodies cleared; auto/reactive: summarized
    // + state re-injected) -- one dim line, not a step
    const label =
      step.trigger === "micro"
        ? t("ai_compact_micro_line", { pre: String(step.pre), post: String(step.post) })
        : t("ai_compact_line", {
            pre: String(step.pre),
            post: String(step.post),
            rounds: String(step.summarized),
          });
    return (
      <div className={`flex items-center gap-1.5 px-1 ${index > 0 ? "mt-1.5" : ""}`}>
        <FoldVertical aria-hidden="true" className="size-3 shrink-0 text-ink-3" />
        <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-line/60" />
        <p className="py-0.5 text-xs text-ink-3" dir="auto">
          {label}
        </p>
      </div>
    );
  }
  if (step.kind === "sub") {
    return <SubSegment index={index} run={run} step={step} streaming={streaming} />;
  }
  if (step.kind === "intent") {
    return (
      <div className={`flex items-start gap-1.5 px-1 ${index > 0 ? "mt-1.5" : ""}`}>
        <Lightbulb aria-hidden="true" className="mt-1 size-3 shrink-0 text-ink-3" />
        <p className="py-0.5 text-[13px] leading-relaxed text-ink-2" dir="auto">
          {step.text}
        </p>
      </div>
    );
  }
  return (
    <div className={`flex flex-col gap-0.5 ${index > 0 ? "mt-1.5" : ""}`}>
      {step.calls.map((call) => (
        <CallRow
          allSources={run.sources}
          call={call}
          key={`${step.round}-${call.id}`}
          results={run.sources.filter((source) => source.round === step.round && source.callId === call.id)}
        />
      ))}
    </div>
  );
}

/** Live research duration ("researched X s" while running, "researched X s"
    settled): ticks once a second off the run's own clock -- the honest
    substitute for the removed time budgets (the stop button is the
    control, the elapsed time is the visibility). */
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
function AskCard({
  ask,
  onSubmit,
}: {
  ask: { intro: string; questions: AiAskQuestion[] };
  onSubmit: (text: string | null) => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [note, setNote] = useState("");
  // the run BLOCKS on this card: full modal semantics -- focus moves to
  // the card on mount (tabIndex -1), Tab is trapped, focus returns to the
  // page on answer; Escape is handled by the portal wrapper (skip)
  const dialogRef = useDialogFocus<HTMLDivElement>();
  // Escape means skip: the run proceeds on the user's best interpretation
  const onCardKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      onSubmit(null);
    }
  };
  const toggle = (qi: number, option: string, type: "single" | "multi") => {
    setPicked((prev) => {
      const current = prev[qi] ?? [];
      const next =
        type === "single"
          ? current.includes(option)
            ? []
            : [option]
          : current.includes(option)
            ? current.filter((o) => o !== option)
            : [...current, option];
      return { ...prev, [qi]: next };
    });
  };
  const submit = () => {
    // the transcript travels to the model AND is replayed in the
    // ClarifySegment -- the punctuation comes from the catalog so an
    // English session reads as English (full-width marks in zh-CN)
    const join = t("ai_clarify_options_join");
    const lines = ask.questions.map((q, i) =>
      t("ai_clarify_answer_line", {
        n: String(i + 1),
        q: q.q,
        a: (picked[i] ?? []).join(join) || t("ai_clarify_none"),
      }),
    );
    if (note.trim()) {
      lines.push(t("ai_clarify_more_line", { label: t("ai_clarify_more"), text: note.trim() }));
    }
    // confirmed with NOTHING picked and nothing typed: the "answers" would
    // reach the model as a string of "—" placeholders -- degrade to the
    // skip path (research without a clarified direction) instead
    const hasInput = ask.questions.some((_, qi) => (picked[qi] ?? []).length > 0) || note.trim().length > 0;
    onSubmit(hasInput ? lines.join("\n") : null);
  };
  return (
    // The gate rides the family notice-paper ground (DESIGN.md §7): a BLANK
    // torn slip (no ruled lines — the question rows scroll, fixed lines
    // would drift under moving text) pinned by two tape corners, with the
    // deterministic micro-tilt of the PaperEmpty family.  The tapes are
    // SIBLINGS of the clipped note (§7 physics) and the dialog semantics
    // (role/ref/focus trap) stay on the note itself.
    <div className="relative w-full -rotate-[0.35deg]">
      <Tape className="w-24 bg-accent-soft/80" corner="start" seed="clarify-gate-a" />
      <Tape className="w-20 bg-accent-soft/60" corner="end" seed="clarify-gate-b" />
      <div
        aria-label={t("ai_clarify_title")}
        aria-modal="true"
        className="paper-note--blank flex max-h-full min-h-0 w-full flex-col overflow-hidden p-4"
        onKeyDown={onCardKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex shrink-0 items-center gap-2">
          <Compass aria-hidden="true" className="size-5 shrink-0 text-ink-3" />
          <h3 className="text-lg font-semibold text-ink">{t("ai_clarify_title")}</h3>
        </div>
        {ask.intro ? (
          <p className="mt-2 shrink-0 text-sm leading-relaxed text-ink-2" dir="auto">
            {ask.intro}
          </p>
        ) : null}
        <div className="mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto">
          {ask.questions.map((question, qi) => (
            <div key={qi}>
              <p className="text-[13px] font-medium text-ink" dir="auto">
                {question.q}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {question.options.map((option) => {
                  const on = (picked[qi] ?? []).includes(option);
                  return (
                    <button
                      aria-pressed={on}
                      className={`rounded-full border px-3 py-1.5 text-[13px] transition-colors ${
                        on
                          ? "border-accent-strong bg-accent-soft font-medium text-accent"
                          : "border-line text-ink-2 hover:text-ink"
                      }`}
                      key={option}
                      onClick={() => {
                        toggle(qi, option, question.type);
                      }}
                      type="button"
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <input
          aria-label={t("ai_clarify_more")}
          className="mt-3 h-9 w-full shrink-0 rounded-lg border border-line bg-transparent px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent"
          dir="auto"
          onChange={(event) => {
            setNote(event.target.value);
          }}
          placeholder={t("ai_clarify_more")}
          value={note}
        />
        <div className="mt-3 flex shrink-0 items-center justify-between gap-2">
          <button
            className="text-[13px] text-ink-3 transition-colors hover:text-ink hover:underline underline-offset-2"
            onClick={() => {
              onSubmit(null);
            }}
            type="button"
          >
            {t("ai_clarify_skip")}
          </button>
          <button
            className={`${PAPER_STRIP} -rotate-1 px-4 py-1.5 text-accent-contrast [--strip:var(--accent-strong)] hover:[--strip:var(--accent-strong-hover)]`}
            onClick={submit}
            type="button"
          >
            {t("ai_clarify_confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The clarify round-trip archive (confirmed direction): the confirmed direction
    (or the skip) the research below is built on.  The SAME section
    language as every rail card -- icon + title + count header, one
    settled row per answered question (check + answer + the question in
    muted) -- newest first, capped at four. */
function AskArchiveCard({ clarify }: { clarify: string }) {
  const t = useT();
  // the shared clarify grammar (ledger.parseClarifyPairs); a trailing
  // free-text note (no separator) parses as a label-less pair and renders
  // under its own label line
  const text = clarify.trim();
  if (!text) {
    return null;
  }
  const parsed = parseClarifyPairs(text);
  const items: Array<{ q: string; a: string }> = [...parsed];
  // the grammar's trailing label-less pair IS the free-text note
  const notePair = parsed.length > 0 ? parsed[parsed.length - 1] : undefined;
  if (notePair && notePair.q === "") {
    items.splice(items.length - 1, 1, { q: t("ai_clarify_more"), a: notePair.a });
  }
  const view = [...items].reverse().slice(0, 4);
  return (
    <section aria-label={t("ai_clarify_summary")} className="mb-5">
      <RailHeader count={items.length} icon={MessageCircleQuestion} title={t("ai_clarify_summary")} />
      {/* the confirmed direction pinned as a torn note (DESIGN.md §7): two
          tape corners as SIBLINGS of the clipped note (a child would be cut
          by the torn edge), the micro-tilt is fixed, never random */}
      <div className="relative mt-5 -rotate-[0.35deg]">
        <Tape className="w-16 bg-accent-soft/80" corner="start" seed={`${items[0]?.q ?? "archive"}-a`} />
        <Tape className="w-14 bg-accent-soft/60" corner="end" seed={`${items[0]?.q ?? "archive"}-b`} />
        <ul className="paper-note space-y-1.5 px-4 py-3">
          {view.map((item) => (
            <li className="flex items-start gap-2 text-[13px]" key={`${item.q}-${item.a}`}>
              <Check aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-ok" />
              <span className="min-w-0 flex-1 break-words">
                <span className="block text-ink-3" dir="auto">
                  {item.q}
                </span>
                <span className="block text-ink" dir="auto">
                  {item.a}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

type StructurePick =
  | { kind: "direct" }
  | { kind: "free"; shape: TemplateShape }
  | { kind: "template"; template: ReportTemplate };

/** The run header's delete control (hover-revealed trash; TWO-STEP like
    every destructive control here -- the first click arms a danger pill,
    the second (or the cancel) resolves it; a 4s idle disarms).  The
    storage surgery lives in deleteRunData -- this is the confirmation
    surface only. */
function RunDeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const t = useT();
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (!arming) {
      return;
    }
    const timer = window.setTimeout(() => {
      setArming(false);
    }, 4000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [arming]);
  if (arming) {
    return (
      <span className="flex shrink-0 items-center gap-1">
        <button
          className="inline-flex items-center gap-1 rounded-full bg-danger px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-danger/85"
          onClick={() => {
            setArming(false);
            onConfirm();
          }}
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
          {t("run_delete_confirm")}
        </button>
        <button
          aria-label={t("ai_delete_cancel")}
          className="grid size-7 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          onClick={() => {
            setArming(false);
          }}
          title={t("ai_delete_cancel")}
          type="button"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </span>
    );
  }
  return (
    <button
      aria-label={t("run_delete")}
      className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 transition-all hover:bg-surface-2 hover:text-danger focus-visible:opacity-100 group-hover/run:opacity-100"
      onClick={() => {
        setArming(true);
      }}
      title={t("run_delete")}
      type="button"
    >
      <Trash2 aria-hidden="true" className="size-3.5" />
    </button>
  );
}

/** The rail's output-structure control (RESEARCH phase only, every tier):
    the run-time pick rides run/control to the write boundary -- the
    write-boundary shape resolver re-mints or mints the outline from it
    before the first section streams.  ONE MERGED LIST: the two free
    options (smart report / smart deck, pinned top, each wearing its
    shape icon) lead, then every preset and user template -- report and
    deck side by side, the locked FileText|Presentation icons are the
    only shape signal (no category filter).  EVERYTHING IS TWO-STEP:
    clicking an option only PREVIEWS (the trigger + section rows mirror
    it, nothing is sent -- users clicking around to look must never fire
    a control); the explicit confirm-switch pill submits, and a pick
    whose shape differs from the run's also flips the output format (the
    server pairs the pending shape with a canonical steer notice, so the
    researcher's remaining rounds adapt).  Picking a free option
    withdraws a previously-picked template (run/control action=template
    without a payload).  THE DIRECT-ANSWER ROW is pinned first: the run's
    birth format and the face of a run that carries no shape yet -- the
    current format is always the highlighted selection, any other pick
    counts as a flip, and confirming the direct row takes the run BACK to
    a plain answer (the server withdraws every pending deliverable
    signal; a route-outline run rejects it -- the structure came with the
    request).  ``shape`` is the run's CURRENT shape -- null on a run that
    has none yet.  The model's own set_deliverable flip adopts the
    submitted face ONLY while the reader picked nothing.  The pick window
    closes when the WRITER takes over -- the outline lands (the card
    swaps to the active-structure view) or the write phase opens without
    one (the single-write fallback; both swap to the fixed identity). */
function OutputStructureCard({
  onPick,
  onClearTemplate,
  onSetShape,
  shape,
}: {
  onPick: (template: ReportTemplate) => Promise<boolean>;
  onClearTemplate: () => Promise<boolean>;
  onSetShape?: (shape: TemplateShape | null) => Promise<boolean>;
  shape: TemplateShape | null;
}) {
  const t = useT();
  const locale = useLocale();
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  // the SUBMITTED pick's id ("direct", free:<shape> or a template id) --
  // the direct answer is every run's birth format
  const [current, setCurrent] = useState(() => (shape ? `free:${shape}` : "direct"));
  // the reader's OWN direct submit happened ("direct" doubles as the
  // never-picked face, so the model's late flip must not overwrite it)
  const [directPicked, setDirectPicked] = useState(false);
  const [open, setOpen] = useState(false);
  // the PREVIEW pick (unconfirmed) and the submitted shape flip (drives
  // the submitted note -- only a shape flip steers the researcher)
  const [chosen, setChosen] = useState<StructurePick | null>(null);
  const [flipped, setFlipped] = useState<TemplateShape | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listTemplates().then((rows) => {
      if (!cancelled) {
        setTemplates(rows);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // the model's own set_deliverable flip folds run.mode -- adopt it as
  // the submitted face ONLY while the reader has picked nothing (an
  // explicit reader pick outranks the model's flip at the write boundary,
  // and the card must keep telling that truth)
  useEffect(() => {
    setCurrent((prev) => (prev === "direct" && !directPicked && shape ? `free:${shape}` : prev));
  }, [shape, directPicked]);
  const all: ReportTemplate[] = [...templatePresets(themeLocaleTag(locale)), ...templates];
  const options: Array<{
    id: string;
    label: string;
    sub: string;
    count: number;
    icon: LucideIcon;
  }> = [
    {
      id: "direct",
      label: t("ai_output_structure_direct"),
      sub: t("ai_output_structure_direct_sub"),
      count: 0,
      icon: Zap,
    },
    {
      id: "free:report",
      label: t("report_template_free"),
      sub: t("ai_output_structure_free"),
      count: 0,
      icon: TEMPLATE_SHAPE_ICONS.report,
    },
    {
      id: "free:deck",
      label: t("template_free_deck"),
      sub: t("template_deck_hint"),
      count: 0,
      icon: TEMPLATE_SHAPE_ICONS.deck,
    },
    ...all.map((template) => ({
      id: template.id,
      label: template.name,
      sub: template.sections.map((section) => section.title).join(" / "),
      count: template.sections.length,
      icon: TEMPLATE_SHAPE_ICONS[template.shape ?? "report"],
    })),
  ];
  const pickId = (pick: StructurePick): string =>
    pick.kind === "direct" ? "direct" : pick.kind === "free" ? `free:${pick.shape}` : pick.template.id;
  const pickOf = (id: string): StructurePick | null => {
    if (id === "direct") {
      return { kind: "direct" };
    }
    if (id.startsWith("free:")) {
      return { kind: "free", shape: id === "free:deck" ? "deck" : "report" };
    }
    const template = all.find((item) => item.id === id);
    return template ? { kind: "template", template } : null;
  };
  const submitted = pickOf(current);
  const shown = chosen ?? submitted;
  const shownOption = options.find((option) => option.id === (shown ? pickId(shown) : current));
  const effective: TemplateShape | null = flipped ?? shape;
  const previewing = chosen !== null && (!submitted || pickId(chosen) !== pickId(submitted));
  const confirm = () => {
    if (!chosen) {
      return;
    }
    const nextId = pickId(chosen);
    if (submitted && nextId === pickId(submitted)) {
      setChosen(null);
      return;
    }
    if (chosen.kind === "direct") {
      // the back-to-the-direct-answer pick: every pending deliverable
      // signal withdraws server-side (template + shape + the model's
      // minted flip).  A route-outline run rejects it (the structure came
      // with the request) -- the failed call reverts the face and says so.
      const prevId = current;
      const prevFlipped = flipped;
      setDirectPicked(true);
      setCurrent("direct");
      setFlipped(null);
      setChosen(null);
      setOpen(false);
      if (onSetShape) {
        void onSetShape(null).then((ok) => {
          if (!ok) {
            setCurrent(prevId);
            setFlipped(prevFlipped);
            flashToast(t("ai_deliverable_direct_locked"), { tone: "danger" });
          }
        });
      }
      return;
    }
    const shapeChanged =
      effective === null ||
      (chosen.kind === "free" ? chosen.shape !== effective : (chosen.template.shape ?? "report") !== effective);
    if (chosen.kind === "free") {
      // a free option withdraws any picked template (harmless no-op when
      // none was pending)
      void onClearTemplate();
    } else {
      void onPick(chosen.template);
    }
    if (shapeChanged && onSetShape) {
      setFlipped(chosen.kind === "free" ? chosen.shape : (chosen.template.shape ?? "report"));
      void onSetShape(chosen.kind === "free" ? chosen.shape : (chosen.template.shape ?? "report"));
    }
    setCurrent(nextId);
    setChosen(null);
    setOpen(false);
  };
  const choose = (id: string) => {
    // clicking the submitted option cancels the preview; anything else
    // only PREVIEWS -- the confirm pill is the one send button
    const pick = pickOf(id);
    setChosen(pick && (!submitted || pickId(pick) !== pickId(submitted)) ? pick : null);
    setOpen(false);
  };
  return (
    <section aria-label={t("ai_output_structure")} className="mb-5">
      <RailHeader icon={ListTree} title={t("ai_output_structure")} />
      <div className="relative mt-3">
        <button
          aria-expanded={open}
          aria-haspopup="listbox"
          className="flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-start transition-colors hover:bg-surface-2/40"
          onClick={() => {
            setOpen((value) => !value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          type="button"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-ink">
              <span className="me-1.5 inline-flex items-center align-[-3px] text-ink-3">
                {shownOption ? <shownOption.icon aria-hidden="true" className="size-3.5" /> : null}
              </span>
              {shownOption?.label}
            </span>
            <span className="mt-0.5 block truncate text-xs text-ink-3">{shownOption?.sub}</span>
          </span>
          {shownOption && shownOption.count > 0 ? (
            <span className="shrink-0 text-xs tabular-nums text-ink-3">
              {shownOption.count} {t("knowledge_tab_sections")}
            </span>
          ) : null}
          <ChevronDown
            aria-hidden="true"
            className={`size-3.5 shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {/* the ONE send button: visible while a preview is pending */}
        {previewing ? (
          <div className="mt-1.5 flex items-center gap-2">
            <button
              className="inline-flex items-center gap-1 rounded-full bg-accent-strong px-3 py-1.5 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
              onClick={confirm}
              type="button"
            >
              <Check aria-hidden="true" className="size-3.5" />
              {t("template_shape_confirm", { name: shownOption?.label ?? "" })}
            </button>
            <button
              className="rounded-full px-3 py-1.5 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
              onClick={() => {
                setChosen(null);
              }}
              type="button"
            >
              {t("ai_delete_cancel")}
            </button>
          </div>
        ) : flipped !== null && flipped !== shape ? (
          <p className="mt-1.5 text-xs text-ink-3">{t("template_shape_pending")}</p>
        ) : null}
        {!open && (chosen?.kind === "template" || (!chosen && submitted?.kind === "template")) ? (
          <ol className="mt-2 space-y-1 px-1">
            {(chosen?.kind === "template"
              ? chosen.template
              : submitted?.kind === "template"
                ? submitted.template
                : undefined
            )?.sections.map((section, index) => (
              <li className="flex items-start gap-2 text-[13px]" key={`${index}-${section.title}`}>
                <span className="w-3 shrink-0 pt-0.5 text-center font-mono text-xs tabular-nums text-ink-3">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 leading-relaxed text-ink">{section.title}</span>
                {section.optional ? (
                  <span className="shrink-0 text-xs text-ink-3">{t("template_optional_short")}</span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        {open ? (
          <div
            aria-label={t("ai_output_structure")}
            className="absolute inset-x-0 top-full z-20 mt-1.5 max-h-72 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-pop"
            role="listbox"
          >
            {options.map((option) => {
              const isSelected = option.id === (shown ? pickId(shown) : current);
              return (
                <button
                  aria-selected={isSelected}
                  className={`w-full rounded-md px-2.5 py-2 text-start transition-colors ${
                    isSelected ? "border border-accent-strong bg-accent-soft" : "hover:bg-surface-2/40"
                  }`}
                  key={option.id}
                  onClick={() => {
                    choose(option.id);
                  }}
                  role="option"
                  type="button"
                >
                  <span
                    className={`flex items-center justify-between gap-2 text-[13px] ${
                      isSelected ? "font-medium text-accent" : "text-ink"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 text-ink-3">
                        <option.icon aria-hidden="true" className="size-3.5" />
                      </span>
                      <span className="min-w-0 truncate">{option.label}</span>
                    </span>
                    {option.count > 0 ? (
                      <span className="shrink-0 text-xs font-normal tabular-nums text-ink-3">
                        {option.count} {t("knowledge_tab_sections")}
                      </span>
                    ) : null}
                  </span>
                  <span className={`mt-0.5 block truncate text-xs ${isSelected ? "text-accent/70" : "text-ink-3"}`}>
                    {option.sub}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The structure's FIXED identity face -- icon + what this run's output
    structure IS (the template's own name, the free smart-report/smart-deck
    shape, or the direct answer a plain run kept) with its one-line
    description.  Non-interactive by design: the pick lane is consumed
    ONCE at the write boundary, so a structure change past it is a new
    run, not a hidden control.  Shared by the active card (outline
    landed) and the no-outline record -- the card NEVER vanishes once the
    writer has taken over or the run settled. */
function StructureFace({ deck, direct, templateName }: { deck: boolean; direct?: boolean; templateName?: string }) {
  const t = useT();
  const Icon = direct ? Zap : deck ? TEMPLATE_SHAPE_ICONS.deck : TEMPLATE_SHAPE_ICONS.report;
  const label = direct
    ? t("ai_output_structure_direct")
    : (templateName ?? (deck ? t("template_free_deck") : t("report_template_free")));
  const sub = direct
    ? t("ai_output_structure_direct_sub")
    : templateName
      ? t("template_fixed_sub")
      : deck
        ? t("template_deck_hint")
        : t("ai_output_structure_free");
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2">
      <span className="shrink-0 text-ink-3">
        <Icon aria-hidden="true" className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{label}</span>
        <span className="mt-0.5 block truncate text-xs text-ink-3">{sub}</span>
      </span>
    </div>
  );
}

/** The rail's output-structure card AFTER the outline landed -- the run's ACTIVE
    structure: the fixed identity face (what it is) over the numbered
    rows (what it looks like), living through the write phase (per-
    section status marks) and the settled record alike.  READ-ONLY by
    design: the template pick lane is consumed ONCE at the write
    boundary, so a post-outline pick could only re-mint nothing -- a
    structure change past that point is a new run, not a hidden control.
    The one exception is a FAILED section's row: its rewrite chip is the
    repair affordance (the section re-streams through the run host's
    rewrite lane), not a structure change. */
function ActiveStructureCard({
  deck,
  outline,
  onRewrite,
  rewritingId,
}: {
  deck: boolean;
  outline: AiSearchOutline;
  onRewrite?: (sectionId: string) => void;
  rewritingId?: string | null;
}) {
  const t = useT();
  if (outline.sections.length === 0) {
    return null;
  }
  return (
    <section aria-label={t("ai_output_structure")} className="mb-5">
      <RailHeader count={outline.sections.length} icon={ListTree} title={t("ai_output_structure")} />
      <div className="mt-3">
        <StructureFace deck={deck} templateName={outline.template} />
      </div>
      <ol className="mt-2 space-y-1 px-1">
        {outline.sections.map((section, index) => {
          const busy = rewritingId === section.id;
          return (
            <li className="flex items-start gap-2 text-[13px]" key={section.id || index}>
              <span className="w-3 shrink-0 pt-0.5 text-center font-mono text-xs tabular-nums text-ink-3">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 leading-relaxed text-ink" dir="auto">
                {section.title}
              </span>
              <span className="grid w-3.5 shrink-0 place-items-center pt-0.5">
                {section.status === "done" ? (
                  <Check aria-hidden="true" className="size-3 text-ok" />
                ) : section.status === "writing" || busy ? (
                  <LoaderCircle aria-hidden="true" className="size-3 animate-spin text-accent" />
                ) : section.status === "failed" ? (
                  <AlertTriangle aria-hidden="true" className="size-3 text-warning" />
                ) : (
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-line" />
                )}
              </span>
              {section.status === "failed" && onRewrite ? (
                <button
                  aria-label={busy ? t("ai_section_rewriting") : t("ai_section_rewrite")}
                  className="-mt-0.5 -me-1 grid size-6 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-accent"
                  onClick={() => onRewrite(section.id)}
                  title={busy ? t("ai_section_rewriting") : t("ai_section_rewrite")}
                  type="button"
                >
                  {busy ? (
                    <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw aria-hidden="true" className="size-3" />
                  )}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The rail's output-structure card for a run WITHOUT a minted skeleton:
    a report/deck run whose writer answered WITHOUT one (the outline gate
    fell back to the single write), an interrupted research -- and the
    PLAIN run's own settled record (``direct``: the run kept its birth
    format, the face says so).  While the run still researches (or awaits
    clarify) the PICKER occupies this slot instead; the write phase swaps
    to this fixed face. */
function StructureIdentityCard({ deck, direct }: { deck: boolean; direct?: boolean }) {
  const t = useT();
  return (
    <section aria-label={t("ai_output_structure")} className="mb-5">
      <RailHeader icon={ListTree} title={t("ai_output_structure")} />
      <div className="mt-3">
        <StructureFace deck={deck} direct={direct} />
      </div>
    </section>
  );
}

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
  onRewriteSection,
  rewriting,
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
  /** ONE settled section's rewrite (the failed section's chip): the
      rewrite lane re-streams the section on the server and the tail
      folds in place.  Resolves the outcome -- the chips toast it. */
  onRewriteSection?: (runNo: number, sectionId: string) => Promise<"ok" | "busy" | "unknown" | "error">;
  /** the section a rewrite is currently streaming (the chips' spinner) */
  rewriting?: { runNo: number; sectionId: string } | null;
  /** Wrap-up: the run finishes its round and the writer answers from the
      material gathered (the graceful end beside the hard stop) */
  onWrap?: () => void;
  /** the awaiting run's clarify card was answered (null = skipped) */
  onSubmitClarify?: (text: string | null) => void;
}) {
  const t = useT();
  const copyToast = useCopyToast();
  const [researchForced, setResearchForced] = useState<boolean | null>(null);
  // the writer's reasoning toggle (the AiAnswerCard pattern): the think
  // block stays ABOVE the answer for the run's whole life -- expanded
  // while the think streams, folded once the answer takes over, still
  // re-openable after the settle (never folded back into the research
  // record); the manual override wins over the auto behaviour, and a
  // re-run drops it so the new think follows the auto pattern again
  const [writeThinkForced, setWriteThinkForced] = useState<boolean | null>(null);
  // the citation-locate flow: an [n] click (answer chip, gallery tile,
  // findings-fact chip) EXPANDS the rail's capped lists, then scrolls the
  // target source card into view inside the rail's own scroll and flashes
  // it -- the cap must never eat a citation
  const [locate, setLocate] = useState<{ n: number; seq: number } | null>(null);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [findingsExpanded, setFindingsExpanded] = useState(false);
  const [gapsExpanded, setGapsExpanded] = useState(false);
  const locateSeq = useRef(0);
  /** the attached image being viewed fullscreen (index into run.attachments) */
  const [viewAttachment, setViewAttachment] = useState<number | null>(null);
  /** the attached DOCUMENT being previewed (index into run.attachments) */
  const [viewFile, setViewFile] = useState<number | null>(null);
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
    setSourcesExpanded(true);
    setFindingsExpanded(true);
    setGapsExpanded(true);
  };
  // the failed section's rewrite chip: the lane streams the section back
  // and the fold updates the document in place; the OUTCOME toasts (the
  // "ok" case needs no toast -- the replacement prose is its own
  // feedback)
  const handleRewrite = (sectionId: string) => {
    onRewriteSection?.(run.runNo, sectionId).then((outcome) => {
      if (outcome === "busy") {
        flashToast(t("ai_section_rewrite_busy"), { tone: "accent" });
      } else if (outcome === "unknown") {
        flashToast(t("ai_section_rewrite_gone"), { tone: "danger" });
      } else if (outcome === "error") {
        flashToast(t("ai_section_rewrite_error"), { tone: "danger" });
      }
    });
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
  // follows the auto behaviour again (the AiAnswerCard reset pattern)
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

  return (
    <section
      aria-busy={streaming}
      aria-label={run.q}
      className={`animate-fade-up space-y-5 ${isFirst ? "" : "border-t border-line pt-8"}`}
      id={`ai-run-${run.runNo}`}
    >
      <div className="group/run flex items-start justify-between gap-3">
        {/* the question heading -- text-3xl, the takeover page's run title
            tier (ResultsPage h1 + the boot ghost mirror it at 3xl) */}
        <h2 className="break-words font-medium leading-tight text-ink text-3xl" dir="auto">
          {run.q}
        </h2>
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
      {viewFile !== null && run.attachments?.[viewFile]
        ? createPortal(
            <AttachmentPreview attachment={run.attachments[viewFile]} onClose={() => setViewFile(null)} />,
            document.body,
          )
        : null}

      {awaiting && run.ask
        ? createPortal(
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div aria-hidden="true" className="absolute inset-0 animate-fade-in bg-black/30" />
              <div className="relative z-10 flex max-h-full w-full max-w-lg animate-fade-up">
                <AskCard ask={run.ask} onSubmit={onSubmitClarify ?? (() => {})} />
              </div>
            </div>,
            document.body,
          )
        : null}

      {/* answer + sources: TWO-COLUMN from lg (Perplexity's shape) --
              the prose keeps its reading measure on the left, the run's
              source cards become a sticky rail on the right; below lg
              everything stacks: answer, related, actions, sources.  The
              answer carries no header row -- the prose is the anchor; one
              compact line covers the writer's silent start. */}
      <div className="relative lg:flex lg:items-start lg:justify-between lg:gap-8">
        <div className="min-w-0 flex-1 space-y-5 lg:max-w-3xl">
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
          {/* the writer's reasoning: the AiAnswerCard toggle language --
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
            // -- serif at the long-form scale (§4, the blog's .prose
            // 17px/1.8), the blog prose rhythm
            <div className="zjs-answer-body text-[17px] font-serif leading-[1.8] text-ink" ref={answerBodyRef}>
              {run.outline && run.deck ? (
                <DeckView
                  meta={sourceMeta}
                  onCite={handleCite}
                  outline={run.outline}
                  sections={run.sections ?? {}}
                  settled={!streaming}
                />
              ) : run.outline ? (
                <DocumentView
                  meta={sourceMeta}
                  onCite={handleCite}
                  onRewrite={
                    onRewriteSection && !streaming && (rewriting == null || rewriting.runNo === run.runNo)
                      ? handleRewrite
                      : undefined
                  }
                  rewritingId={rewriting?.runNo === run.runNo ? rewriting.sectionId : null}
                  run={{ galleries: run.galleries, outline: run.outline, sections: run.sections, runNo: run.runNo }}
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
              <button
                className="inline-flex items-center gap-1.5 rounded-full border border-accent-strong/40 bg-accent-soft px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:text-accent-hover"
                onClick={onContinue}
                type="button"
              >
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
                    <button
                      className="inline-flex items-center gap-1.5 rounded-full border border-accent-strong/40 bg-accent-soft px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:text-accent-hover"
                      onClick={onContinue}
                      type="button"
                    >
                      <Play aria-hidden="true" className="size-3.5" />
                      {t("ai_continue_research")}
                    </button>
                  ) : null}
                  {/* a transient failure (gateway hiccup, rate limit, a
                      wrong model id that has since been fixed) is worth one
                      click to re-run -- the retry re-asks the SAME question
                      as a fresh run */}
                  <button
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition-colors ${
                      onContinue && !run.answer.trim() && totalCalls > 0
                        ? "border border-line text-ink-2 hover:text-ink"
                        : "border border-accent-strong/40 bg-accent-soft font-medium text-accent hover:text-accent-hover"
                    }`}
                    onClick={onRegenerate}
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" className="size-3.5" />
                    {t("regenerate")}
                  </button>
                  {onFallback ? (
                    <button
                      className="inline-flex items-center rounded-full border border-line px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink"
                      onClick={onFallback}
                      type="button"
                    >
                      {t("ai_search_try_classic")}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
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
                return (
                  <ActiveStructureCard
                    deck={run.deck === true}
                    onRewrite={
                      onRewriteSection && !streaming && (rewriting == null || rewriting.runNo === run.runNo)
                        ? handleRewrite
                        : undefined
                    }
                    outline={run.outline}
                    rewritingId={rewriting?.runNo === run.runNo ? rewriting.sectionId : null}
                  />
                );
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
                        {attachment.data ? (
                          <img alt={attachment.name ?? ""} className="h-16 w-16 object-cover" src={attachment.data} />
                        ) : (
                          <span className="grid h-16 w-16 place-items-center bg-surface-2/50 text-xs text-ink-3">
                            {attachment.mime.replace("image/", "")}
                          </span>
                        )}
                      </button>
                    ),
                  )}
                </div>
              </section>
            ) : null}
            {run.clarify !== undefined ? <AskArchiveCard clarify={run.clarify} /> : null}
            <DecisionsCard decisions={run.decisions ?? []} />
            {run.plan.length > 0 ? <TaskCard live={run.status === "streaming"} plan={run.plan} /> : null}
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
                onToggleExpanded={setSourcesExpanded}
                sources={run.sources}
              />
            ) : (
              <AiSearchSourcesSkeleton />
            )}
          </aside>
        ) : null}
      </div>

      {/* this run's follow-up suggestions: AFTER the two-column wrapper
              so the stacked (mobile) order reads answer → actions → sources
              → related; on desktop the block keeps the answer's reading
              measure, exactly where it sat inside the left column */}
      {run.related.length > 0 ? (
        <section aria-label={t("related")} className="lg:max-w-3xl">
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
      ) : null}
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
export const AiSearchRunSection = memo(
  AiSearchRunSectionImpl,
  (prev, next) =>
    prev.run === next.run &&
    prev.sourceMeta === next.sourceMeta &&
    prev.isFirst === next.isFirst &&
    prev.isLast === next.isLast &&
    prev.live === next.live &&
    // the rewrite chips' spinner rides this prop (the object identity
    // flips null <-> {runNo, sectionId} on every rewrite start/end)
    prev.rewriting === next.rewriting,
);
