// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  ArrowUpRight,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  CircleStop,
  Compass,
  Copy,
  CornerDownRight,
  Globe,
  Lightbulb,
  LoaderCircle,
  Minus,
  Plus,
  Repeat2,
  RotateCw,
  Search,
  Waypoints,
  X,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import { MarkdownAnswer, ThinkScroll } from "@/features/results/AiSummary.tsx";
import { type AiSourceMeta, citeToLinks } from "@/features/results/aiAnswer.ts";
import { AiSearchSources, AiSearchSourcesSkeleton } from "@/features/results/aiSearch/AiSearchSources.tsx";
import type {
  AiAskQuestion,
  AiSearchCall,
  AiSearchRun,
  AiSearchSource,
  AiSearchStep,
} from "@/features/results/aiSearch/useAiSearch.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { useT } from "@/lib/i18n.ts";
import { SCROLLBAR_NONE } from "@/lib/styles.ts";

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

/** Compact label for an web_crawler row: host + trimmed path -- the url is
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

/** The web_crawler row's expansion: the crawled page's markdown revealed
    DIRECTLY under its row (the same inline language as a search row's
    result cards -- the row is the title, no second header).  Long pages
    cap into an internal scroll; the corner chips (hover, the CodeBlock
    pattern) carry the external-open and copy paths. */
