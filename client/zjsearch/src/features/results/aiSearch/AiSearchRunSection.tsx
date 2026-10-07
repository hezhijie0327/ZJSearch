// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  CircleStop,
  Compass,
  Copy,
  CornerDownRight,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  MessageCircleQuestion,
  NotebookPen,
  Play,
  RefreshCw,
  Repeat2,
  Waypoints,
  Zap,
} from "lucide-react";
import { memo, type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CapChip } from "@/components/CapChip.tsx";
import { Collapse } from "@/components/Collapse.tsx";
import { AiRunFooter } from "@/features/results/AiRunFooter.tsx";
import { MarkdownAnswer, ThinkScroll } from "@/features/results/AiSummary.tsx";
import type { AiSourceMeta } from "@/features/results/aiOverview.ts";
import { AiSearchSources, AiSearchSourcesSkeleton } from "@/features/results/aiSearch/AiSearchSources.tsx";
import { ToolRow } from "@/features/results/aiSearch/calls/ToolRow.tsx";
import { DecisionsCard } from "@/features/results/aiSearch/DecisionsCard.tsx";
import type { LedgerFact, LedgerGap } from "@/features/results/aiSearch/ledger.ts";
import { PhaseStrip } from "@/features/results/aiSearch/PhaseStrip.tsx";
import { RailHeader } from "@/features/results/aiSearch/rail/RailSection.tsx";
import { DocumentView } from "@/features/results/aiSearch/report/DocumentView.tsx";
import type {
  AiAskQuestion,
  AiSearchCall,
  AiSearchRun,
  AiSearchSource,
  AiSearchStep,
} from "@/features/results/aiSearch/useAiSearch.ts";
import { Snippet } from "@/features/results/cardParts.tsx";
import { citedSourceNumbers, citeToLinks } from "@/lib/citations.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { formatDuration } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { animateScroll, scrollIntoViewAnimated } from "@/lib/motion.ts";
import { escapeHtml } from "@/lib/print.ts";
import { CHIP_BTN, META_TOGGLE } from "@/lib/styles.ts";

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

/** The living task list (the task_write tool maintains it): a STATUS-ONLY
    card -- one colored mark per state (pending dot, active ping, done
    check, uncovered warning), a done/total counter in the header.  How
    each subtask was researched is the research process timeline's job;
    this card never expands. */
function TaskCard({ tasks }: { tasks: AiSearchRun["tasks"] }) {
  const t = useT();
  if (tasks.length === 0) {
    return null;
  }
  const done = tasks.filter((task) => task.status === "done").length;
  return (
    <div className="mb-5">
      <RailHeader count={`${done}/${tasks.length}`} icon={ListTodo} title={t("ai_task_card")} />
      <ul className="mt-3 space-y-1.5">
        {tasks.map((task, index) => (
          <TaskItem key={`${index}-${task.title}`} task={task} />
        ))}
      </ul>
    </div>
  );
}

/** The BELIEF LEDGER card (研究发现): active facts carry the accent dot,
    superseded facts stay visible (retired, struck) and retracted ones
    drop their claim (struck, warning) -- the revision history IS the
    honesty.  Each fact renders through the SAME measured clamp+expand as
    a source card's snippet, with inline [n] marks as accent chip buttons
    that locate the source in the rail.  The list reads NEWEST-FIRST and
    caps at four entries (one chip unfolds both the facts and the gaps
    partition); 未决缺口 renders under the facts: an OPEN gap is a
    colored dot (an owed question, not an achievement), a closed one
    settles as a check + its answer. */
