// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  ArrowUpRight,
  BookMarked,
  BookOpen,
  BookUser,
  Brain,
  Calculator,
  Check,
  ChevronDown,
  CircleAlert,
  CircleStop,
  Compass,
  Copy,
  CornerDownRight,
  Globe,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  MessageCircleQuestion,
  Minus,
  NotebookPen,
  Play,
  Plug,
  RefreshCw,
  Repeat2,
  Scale,
  Search,
  Waypoints,
} from "lucide-react";
import { memo, type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Collapse } from "@/components/Collapse.tsx";
import { AiRunFooter } from "@/features/results/AiRunFooter.tsx";
import { MarkdownAnswer, ThinkScroll } from "@/features/results/AiSummary.tsx";
import type { AiSourceMeta } from "@/features/results/aiOverview.ts";
import { AiSearchSources, AiSearchSourcesSkeleton } from "@/features/results/aiSearch/AiSearchSources.tsx";
import type {
  AiAskQuestion,
  AiSearchCall,
  AiSearchRun,
  AiSearchSource,
  AiSearchStep,
} from "@/features/results/aiSearch/useAiSearch.ts";
import { Snippet } from "@/features/results/cardParts.tsx";
import { citeToLinks } from "@/lib/citations.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { useT } from "@/lib/i18n.ts";
import { escapeHtml } from "@/lib/print.ts";
import { CHIP_BTN, HOVER_CHIP, META_TOGGLE, READ_PANE, SCROLLBAR_NONE } from "@/lib/styles.ts";

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

/** One settled search's result cards (DeltaV's expandable tool row): a
    swipe strip of small title + favicon + domain cards, each opening the
    result page.  Fed from the run's [n] registry slice for that call. */
function CallResults({ results }: { results: AiSearchSource[] }) {
  return (
    <div className={`mt-1 flex gap-2 overflow-x-auto pb-1 ${SCROLLBAR_NONE} [&>*]:shrink-0`}>
      {results.map((source) => (
        <a
          className="w-44 rounded-lg bg-surface-2/70 p-2 transition-colors hover:bg-surface-2"
          href={source.url}
          key={source.n}
          rel="noreferrer"
          target="_blank"
        >
          <p className="line-clamp-2 text-xs font-medium leading-snug text-ink" dir="auto">
            {source.title}
          </p>
          <span className="mt-1.5 flex min-w-0 items-center gap-1">
            {source.favicon ? (
              <img alt="" aria-hidden="true" className="size-3.5 rounded object-contain" src={source.favicon} />
            ) : (
              <Globe aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
            )}
            <span className="truncate text-xs text-ink-3">{source.netloc}</span>
          </span>
        </a>
      ))}
    </div>
  );
}

/** Compact label for an web_reader row: host + trimmed path -- the url is
    what identifies the read (two pages on one site must look different);
    a malformed url shows as-is. */
function pageLabel(url: string | undefined): string {
  if (!url) {
    return "?";
  }
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname + parsed.search;
    return parsed.hostname + path;
  } catch {
    return url;
  }
}

/** A tool row's content pane (the web_reader page markdown, an MCP
    result) under PROGRESSIVE DISCLOSURE: a fixed-height preview first --
    bottom-faded, one 展开全文 pill -- expanding into the scroll-capped
    full text on demand.  Short content skips the staging entirely.
    The corner chips (hover, the CodeBlock pattern) carry the
    external-open and copy paths. */