function PageReading({ call }: { call: AiSearchCall }) {
  const t = useT();
  const copyToast = useCopyToast();
  return (
    <div className="group relative mt-1">
      <div
        className="max-h-80 overflow-y-auto overscroll-contain rounded-lg bg-surface-2/50 py-2 pe-10 ps-3 text-xs leading-relaxed whitespace-pre-wrap break-words text-ink-2"
        dir="auto"
      >
        {call.text}
      </div>
      <div className="absolute end-2 top-2 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {call.url ? (
          <a
            aria-label={t("open_source")}
            className="inline-flex size-7 items-center justify-center rounded-lg bg-surface/80 text-ink-3 backdrop-blur transition-colors hover:text-accent"
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
          className="inline-flex size-7 items-center justify-center rounded-lg bg-surface/80 text-ink-3 backdrop-blur transition-colors hover:text-ink"
          onClick={() => {
            copyToast(call.text ?? "");
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

/** One tool-call row: status + query/url + result/char count, EXPANDABLE --
    a search row reveals its result cards, a page read reveals the READING
    PANE (the crawled content itself). */
function CallRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ok = call.status === "ok";
  const isPage = call.tool === "web_crawler";
  const expandable = isPage ? Boolean(call.text) : results.length > 0;
  return (
    <div>
      <button
        aria-expanded={expandable ? open : undefined}
        className={`flex min-h-6 w-full items-center gap-1.5 px-1 text-xs ${
          call.status === "error" || call.status === "timeout" ? "text-danger" : "text-ink-3"
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
          <X aria-hidden="true" className="size-3 shrink-0 text-danger" />
        )}
        {isPage ? (
          <BookOpen aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <Search aria-hidden="true" className="size-3 shrink-0" />
        )}
        <span className="truncate" dir="auto">
          {isPage ? pageLabel(call.url) : call.q}
        </span>
        <span className="ms-auto shrink-0 ps-2 tabular-nums">
          {call.status === "pending"
            ? isPage
              ? t("ai_page_reading")
              : t("ai_search_running")
            : ok
              ? isPage
                ? t("ai_page_chars", { n: String(call.chars ?? 0) })
                : `(${call.n ?? 0})`
              : call.status === "timeout"
                ? t("ai_search_row_timeout")
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
      {open && expandable ? isPage ? <PageReading call={call} /> : <CallResults results={results} /> : null}
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
        className="inline-flex min-h-6 items-center gap-1 text-xs text-ink-3 transition-colors hover:text-ink-2"
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
  if (step.kind === "think") {
    return (
      <div className={index > 0 ? "mt-2.5" : ""}>
        <ThinkSegment
          live={streaming && index === run.steps.length - 1}
          open={streaming && index === run.steps.length - 1}
          step={step}
        />
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
    const lines = ask.questions.map((q, i) => `${i + 1}. ${q.q}：${(picked[i] ?? []).join("、") || "—"}`);
    if (note.trim()) {
      lines.push(`${t("ai_clarify_more")}：${note.trim()}`);
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
      className="animate-fade-up rounded-2xl border border-line bg-surface p-4"
      role="form"
    >
      <div className="flex items-center gap-2">
        <Compass aria-hidden="true" className="size-5 shrink-0 text-ink-3" />
        <h3 className="text-xl font-medium text-ink">{t("ai_clarify_title")}</h3>
      </div>
      {ask.intro ? (
        <p className="mt-2 text-sm leading-relaxed text-ink-2" dir="auto">
          {ask.intro}
        </p>
      ) : null}
      <div className="mt-3 space-y-4">
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
        className="mt-3 h-9 w-full rounded-lg border border-line bg-transparent px-3 text-base text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent"
        dir="auto"
        onChange={(event) => {
          setNote(event.target.value);
        }}
        placeholder={t("ai_clarify_more")}
        value={note}
      />
      <div className="mt-3 flex items-center justify-between gap-2">
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
          className="rounded-full bg-accent-strong px-4 py-1.5 text-[13px] font-medium text-accent-contrast transition-opacity hover:opacity-90"
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
function ClarifySegment({ clarify }: { clarify: string }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const text = clarify.trim();
  return (
    <div>
      <button
        aria-expanded={open}
        className="inline-flex min-h-6 items-center gap-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink"
        onClick={() => {
          setOpen(!open);
        }}
        type="button"
      >
        <Compass aria-hidden="true" className="size-3.5 shrink-0 text-accent" />
        {text ? t("ai_clarify_summary") : t("ai_clarify_skipped")}
        <ChevronDown aria-hidden="true" className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {text ? (
        <Collapse className={open ? "mt-1" : ""} open={open}>
          <p className="whitespace-pre-wrap break-words ps-5 text-[13px] leading-relaxed text-ink-2" dir="auto">
            {text}
          </p>
        </Collapse>
      ) : null}
    </div>
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
  const researchOpen = researchForced ?? streaming;
  const hasThink = run.steps.some((step) => step.kind === "think" && step.text.trim());
  const failed = run.status === "error" || (run.status === "done" && !run.answer && !hasThink && totalCalls === 0);
  const awaiting = run.status === "awaiting" && run.ask !== null;

  return (
    <section
      aria-busy={streaming}
      aria-label={run.q}
      className={`animate-fade-up space-y-5 ${isFirst ? "" : "border-t border-line pt-8"}`}
      id={`ai-run-${run.runNo}`}
    >
      <h2 className={`break-words font-medium leading-tight text-ink ${isFirst ? "text-3xl" : "text-2xl"}`} dir="auto">
        {run.q}
      </h2>

      {awaiting && run.ask ? (
        // the clarify gate asked for the direction BEFORE researching:
        // the question card IS the section until the user answers
        <AskCard ask={run.ask} onSubmit={onSubmitClarify ?? (() => {})} />
      ) : (
        <>
          {run.ask && run.clarify !== undefined ? (
            // the clarify round-trip: the confirmed direction (or the
            // skip) the research below is built on -- inspectable
            <ClarifySegment clarify={run.clarify} />
          ) : null}

          {/* research: think stream + intent + parallel tool calls */}
          <section aria-busy={streaming} aria-label={t("ai_search_process")}>
            <div className="flex items-center gap-2">
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
              {streaming ? (
                <button
                  aria-label={t("stop")}
                  className="grid size-8 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                  onClick={onStop}
                  title={t("stop")}
                  type="button"
                >
                  <CircleStop className="size-4" />
                </button>
              ) : null}
            </div>
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
              {run.answer ? (
                <div className="text-sm leading-relaxed text-ink">
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
                  feedback only (a persistent disc reads as a selected state) */}
                  <button
                    aria-label={t("regenerate")}
                    className="grid size-8 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                    onClick={onRegenerate}
                    title={t("regenerate")}
                    type="button"
                  >
                    <RotateCw className="size-4" />
                  </button>
                  <button
                    aria-label={t("copy")}
                    className="grid size-8 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                    onClick={() => {
                      copyToast(run.answer);
                    }}
                    title={t("copy")}
                    type="button"
                  >
                    <Copy className="size-4" />
                  </button>
                </div>
              ) : null}

              {/* this run's follow-up suggestions */}
              {run.related.length > 0 ? (
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
                          <Plus
                            aria-hidden="true"
                            className="size-4 shrink-0 text-ink-3 transition-colors group-hover:text-accent"
                          />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {failed ? (
                <div className="rounded-lg border border-line p-3 text-xs text-danger">
                  <p>{t("ai_search_failed")}</p>
                  {run.error ? (
                    <p className="mt-1 break-words text-danger/80" dir="auto">
                      {run.error}
                    </p>
                  ) : null}
                  {onFallback ? (
                    <button
                      className="mt-2 inline-flex items-center rounded-full border border-line px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink"
                      onClick={onFallback}
                      type="button"
                    >
                      {t("ai_search_try_classic")}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* this run's own source cards -- the evidence behind the
            answer; the sticky right rail from lg, stacked below it on
            narrow screens (the run hides the slot entirely when it can
            never get content: a settled no-source run) */}
            {run.sources.length > 0 || streaming ? (
              <aside className="mt-5 w-full lg:sticky lg:top-4 lg:mt-0 lg:w-72 lg:shrink-0 xl:w-80">
                {run.sources.length > 0 ? <AiSearchSources sources={run.sources} /> : <AiSearchSourcesSkeleton />}
              </aside>
            ) : null}
          </div>
        </>
      )}
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