function factHtml(text: string): string {
  return escapeHtml(text).replace(/\[(\d{1,3})\]/g, (_mark, n: string) => {
    const num = Number(n);
    if (!(num > 0)) {
      return `[${n}]`;
    }
    return (
      `<button type="button" data-cite-n="${num}" title="来源 [${num}]"` +
      ` class="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-accent-soft px-1 align-baseline text-[11px] font-medium leading-4 text-accent transition-colors hover:text-accent-hover">[${num}]</button>`
    );
  });
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

/** The BELIEF LEDGER card (研究发现): what the sources ESTABLISHED --
    active facts carry the accent dot, superseded stay struck, retracted
    ones drop their claim; each fact renders through the SAME measured
    clamp-and-reveal with inline [n] chip buttons, NEWEST-FIRST, capped
    at four. */
function FindingsCard({
  learnings,
  expanded,
  onToggleExpanded,
  onCiteN,
}: {
  learnings: LedgerFact[];
  /** CONTROLLED cap state (a [n] click expands it; the chip may fold) */
  expanded: boolean;
  onToggleExpanded: (next: boolean) => void;
  onCiteN: (n: number) => void;
}) {
  const t = useT();
  if (learnings.length === 0) {
    return null;
  }
  const active = learnings.filter((fact) => fact.status === "active");
  const factsHidden = Math.max(0, learnings.length - 4);
  // the newest four lead; the OLDER tail sits inside a Collapse so the
  // +N reveal (and the 收起) plays as a height animation
  const factView = [...learnings.slice(-4)].reverse();
  const factExtra = [...learnings.slice(0, Math.max(0, learnings.length - 4))].reverse();
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
              {fact.status !== "active" ? (
                <span className="ms-1.5 whitespace-nowrap text-[11px] text-ink-3">
                  {fact.status === "retracted" ? t("ai_finding_retracted") : t("ai_finding_superseded")}
                </span>
              ) : fact.conflict_with ? (
                <span
                  aria-label={t("ai_finding_conflict")}
                  className="ms-1.5 inline-flex size-4 items-center justify-center rounded-full bg-warning/15 text-warning"
                  role="img"
                  title={t("ai_finding_conflict")}
                >
                  <Zap aria-hidden="true" className="size-2.5" />
                </span>
              ) : null}
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
              </div>
            </li>
          ))}
        </ul>
      </Collapse>
      <CapChip
        className="mt-2 ms-1 inline-flex min-h-6 items-center gap-1 rounded-full border border-line px-2 text-[11px] text-ink-3 transition-colors hover:text-ink"
        expanded={expanded}
        hidden={factsHidden}
        onToggle={() => {
          onToggleExpanded(!expanded);
        }}
      />
    </div>
  );
}

/** The OPEN QUESTIONS card (未决缺口): the ledger's gap partition as its
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
}: {
  gaps: LedgerGap[];
  expanded: boolean;
  onToggleExpanded: (next: boolean) => void;
  onCiteN: (n: number) => void;
}) {
  const t = useT();
  if (gaps.length === 0) {
    return null;
  }
  const gapsHidden = Math.max(0, gaps.length - 4);
  const gapView = [...gaps.slice(-4)].reverse();
  const gapExtra = [...gaps.slice(0, Math.max(0, gaps.length - 4))].reverse();
  return (
    <div className="mb-5">
      <RailHeader count={gaps.length} icon={CircleHelp} title={t("ai_findings_gaps")} />
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
        className="mt-2 ms-1 inline-flex min-h-6 items-center gap-1 rounded-full border border-line px-2 text-[11px] text-ink-3 transition-colors hover:text-ink"
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
function TaskItem({ task }: { task: AiSearchRun["tasks"][number] }) {
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
              <span aria-hidden="true" className="absolute size-3 animate-ping rounded-full bg-accent/40" />
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
            <span className="whitespace-nowrap text-[11px] text-warning">{t("ai_task_missed")}</span>
          ) : null}
        </div>
        {task.status === "done" && (task.sources?.length ?? 0) > 0 ? (
          <span className="shrink-0 text-[11px] tabular-nums text-ink-3">
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
    // parsed from the same "1. Question：Answer" lines the rail segment
    // shows (how this report's direction was decided)
    return (
      <div className={`flex items-start gap-1.5 px-1 ${index > 0 ? "mt-1.5" : ""}`}>
        <Compass aria-hidden="true" className="mt-1 size-3 shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1 py-0.5">
          <p className="text-[13px] font-medium text-ink-2">{t("ai_clarify_summary")}</p>
          <ul className="mt-0.5 space-y-0.5">
            {step.pairs.map((pair, pi) => (
              <li className="text-xs leading-relaxed text-ink-2" dir="auto" key={pi}>
                <span className="text-ink-3">{pair.q}：</span>
                {pair.a}
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
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

/** Live research duration ("已调研 X 秒" while running, "已调研 X 秒"
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
    <div
      aria-label={t("ai_clarify_title")}
      aria-modal="true"
      className="flex max-h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface p-4"
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
          className="rounded-full bg-accent-strong px-4 py-1.5 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
          onClick={submit}
          type="button"
        >
          {t("ai_clarify_confirm")}
        </button>
      </div>
    </div>
  );
}

/** The clarify round-trip archive (已确认方向): the confirmed direction
    (or the skip) the research below is built on.  The SAME section
    language as every rail card -- icon + title + count header, one
    settled row per answered question (check + answer + the question in
    muted) -- newest first, capped at four. */
