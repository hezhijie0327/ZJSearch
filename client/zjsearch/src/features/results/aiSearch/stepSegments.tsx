import { Brain, Check, ChevronDown, Compass, FoldVertical, Lightbulb, LoaderCircle } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import { ThinkScroll } from "@/features/aiAnswer/ThinkScroll.tsx";
import { ToolRow } from "@/features/results/aiSearch/calls/ToolRow.tsx";
import type {
  AiSearchCall,
  AiSearchRun,
  AiSearchSource,
  AiSearchStep,
} from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";
import { inlineMdHtml } from "@/lib/markdownParts.ts";
import { META_TOGGLE } from "@/lib/styles.ts";

/** Collapsed run-title preview: three lines of text-3xl/leading-tight
    (30px × 1.25 ≈ 37.5px).  Matches the boot ghost's `line-clamp-3` and the
    static skeleton's `.zjs-boot-ai-title` clamp so the handover never
    shifts; deep-research briefs pasted as prompts read as a preview +
    expand chip instead of wall-to-wall 30px text. */

const CallRow = memo(function CallRow({
  call,
  sources,
  stepEntry,
  stepRound,
  agent,
}: {
  call: AiSearchCall;
  sources: AiSearchSource[];
  stepEntry: number | undefined;
  stepRound: number;
  agent: string | undefined;
}) {
  // a re-search whose hits were all already-numbered emits no new
  // sources -- the call's dupes ARE its results (their existing [n]s)
  const results = useMemo(
    () =>
      sources.filter((source) =>
        // PRIMARY: the producing batch's turn -- but the first
        // delegation pass's child turns share the lead's entry-id
        // numbers, so the agent key discriminates alongside (this
        // step's agent: undefined = lead).  FALLBACK: the
        // (agent, round, callId) triple for replays whose sources
        // predate the turn stamp
        source.turn !== undefined
          ? source.turn === stepEntry && (source.agent ?? "lead") === (agent ?? "lead")
          : (source.agent ?? "lead") === (agent ?? "lead") && source.round === stepRound && source.callId === call.id,
      ),
    [sources, stepEntry, stepRound, agent, call.id],
  );
  const merged = useMemo(() => {
    const dupes = (call.dupes ?? [])
      .map((n) => sources.find((source) => source.n === n))
      .filter((source): source is AiSearchSource => Boolean(source))
      .filter((dup) => !results.some((result) => result.n === dup.n));
    return [...results, ...dupes];
  }, [call.dupes, sources, results]);
  return <ToolRow call={call} results={merged} />;
});

/** The living task list (the update_plan tool maintains it): a STATUS-ONLY
    card -- one colored mark per state (pending dot, active ping, done
    check, uncovered warning), a done/total counter in the header.  How
    each subtask was researched is the research process timeline's job;
    this card never expands. */

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
    <div className="animate-fade-in">
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
            <StepSegment
              agent={step.agent}
              index={innerIdx}
              isLast={innerIdx === step.inner.length - 1}
              key={`${inner.kind}-${innerIdx}`}
              run={run}
              step={inner}
              streaming={live}
            />
          ))}
          {!step.inner.length ? <p className="px-1 py-1 text-xs text-ink-3">{t("ai_search_thinking_plan")}</p> : null}
        </div>
      </Collapse>
    </div>
  );
}

export function StepSegment({
  index,
  run,
  step,
  streaming,
  isLast,
  agent,
}: {
  index: number;
  run: AiSearchRun;
  step: AiSearchStep;
  streaming: boolean;
  /** the LAST segment of the enclosing list -- the live think pane's
      auto-open.  Top-level callers compare against run.steps; a sub
      row's callers MUST compare against the CHILD's inner list (the
      lead's step count says nothing about the child stream) */
  isLast?: boolean;
  /** the enclosing sub row's agent key (top-level steps omit it) -- the
      result-strip join resolves the row's OWN agent's registry slice */
  agent?: string;
}) {
  const t = useT();
  if (step.kind === "think") {
    const liveThink = streaming && (isLast ?? index === run.steps.length - 1);
    return (
      <div className={index > 0 ? "mt-2" : ""}>
        <ThinkSegment
          live={liveThink}
          // ONLY the LIVE segment opens by default (the reasoning you are
          // watching); every other segment -- earlier rounds AND the whole
          // run once settled -- stays folded behind its one-click toggle
          // (a dozen open think panes read as a wall of machine voice)
          open={liveThink}
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
        <p
          className="py-0.5 text-[13px] leading-relaxed text-ink-2"
          dangerouslySetInnerHTML={{ __html: inlineMdHtml(step.text) }}
          dir="auto"
        />
      </div>
    );
  }
  return (
    <div className={`flex flex-col gap-0.5 ${index > 0 ? "mt-1.5" : ""}`}>
      {step.calls.map((call) => (
        <CallRow
          agent={agent}
          call={call}
          key={`${step.round}-${call.id}`}
          sources={run.sources}
          stepEntry={step.entry}
          stepRound={step.round}
        />
      ))}
    </div>
  );
}

/** Live research duration ("researched X s" while running, "researched X s"
    settled): ticks once a second off the run's own clock -- the honest
    substitute for the removed time budgets (the stop button is the
    control, the elapsed time is the visibility). */