function CallContent({ call }: { call: AiSearchCall }) {
  const t = useT();
  const copyToast = useCopyToast();
  const text = call.text ?? "";
  // NO progressive disclosure: the pane is the row's point and it scrolls
  // INTERNALLY (max-h-96) -- a preview-then-expand second fold is friction
  // the internal scroll already solves
  return (
    <div className="group relative mt-1">
      <div className={`relative ${READ_PANE} max-h-96 overflow-y-auto overscroll-contain`} dir="auto">
        {text}
      </div>
      <div className="absolute end-2 top-2 flex gap-0.5">
        {call.url ? (
          <a
            aria-label={t("open_source")}
            className={`${HOVER_CHIP} hover:text-accent`}
            href={call.url}
            rel="noreferrer"
            target="_blank"
            title={t("open_source")}
          >
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </a>
        ) : null}
        <button
          aria-label={t("copy")}
          className={HOVER_CHIP}
          onClick={() => {
            copyToast(text);
          }}
          title={t("copy")}
          type="button"
        >
          <Copy aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </div>
  );
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
    <div className="mb-4">
      <div className="flex items-center gap-2">
        <ListTodo aria-hidden="true" className="size-4.5 shrink-0 text-ink-3" />
        <h3 className="text-base font-semibold text-ink">{t("ai_task_card")}</h3>
        <span className="shrink-0 text-xs tabular-nums text-ink-3">
          {done}/{tasks.length}
        </span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {tasks.map((task, index) => (
          <TaskItem key={`${index}-${task.title}`} task={task} />
        ))}
      </ul>
    </div>
  );
}

/** The findings ledger (the learnings tool writes it; the writer received
    the same list as <findings>): the evidence trail under the plan card --
    what the sources ESTABLISHED, growing live as the run records.  Each
    fact renders through the SAME measured clamp+expand as a source card's
    snippet (the 查看更多 language) -- nothing is folded away unreadable.
    The plan card above says what the run intends; this card says what it
    already has. */