function AskArchiveCard({ clarify }: { clarify: string }) {
  const t = useT();
  // parse "1. Question：Answer" lines into confirmed-context pairs; the
  // trailing free-text note (no separator) rides as its own item
  const text = clarify.trim();
  const pairs: Array<{ q: string; a: string }> = [];
  let note = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^(?:\d+[.、]\s*)?(.+?)[：:]\s*(.+)$/.exec(trimmed);
    if (match?.[1] && match[2]) {
      pairs.push({ q: match[1].trim(), a: match[2].trim() });
    } else {
      note = (note ? `${note} ` : "") + trimmed;
    }
  }
  if (!text) {
    return null;
  }
  const items: Array<{ q: string; a: string }> = [...pairs];
  if (note) {
    items.push({ q: t("ai_clarify_more"), a: note });
  }
  const view = [...items].reverse().slice(0, 4);
  return (
    <section aria-label={t("ai_clarify_summary")} className="mb-5">
      <RailHeader count={items.length} icon={MessageCircleQuestion} title={t("ai_clarify_summary")} />
      <ul className="mt-3 space-y-1.5">
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
  onStop,
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
  /** continue an INTERRUPTED research as a new run in the same thread
      (the failed box's primary action when research gathered material) */
  onContinue?: () => void;
  onFallback?: () => void;
  /** a Related question was picked: start a follow-up run */
  onRelated?: (question: string) => void;
  onStop?: () => void;
  /** the awaiting run's clarify card was answered (null = skipped) */
  onSubmitClarify?: (text: string | null) => void;
}) {
  const t = useT();
  const copyToast = useCopyToast();
  const [researchForced, setResearchForced] = useState<boolean | null>(null);
  // the citation-locate flow: an [n] click (answer chip, gallery tile,
  // findings-fact chip) EXPANDS the rail's capped lists, then scrolls the
  // target source card into view inside the rail's own scroll and flashes
  // it -- the cap must never eat a citation
  const [locate, setLocate] = useState<{ n: number; seq: number } | null>(null);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [findingsExpanded, setFindingsExpanded] = useState(false);
  const [gapsExpanded, setGapsExpanded] = useState(false);
  const locateSeq = useRef(0);
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
  // the sources the ANSWER actually cites wear the same dashed frame the
  // AI Overview draws on the classic page (data-ai-cited in base.css)
  const citedSet = useMemo(() => new Set(citedSourceNumbers(run.answer)), [run.answer]);
  const totalCalls = run.steps.reduce((sum, step) => sum + (step.kind === "calls" ? step.calls.length : 0), 0);
  // the round counter (第 N 轮): the executed steps' count -- while a
  // round streams, its calls step already exists, so N names the round
  // in flight
  const roundCount = run.steps.filter((step) => step.kind === "calls").length;
  // the process timeline is the record of how the report was made: OPEN
  // through the research phase, FOLDED once the writer takes over (the
  // answer becomes the focus; the record is one click away) -- an explicit
  // user toggle always wins
  // the box folds when the ANSWER starts streaming, not when the write
  // turn opens: the writer's own reasoning streams into the open box (it
  // IS the visible feedback during the longest silent stretch), and the
  // two-column wrapper keeps the height its absolute rail pins to
  const researchOpen =
    researchForced ??
    ((streaming && run.answer === "" && !run.direct) || (run.status === "awaiting" && run.ask !== null));
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
      <h2 className="break-words font-medium leading-tight text-ink text-2xl" dir="auto">
        {run.q}
      </h2>

      {/* the run's macro-stage spine: the RUN's own line under the title --
          it covers 撰写/核验 which live outside the research box, so it
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

      {/* the user's attached images for THIS question: a compact thumb
          strip -- click opens the full image (the browser-local data URL);
          metadata-only replays render as a muted placeholder chip */}
      {run.attachments?.length ? (
        <div className="flex flex-wrap gap-2">
          {run.attachments.map((attachment, index) => (
            <a
              aria-label={attachment.name ?? t("attach_images")}
              className="group relative block overflow-hidden rounded-lg border border-line"
              href={attachment.data}
              key={index}
              rel="noreferrer"
              target="_blank"
            >
              {attachment.data ? (
                <img
                  alt={attachment.name ?? ""}
                  className="h-16 w-16 object-cover transition-transform group-hover:scale-105"
                  src={attachment.data}
                />
              ) : (
                <span className="grid h-16 w-16 place-items-center bg-surface-2/50 text-[11px] text-ink-3">
                  {attachment.mime.replace("image/", "")}
                </span>
              )}
            </a>
          ))}
        </div>
      ) : null}
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
                <button
                  aria-label={t("stop")}
                  className={`${CHIP_BTN} shrink-0`}
                  onClick={onStop}
                  title={t("stop")}
                  type="button"
                >
                  <CircleStop className="size-3.5" />
                </button>
              ) : null}
            </div>
            {/* the macro-stage spine: visible even when the timeline folds --
            this is the orientation element for a ~10-minute deep run */}
            <Collapse className={researchOpen ? "mt-3" : ""} open={researchOpen}>
              <div className="break-words rounded-lg border border-line p-3">
                {run.steps.map((step, index) => (
                  <StepSegment
                    index={index}
                    key={`${step.kind}-${index}`}
                    run={run}
                    step={step}
                    streaming={streaming}
                  />
                ))}
                {streaming && !run.steps.length ? (
                  <p className="px-1 py-1 text-xs text-ink-3">{t("ai_search_thinking_plan")}</p>
                ) : null}
              </div>
            </Collapse>
          </section>
          {/* the budget took the tools away: the model was told to summarize
          and is rewriting the complete answer (partial prose discarded).
          The REPORT shape renders neither line -- its progress surface is
          the document itself (the TOC's per-section spinners and the
          N/M counter); a spinner here would read as a stalled run. */}
          {run.wrappingUp && streaming && !run.outline ? (
            <p className="flex items-center gap-1.5 text-xs text-ink-3">
              <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin" />
              {t("ai_wrapup")}
            </p>
          ) : null}
          {/* the answer column continues below */}
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
            <div className="zjs-answer-body text-sm leading-relaxed text-ink">
              {run.outline ? (
                <DocumentView
                  meta={sourceMeta}
                  onCite={handleCite}
                  run={{ galleries: run.galleries, outline: run.outline, sections: run.sections, runNo: run.runNo }}
                  settled={!streaming}
                />
              ) : (
                <MarkdownAnswer
                  galleries={run.galleries}
                  markdown={citeToLinks(run.answer)}
                  meta={sourceMeta}
                  onCite={handleCite}
                  settled={!streaming}
                />
              )}
            </div>
          ) : null}
          {!streaming && isLast && run.answer ? (
            <div className="flex items-center gap-1">
              {/* [retry | copy] -- twin ghost circles: the fill is HOVER
                  feedback only (a persistent disc reads as a selected state).
                  Downloads (MD/PDF) live in the knowledge base's inspector
                  ONLY -- the answer surfaces stay read-and-ask. */}
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
                  copyToast(run.answer);
                }}
                title={t("copy")}
                type="button"
              >
                <Copy className="size-3.5" />
              </button>
            </div>
          ) : null}
          {/* the run's meta line at the END of the output (lobehub's
              message footer): model + tokens + transport outcome */}
          {!streaming && !failed ? (
            <AiRunFooter finish={run.finish ?? null} model={run.model ?? null} usage={run.usage ?? null} />
          ) : null}

          {failed ? (
            <div className="rounded-lg border border-line p-3 text-xs text-danger">
              <p>{t("ai_search_failed")}</p>
              {run.error ? (
                <p className="mt-1 break-words text-danger/80" dir="auto">
                  {run.error}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {/* an INTERRUPTED research keeps its ledger: 继续 starts a
                    new run in the same thread -- numbering and findings
                    travel, the researcher resumes the gaps (the primary
                    action whenever this run actually gathered material) */}
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
          ) : null}
        </div>

        {/* this run's own source cards -- the evidence behind the
            answer; the sticky right rail from lg, stacked below it on
            narrow screens (the run hides the slot entirely when it can
            never get content: a settled no-source run) */}
        {run.sources.length > 0 || streaming ? (
          <aside className="mt-5 w-full lg:sticky lg:top-14 lg:mt-0 lg:flex lg:h-[calc(100vh-3.5rem)] lg:w-80 lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:overscroll-contain lg:pb-10 lg:pr-0.5 xl:w-96">
            {/* FIXED-HEIGHT SCROLLER, not a max-h: flex children never
                shrink below their content, so a capped aside only clips
                its paint -- the bottom sat unreachable under the floating
                follow-up box.  The rail owns THE scroll; every section is
                an ordinary block (cap-4 each), and the pb-44 keeps the
                last card reachable above the follow-up box. */}
            {run.clarify !== undefined ? <AskArchiveCard clarify={run.clarify} /> : null}
            <DecisionsCard decisions={run.decisions ?? []} />
            {run.tasks.length > 0 ? <TaskCard tasks={run.tasks} /> : null}
            {(run.learnings ?? []).length > 0 ? (
              <FindingsCard
                expanded={findingsExpanded}
                learnings={run.learnings ?? []}
                onCiteN={handleCite}
                onToggleExpanded={setFindingsExpanded}
              />
            ) : null}
            {(run.gaps ?? []).length > 0 ? (
              <GapsCard
                expanded={gapsExpanded}
                gaps={run.gaps ?? []}
                onCiteN={handleCite}
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
    prev.live === next.live,
);