function FindingsCard({ learnings }: { learnings: string[] }) {
  const t = useT();
  if (learnings.length === 0) {
    return null;
  }
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2">
        <NotebookPen aria-hidden="true" className="size-4.5 shrink-0 text-ink-3" />
        <h3 className="text-base font-semibold text-ink">{t("ai_findings_card")}</h3>
        <span className="shrink-0 text-xs tabular-nums text-ink-3">{learnings.length}</span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {learnings.map((fact, index) => (
          <li className="flex items-start gap-2" key={`${index}-${fact}`}>
            <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent/70" />
            <div className="min-w-0 flex-1">
              <Snippet contentHtml={escapeHtml(fact)} />
            </div>
          </li>
        ))}
      </ul>
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
      <div className="flex items-start gap-2 text-xs">
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
        {task.status === "done" ? (
          <Check aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-ok" />
        ) : task.status === "active" ? (
          <span className="relative mt-1 flex size-3 shrink-0 items-center justify-center">
            <span className="absolute size-3 animate-ping rounded-full bg-accent/40" />
            <span className="size-1.5 rounded-full bg-accent" />
          </span>
        ) : task.status === "missed" ? (
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-warning" />
        ) : (
          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-ink-3/50" />
        )}
        <span className={`min-w-0 flex-1 break-words ${task.status === "done" ? "text-ink-3" : "text-ink"}`} dir="auto">
          {task.title}
          {task.status === "missed" ? (
            <span className="ms-1.5 whitespace-nowrap text-[11px] text-warning">{t("ai_task_missed")}</span>
          ) : null}
        </span>
        {task.status === "done" && (task.sources?.length ?? 0) > 0 ? (
          <span className="shrink-0 text-[11px] tabular-nums text-ink-3">
            {t("ai_task_sources", { n: String(task.sources?.length ?? 0) })}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** One tool-call row: status + query/url + result/char count, EXPANDABLE --
    a search row reveals its raw arguments (debug: exactly what the model
    passed) plus its result cards, a page read reveals the READING PANE
    (the crawled content itself). */
function CallRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const copyToast = useCopyToast();
  const [open, setOpen] = useState(false);
  const ok = call.status === "ok";
  const isPage = call.tool === "web_reader";
  const isCalc = call.tool === "calculator";
  const isMemory = call.tool === "user_memory";
  const isPastResearch = call.tool === "past_research";
  const isTask = call.tool === "task_write";
  const isLearnings = call.tool === "learnings";
  const isAsk = call.tool === "ask_user";
  const isDecision = call.tool === "system_one";
  const rawArgs = call.args && Object.keys(call.args).length > 0 ? JSON.stringify(call.args, null, 2) : null;
  // web_reader rows NEVER fold: the reading pane (scroll-capped inside)
  // renders below the row unconditionally -- the content is the row's
  // point, and a second click to see what was read is friction
  const expandable =
    (call.tool === "mcp"
      ? Boolean(call.text)
      : isCalc || isMemory || isPastResearch || isLearnings
        ? false
        : results.length > 0) ||
    (Boolean(rawArgs) && !isPage);
  return (
    <div>
      <button
        aria-expanded={expandable ? open : undefined}
        className={`flex min-h-6 w-full items-center gap-1.5 px-1 text-xs ${
          call.status === "error" ? "text-danger" : "text-ink-3"
        } ${expandable ? "transition-colors hover:text-ink" : ""}`}
        onClick={() => {
          if (expandable) {
            setOpen(!open);
          }
        }}
        type="button"
      >
        {call.status === "pending" ? (
          <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin" />
        ) : ok ? (
          <Check aria-hidden="true" className="size-3 shrink-0 text-ok" />
        ) : call.status === "interrupted" || call.status === "duplicate" ? (
          <Minus aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <CircleAlert aria-hidden="true" className="size-3 shrink-0 text-danger" />
        )}
        {isPage ? (
          <BookOpen aria-hidden="true" className="size-3 shrink-0" />
        ) : isCalc ? (
          <Calculator aria-hidden="true" className="size-3 shrink-0" />
        ) : isTask ? (
          <ListTodo aria-hidden="true" className="size-3 shrink-0" />
        ) : isLearnings ? (
          <NotebookPen aria-hidden="true" className="size-3 shrink-0" />
        ) : isAsk ? (
          <MessageCircleQuestion aria-hidden="true" className="size-3 shrink-0" />
        ) : isDecision ? (
          <Scale aria-hidden="true" className="size-3 shrink-0" />
        ) : call.tool === "mcp" ? (
          <Plug aria-hidden="true" className="size-3 shrink-0" />
        ) : isPastResearch ? (
          <BookMarked aria-hidden="true" className="size-3 shrink-0" />
        ) : isMemory ? (
          <BookUser aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <Search aria-hidden="true" className="size-3 shrink-0" />
        )}
        <span className="truncate" dir="auto">
          {isPage
            ? pageLabel(call.url)
            : isTask
              ? t("ai_task_row")
              : isLearnings
                ? t("ai_learnings_row")
                : isAsk
                  ? call.q || t("ai_ask_row")
                  : isDecision
                    ? call.q || t("ai_decision_row")
                    : call.tool === "mcp"
                      ? call.name === "search_tools"
                        ? `${t("ai_mcp_search_row")}${call.q ? `: ${call.q}` : ""}`
                        : (call.name ?? t("ai_mcp_tool"))
                      : isPastResearch
                        ? call.q
                        : isMemory
                          ? `${call.name === "save" ? t("ai_memory_save") : t("ai_memory_search")}${call.label ? `: ${call.label}` : ""}`
                          : call.q}
        </span>
        <span className="ms-auto shrink-0 ps-2 font-mono tabular-nums">
          {call.status === "pending"
            ? isPage
              ? t("ai_page_reading")
              : isCalc
                ? t("ai_calc_running")
                : isTask
                  ? t("ai_task_writing")
                  : isLearnings
                    ? t("ai_learnings_running")
                    : isAsk
                      ? t("ai_ask_awaiting")
                      : isDecision
                        ? t("ai_decision_running")
                        : call.tool === "mcp"
                          ? t("ai_mcp_running")
                          : isPastResearch
                            ? t("ai_past_research_running")
                            : isMemory
                              ? t("ai_memory_running")
                              : t("ai_search_running")
            : ok
              ? isPage
                ? t("ai_page_chars", { n: String(call.chars ?? 0) })
                : isCalc
                  ? `= ${call.result ?? "?"}`
                  : isTask
                    ? (call.q ?? "")
                    : isLearnings
                      ? t("ai_learnings_done", { n: String(call.n ?? 0) })
                      : isAsk
                        ? ""
                        : isDecision
                          ? t("ai_decision_done", { n: String(call.n ?? 0) })
                          : call.tool === "mcp"
                            ? t("ai_mcp_done")
                            : isPastResearch
                              ? t("ai_past_research_hits", { n: String(call.n ?? 0) })
                              : isMemory
                                ? ""
                                : t("ai_search_results", { n: String(call.n ?? 0) })
              : call.status === "interrupted"
                ? t("ai_search_row_interrupted")
                : call.status === "duplicate"
                  ? t("ai_search_row_duplicate")
                  : t("ai_search_row_failed")}
        </span>
        {expandable ? (
          <ChevronDown
            aria-hidden="true"
            className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        ) : null}
      </button>
      {/* the reading pane NEVER folds: a settled read shows its content
          right under the row (scroll-capped inside CallContent) */}
      {isPage && call.text ? <CallContent call={call} /> : null}
      {open && expandable ? (
        <>
          {rawArgs ? (
            // the DEBUG pane: the model's raw tool-call arguments, exactly
            // as passed -- mono, scroll-capped, copyable
            <div className="group relative mt-1">
              <div
                className="max-h-40 overflow-y-auto overscroll-contain rounded-lg bg-surface-2/50 py-2 pe-10 ps-3 text-xs leading-relaxed whitespace-pre-wrap break-words text-ink-2"
                dir="ltr"
              >
                {rawArgs}
              </div>
              <button
                aria-label={t("copy")}
                className="absolute end-2 top-2 grid size-7 place-items-center rounded-lg bg-surface/80 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
                onClick={() => {
                  copyToast(rawArgs);
                }}
                title={t("copy")}
                type="button"
              >
                <Copy aria-hidden="true" className="size-3.5" />
              </button>
            </div>
          ) : null}
          {call.tool === "mcp" ? (
            <CallContent call={call} />
          ) : isTask || isAsk || isLearnings ? null : (
            <CallResults results={results} />
          )}
        </>
      ) : null}
    </div>
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
          // while the run streams, only the LIVE round's reasoning is open
          // (older rounds fold as the next one starts); once settled every
          // segment opens -- the inter-round reasoning IS the reply between
          // the call rows, and ThinkScroll caps the volume per segment
          open={streaming ? index === run.steps.length - 1 : true}
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
  const seconds = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));
  const label =
    seconds < 60
      ? t("ai_elapsed_seconds", { n: String(seconds) })
      : t("ai_elapsed_minutes", { n: String(Math.floor(seconds / 60)), s: String(seconds % 60) });
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
        className="mt-3 h-9 w-full shrink-0 rounded-lg border border-line bg-transparent px-3 text-base text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent"
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

/** The clarify round-trip after submission: the confirmed direction (or
    the skip) the research below is built on, as a collapsible segment --
    OPEN by default so the user can always review what shaped the run
    (morphic keeps the clarification exchange in the transcript; a thin
    one-line summary just reads as broken). */
function AskArchiveCard({ clarify }: { clarify: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
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
  return (
    // the ask round ARCHIVED, in the sources section's own language:
    // header + SourceCard-shaped rows -- one card per ask round, click to
    // expand the full Q/A detail
    <section aria-label={t("ai_clarify_summary")}>
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <MessageCircleQuestion aria-hidden="true" className="size-4.5 shrink-0 text-ink-3" />
          <h3 className="text-base font-semibold text-ink">{t("ai_clarify_summary")}</h3>
          <span className="shrink-0 text-xs tabular-nums text-ink-3">{items.length}</span>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          <button
            aria-expanded={expanded}
            className={`flex items-center gap-2.5 rounded-lg bg-surface-2/70 p-2.5 text-start transition-colors hover:bg-surface-2 ${expanded ? "ring-1 ring-accent-soft" : ""}`}
            onClick={() => {
              setExpanded(!expanded);
            }}
            type="button"
          >
            <span className="flex size-4 shrink-0 items-center justify-center self-center overflow-hidden rounded-[5px] bg-surface ring-1 ring-line lg:self-auto">
              <MessageCircleQuestion aria-hidden="true" className="size-3.5 text-ink-3" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-ink" dir="auto">
                {pairs[0]?.q ?? t("ai_clarify_summary")}
              </span>
              <span className="mt-0.5 flex items-center justify-between gap-1.5">
                <span className="truncate text-xs text-ink-3">{items.map((item) => item.a).join(" · ")}</span>
                <ChevronDown
                  aria-hidden="true"
                  className={`size-3.5 shrink-0 text-ink-3 transition-transform ${expanded ? "rotate-180" : ""}`}
                />
              </span>
            </span>
          </button>
          <Collapse className={expanded ? "ps-1" : ""} open={expanded} unmountAfterHide>
            <div className="space-y-1.5">
              {items.map((item) => (
                <div className="flex items-start gap-2 text-xs" key={item.q}>
                  <Check aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-ok" />
                  <span className="min-w-0 flex-1 break-words">
                    <span className="block text-ink">{item.a}</span>
                    <span className="block text-ink-3">{item.q}</span>
                  </span>
                </div>
              ))}
            </div>
          </Collapse>
        </div>
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
  const streaming = run.status === "streaming" && live;
  const totalCalls = run.steps.reduce((sum, step) => sum + (step.kind === "calls" ? step.calls.length : 0), 0);
  // the process timeline is the record of how the report was made: OPEN
  // through the research phase, FOLDED once the writer takes over (the
  // answer becomes the focus; the record is one click away) -- an explicit
  // user toggle always wins
  const researchOpen =
    researchForced ?? ((streaming && !run.wrappingUp) || (run.status === "awaiting" && run.ask !== null));
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
            <span className="shrink-0 text-xs text-ink-3">{t("ai_search_calls_count", { n: String(totalCalls) })}</span>
          ) : null}
          <ElapsedTimer endedAt={run.endedAt} startedAt={run.startedAt} />
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
        <Collapse className={researchOpen ? "mt-3" : ""} open={researchOpen}>
          <div className="break-words rounded-lg border border-line p-3">
            {run.steps.map((step, index) => (
              <StepSegment index={index} key={`${step.kind}-${index}`} run={run} step={step} streaming={streaming} />
            ))}
            {streaming && !run.steps.length ? (
              <p className="px-1 py-1 text-xs text-ink-3">{t("ai_search_thinking_plan")}</p>
            ) : null}
          </div>
        </Collapse>
      </section>

      {/* the budget took the tools away: the model was told to summarize
          and is rewriting the complete answer (partial prose discarded) */}
      {run.wrappingUp && streaming ? (
        <p className="flex items-center gap-1.5 text-xs text-ink-3">
          <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin" />
          {t("ai_wrapup")}
        </p>
      ) : null}

      {/* answer + sources: TWO-COLUMN from lg (Perplexity's shape) --
              the prose keeps its reading measure on the left, the run's
              source cards become a sticky rail on the right; below lg
              everything stacks: answer, related, actions, sources.  The
              answer carries no header row -- the prose is the anchor; one
              compact line covers the writer's silent start. */}
      <div className="lg:flex lg:items-start lg:justify-between lg:gap-8">
        <div className="min-w-0 flex-1 space-y-5 lg:max-w-3xl">
          {streaming &&
          !run.answer &&
          (run.wrappingUp || run.direct || run.steps.some((step) => step.kind === "calls")) ? (
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
              <MarkdownAnswer
                galleries={run.galleries}
                markdown={citeToLinks(run.answer)}
                meta={sourceMeta}
                onCite={onCite}
                settled={!streaming}
              />
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
          <aside className="mt-5 w-full lg:sticky lg:top-4 lg:mt-0 lg:max-h-[calc(100vh-2rem)] lg:w-72 lg:shrink-0 lg:overflow-y-auto lg:overscroll-contain xl:w-80">
            {run.tasks.length > 0 ? <TaskCard tasks={run.tasks} /> : null}
            {run.learnings && run.learnings.length > 0 ? <FindingsCard learnings={run.learnings} /> : null}
            {run.clarify !== undefined ? <AskArchiveCard clarify={run.clarify} /> : null}
            {run.sources.length > 0 ? <AiSearchSources sources={run.sources} /> : <AiSearchSourcesSkeleton />}
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
