// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// KaTeX typography for the math pipeline (lazy-loaded plugins, css is small
// enough to ride the results stylesheet; the woff2 fonts load on demand)
import "katex/dist/katex.min.css";

import { ArrowUp, Brain, ChevronDown, Copy, FileText, RefreshCw, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClampReveal } from "@/components/ClampReveal.tsx";
import { Collapse } from "@/components/Collapse.tsx";
import { Tape } from "@/components/Tape.tsx";
import { AiRunFooter } from "@/features/aiAnswer/AiRunFooter.tsx";
import { type AiSourceMeta, extractRunMeta, splitAnswerStream } from "@/features/aiAnswer/aiOverview.ts";
import { MarkdownAnswer } from "@/features/aiAnswer/MarkdownAnswer.tsx";
import { AnswerStreamPane, ThinkScroll } from "@/features/aiAnswer/ThinkScroll.tsx";
import { citeToLinks } from "@/lib/citations.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { buildAnswerMarkdown } from "@/lib/exporters.ts";
import { fetchStream } from "@/lib/http.ts";
import { useT } from "@/lib/i18n.ts";
import { appendRunEvents } from "@/lib/kb/events.ts";
import { settleRun, startRun } from "@/lib/kb/projections.ts";
import { newThreadId, threadUrl } from "@/lib/kb/shared.ts";
import { holdBackTail } from "@/lib/markdownParts.ts";
import { useRouter } from "@/lib/router.tsx";
import { CHIP_ACCENT, META_TOGGLE } from "@/lib/styles.ts";
import type { AiCapability } from "@/lib/types.ts";

/**
 * The whole-page AI Overview.  The server puts an {@link AiCapability}
 * into the page-data globals only when the feature is configured;
 * ResultsPage hosts the state (`useOverview`) and renders the entry in the
 * results meta row (`OverviewTrigger`) plus the answer card at the top of
 * the answers area (`OverviewCard`).  The stream is plain text: the model's
 * reasoning arrives wrapped in <think>...</think> (rendered as a block that
 * is expanded live while the reasoning streams and folds once the answer
 * starts, height-capped and tail-following inside), the answer is markdown
 * (GFM) rendered through react-markdown with [n] citations rewritten into
 * `#ref-n` links that the `a` override turns into favicon-domain chips
 * which click-jump to the matching result row.  The LLM call happens on
 * click only; before the first streamed byte errors answer as clean HTTP
 * statuses (403 / 422 / 502) — the 502 body carries the upstream reason,
 * which the card renders under its failed label.
 */

type OverviewPhase = "idle" | "streaming" | "done" | "error";

interface OverviewStep {
  id: number;
  tool: string;
  label: string;
  status: string;
}

type OverviewSourceSeed = { n: number; url: string; title: string };

interface OverviewState {
  phase: OverviewPhase;
  query: string;
  text: string;
  open: boolean;
  error: string | null;
  threadId: string;
  steps: OverviewStep[];
  start: (q: string, context: string, images?: string[], sources?: OverviewSourceSeed[]) => void;
  toggle: (q: string, context: string, images?: string[], sources?: OverviewSourceSeed[]) => void;
  regenerate: () => void;
  reset: () => void;
}
/** ResultsPage-level state: the trigger chip lives in the results meta row,
    the card at the top of the answers area — one hook owns the stream so
    both stay in sync.  Same abort discipline everywhere: the controller is
    captured at start, aborted on unmount / re-ask / collapse, and every
    settled callback re-checks the signal. */
export function useOverview(capability: AiCapability | undefined, lang: string): OverviewState {
  const [phase, setPhase] = useState<OverviewPhase>("idle");
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState("");
  const [steps, setSteps] = useState<OverviewStep[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const lastAskRef = useRef<{ context: string; images: string[]; q: string; sources: OverviewSourceSeed[] } | null>(
    null,
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = (q: string, context: string, images: string[] = [], sources: OverviewSourceSeed[] = []) => {
    if (!capability) {
      return;
    }
    abortRef.current?.abort();
    lastAskRef.current = { context, images, q, sources };
    const controller = new AbortController();
    abortRef.current = controller;
    // THE OVERVIEW IS A RUN: it rides the search route's "overview" tier
    // and records like one -- run row + evt log in the browser store, so
    // the thread page resumes the conversation and a follow-up is the
    // native run 2 (the sessionStorage hand-off carries the thread id).
    const tid = newThreadId();
    setThreadId(tid);
    setPhase("streaming");
    setText("");
    setSteps([]);
    setError(null);
    setOpen(true);
    const runId = `${tid}:1`;
    const startedAt = Date.now();
    startRun(tid, { runNo: 1, q, mode: "overview", startedAt });
    appendRunEvents(runId, [{ e: "client.start", q, runNo: 1, mode: "overview", startedAt }]);
    let accumulated = "";
    let thinkOpen = false;
    let lineBuffer = "";
    let meta: { finish: string | null; model: string | null; usage: unknown } = {
      finish: null,
      model: null,
      usage: null,
    };
    let runTags: string[] = [];
    const consume = (line: string) => {
      if (!line) {
        return;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      appendRunEvents(runId, [event]);
      const kind = event.e;
      if (kind === "think") {
        if (!thinkOpen) {
          accumulated += "<think>";
          thinkOpen = true;
        }
        accumulated += String(event.t ?? "");
      } else if (kind === "answer") {
        if (thinkOpen) {
          accumulated += "</think>";
          thinkOpen = false;
        }
        accumulated += String(event.t ?? "");
      } else if (kind === "settle") {
        if (thinkOpen) {
          accumulated += "</think>";
          thinkOpen = false;
        }
        meta = {
          finish: (event.finish as string | null) ?? null,
          model: (event.model as string | null) ?? null,
          usage: event.usage ?? null,
        };
        accumulated += `\n<<<zjs-meta:${JSON.stringify(meta)}>>>`;
        // THE SETTLE IS THE CARD'S TERMINAL STATE (the AI search fold's
        // rule): the answer is complete here -- the stream's late tail
        // (title pass / related fallback / memory extraction) is
        // recording work that holds the connection open for seconds
        // more, and riding it left the finished card stuck in the
        // streaming shape.  The tail keeps draining below (tags land
        // in runTags for the recording); only the UI state moves early.
        if (!controller.signal.aborted) {
          setText(accumulated);
          setPhase("done");
        }
      } else if (kind === "tags") {
        runTags = ((event.items as unknown[]) ?? []).map((tag) => String(tag)).filter(Boolean);
      } else if (kind === "calls") {
        const items = (event.items as Array<Record<string, unknown>>) ?? [];
        setSteps((prev) => [
          ...prev,
          ...items.map((item) => ({
            id: Number(item.id) || 0,
            tool: String(item.tool ?? ""),
            label: String(item.url || item.q || item.tool || ""),
            status: "pending",
          })),
        ]);
      } else if (kind === "call") {
        const callId = Number(event.call) || 0;
        const status = String(event.status ?? "ok");
        setSteps((prev) => prev.map((step) => (step.id === callId ? { ...step, status } : step)));
      }
    };
    void fetchStream(
      "/zjsearch/ask/search",
      {
        clarify_state: "skipped",
        context,
        images,
        lang,
        mode: "overview",
        q,
        sources,
        thread: tid,
        tk: capability.tk,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      (chunk) => {
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          consume(line);
        }
        if (!controller.signal.aborted) {
          setText(accumulated);
        }
      },
      controller.signal,
    )
      .then(() => {
        consume(lineBuffer);
        if (!controller.signal.aborted) {
          setText(accumulated);
          setPhase("done");
          // the recorded answer must NOT carry the wire sentinel: every
          // downstream surface (thread page, knowledge inspector,
          // listings) reads this field raw, and only the live card ever
          // ran extractRunMeta
          const { text: bare } = extractRunMeta(accumulated);
          const { answer } = splitAnswerStream(bare);
          settleRun(tid, {
            runNo: 1,
            q,
            status: "done",
            mode: "overview",
            answer,
            startedAt,
            endedAt: Date.now(),
            finish: meta.finish,
            model: meta.model,
            usage: meta.usage,
            sources: sources.map((source) => ({ n: source.n, url: source.url, title: source.title })),
            tags: runTags,
          });
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setPhase(accumulated ? "done" : "error");
          const { text: bare } = extractRunMeta(accumulated);
          const { answer } = splitAnswerStream(bare);
          settleRun(tid, {
            runNo: 1,
            q,
            status: "error",
            mode: "overview",
            error: message,
            answer,
            startedAt,
            endedAt: Date.now(),
            sources: sources.map((source) => ({ n: source.n, url: source.url, title: source.title })),
            tags: runTags,
          });
        }
      });
  };

  const regenerate = () => {
    const last = lastAskRef.current;
    if (last && phase !== "streaming") {
      start(last.q, last.context, last.images, last.sources);
    }
  };

  const toggle = (q: string, context: string, images?: string[], sources?: OverviewSourceSeed[]) => {
    if (phase === "idle" || phase === "error") {
      start(q, context, images, sources);
      return;
    }
    if (phase === "streaming") {
      // collapse mid-stream: keep what already arrived as the settled
      // content — re-opening shows it without a refetch.  Stopping before
      // the first byte is a user stop, not an error: reset the entry.
      abortRef.current?.abort();
      setPhase(text ? "done" : "idle");
      setOpen((prev) => !prev);
      return;
    }
    setOpen((prev) => !prev);
  };

  const reset = () => {
    abortRef.current?.abort();
    lastAskRef.current = null;
    setPhase("idle");
    setText("");
    setSteps([]);
    setError(null);
    setOpen(false);
  };

  return {
    error,
    open,
    phase,
    query: lastAskRef.current?.q ?? "",
    start,
    steps,
    text,
    threadId,
    toggle,
    regenerate,
    reset,
  };
}

/** Meta-row entry (the 12px toggle tier of "found N results · took X s"). */
export function OverviewTrigger({
  phase,
  open,
  onToggle,
}: {
  phase: OverviewPhase;
  /** the card's visibility — the trigger is its disclosure */
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <button
      aria-controls="ai-answer-card"
      aria-expanded={open}
      className={`${META_TOGGLE} text-xs`}
      onClick={onToggle}
      type="button"
    >
      <Sparkles className="size-3 shrink-0" />
      {phase === "streaming"
        ? t("ai_overview_running")
        : phase === "error"
          ? t("ai_overview_failed")
          : t("ai_overview")}
      <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
  );
}

/** Header-sized copy chip: the shared useCopyToast path in an icon chip. */
function CopyChip({ value }: { value: string }) {
  const t = useT();
  const copyToast = useCopyToast();
  return (
    <button
      aria-label={t("copy")}
      className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2 transition-colors hover:text-ink"
      onClick={() => {
        copyToast(value);
      }}
      title={t("copy")}
      type="button"
    >
      <Copy className="size-3.5" />
    </button>
  );
}

const OVERVIEW_PREVIEW_PX = 224;

/** The Quick Answer card at the top of the answers area — the infobox's
    neutral panel language (`border-line bg-surface`) with an accent disc
    header instead of a tinted box: accent stays punctuation (icon, bullets,
    citation chips), not fill.  The reasoning renders as a block expanded
    live while the model thinks and folded once the answer starts
    (Google behaviour); a long overview settles truncated with a show-more pill.
    The header's refresh chip re-runs the question. */
export function OverviewCard({
  state,
  sourceMeta = [],
  onCite,
  q,
}: {
  state: OverviewState;
  /** favicon + domain + title per result, in citation order (position = [n]) */
  sourceMeta?: AiSourceMeta[];
  onCite?: (index: number) => void;
  /** the page query -- enables the deep-report upgrade action */
  q?: string;
}) {
  const t = useT();
  const { navigate, search } = useRouter();
  const [thinkForced, setThinkForced] = useState<boolean | null>(null);
  // the follow-up composer's draft
  const [followup, setFollowup] = useState("");
  // the compact process list's manual override
  const [processForced, setProcessForced] = useState<boolean | null>(null);
  // a regenerate / new query starts a fresh run: drop the manual fold so
  // the new run's reasoning follows the auto behaviour again
  useEffect(() => {
    if (state.phase === "streaming") {
      setThinkForced(null);
    }
  }, [state.phase]);
  // the raw-text stream's trailing meta sentinel (finish + usage + model)
  // is stripped before anything renders and surfaces as the run footer
  const { meta, text: bareText } = extractRunMeta(state.text);
  const { think, answer, thinking } = splitAnswerStream(bareText);
  const hasThink = think.trim().length > 0;
  const hasAnswer = answer.trim().length > 0;
  const streaming = state.phase === "streaming";
  // the reasoning block is expanded live while the model thinks and folds
  // once the answer starts arriving so the result takes over (manual
  // override wins)
  const thinkOpen = thinkForced ?? (thinking && !hasAnswer);
  const processOpen = processForced ?? (streaming && !hasAnswer);
  // a finished stream with neither answer nor reasoning content is a
  // failure; a user stop keeps the partial content without an error label
  const failed = state.phase === "error" || (state.phase === "done" && !hasAnswer && !hasThink);

  const markdown = useMemo(() => citeToLinks(holdBackTail(answer, !streaming)), [answer, streaming]);

  return (
    // the family pinned-card language (DESIGN.md §7, ZJBlog's ProjectCard):
    // one tape corner over the card's top edge + the deterministic
    // micro-tilt — the tape is a SIBLING of the card (§7 physics) and
    // print-hidden (the printed answer keeps its box, loses the tape);
    // the scroll target id lives on the wrapper (same geometry)
    <div className="relative" id="ai-answer-card">
      <Tape className="zjs-print-hide w-20 bg-accent-soft/60" seed={q ?? "ai-overview"} />
      <div className="-rotate-[0.35deg] animate-fade-up rounded-2xl border border-line bg-surface p-4">
        <div className="zjs-print-hide flex min-w-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
            <Sparkles className="size-3.5" />
          </span>
          <span className="text-sm font-medium text-ink">{t("ai_overview")}</span>
          {!streaming ? (
            <div className="ms-auto flex shrink-0 items-center gap-1.5">
              <button
                aria-label={t("regenerate")}
                className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2 transition-colors hover:text-ink"
                onClick={() => {
                  state.regenerate();
                }}
                title={t("regenerate")}
                type="button"
              >
                <RefreshCw className="size-3.5" />
              </button>
              {state.phase === "done" && hasAnswer ? (
                <CopyChip
                  value={buildAnswerMarkdown(
                    q || t("ai_overview"),
                    answer.trim(),
                    sourceMeta
                      .filter((source) => Number.isInteger(source.n))
                      .map((source) => ({ n: source.n as number, title: source.t, url: source.u })),
                    { sources: t("knowledge_inspector_sources") },
                  )}
                />
              ) : null}
              {state.phase === "done" && hasAnswer && q ? (
                <button
                  aria-label={t("ai_deep_report")}
                  className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2 transition-colors hover:text-ink"
                  onClick={() => {
                    void search({ q, ai: true, mode: "report" });
                  }}
                  title={t("ai_deep_report")}
                  type="button"
                >
                  <FileText className="size-3.5" />
                </button>
              ) : null}
              {/* downloads (MD/PDF) live in the knowledge base's inspector
                ONLY -- the answer surfaces stay read-and-ask */}
            </div>
          ) : null}
        </div>
        {state.steps.length > 0 ? (
          <div className="zjs-print-hide mt-2">
            <button
              aria-expanded={processOpen}
              className={`${META_TOGGLE} text-xs`}
              onClick={() => {
                setProcessForced(!processOpen);
              }}
              type="button"
            >
              <Search className="size-3 shrink-0" />
              {t("ai_overview_process")}
              <ChevronDown className={`size-3.5 transition-transform ${processOpen ? "rotate-180" : ""}`} />
            </button>
            <Collapse className={processOpen ? "mt-1" : ""} open={processOpen}>
              <div className="space-y-0.5 rounded-lg bg-surface-2/50 px-3 py-2">
                {state.steps.map((step) => (
                  <p className="truncate text-xs text-ink-3" key={step.id} title={step.label}>
                    {step.status === "pending" ? "… " : "✓ "}
                    {step.label}
                  </p>
                ))}
              </div>
            </Collapse>
          </div>
        ) : null}
        {hasThink ? (
          <div className="zjs-print-hide mt-2">
            <button
              aria-expanded={thinkOpen}
              className={`${META_TOGGLE} text-xs`}
              onClick={() => {
                setThinkForced(!thinkOpen);
              }}
              type="button"
            >
              <Brain className="size-3 shrink-0" />
              {t("ai_thinking")}
              <ChevronDown className={`size-3.5 transition-transform ${thinkOpen ? "rotate-180" : ""}`} />
            </button>
            <Collapse className={thinkOpen ? "mt-1" : ""} open={thinkOpen}>
              <ThinkScroll active={streaming && !hasAnswer} text={think} />
            </Collapse>
          </div>
        ) : null}
        {/* mt-2 unconditionally: without it a no-thinking answer sits flush
          under the header row (the thinking header carries the same margin,
          so both paths share the rhythm) */}
        {hasAnswer ? (
          // the long-form reading RECIPE on the results page's regular
          // body tier: the same shared MD document on the overview's
          // proportional root (.zjs-prose-overview — the 17px band scaled
          // by 14/17, so the tier ratio holds at every width) -- the
          // em-based recipe (headings/tables/code) scales the whole thing
          // proportionally, and the overview sits IN the snippet
          // column instead of towering over it
          <div className="zjs-prose-overview mt-2 text-ink">
            {streaming ? (
              // STREAMING: the growth lives INSIDE a bounded scroll pane
              // (tail-follow like the think pane; the cap matches the
              // settled preview) -- uncapped streaming pushed the results
              // below the card down on EVERY delta (the audit's CLS
              // finding: the card sits above the result list)
              <AnswerStreamPane active={streaming}>
                <MarkdownAnswer figureLightbox markdown={markdown} meta={sourceMeta} onCite={onCite} settled={false} />
              </AnswerStreamPane>
            ) : (
              // settled: the shared clamp-and-reveal takes over the
              // preview cap (the pane above ends at the same height, so
              // the hand-over does not jump)
              <ClampReveal
                active={state.phase === "done"}
                buttonClassName="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full border border-line py-2 text-[13px] font-medium text-ink-2 transition-colors hover:text-ink"
                previewPx={OVERVIEW_PREVIEW_PX}
              >
                <MarkdownAnswer
                  figureLightbox
                  markdown={markdown}
                  meta={sourceMeta}
                  onCite={onCite}
                  settled={state.phase === "done"}
                />
                {/* the run's meta line folds INTO show-more (the transport
                  outcome is detail, not headline) */}
                {!failed && meta ? (
                  <div className="mt-2">
                    <AiRunFooter finish={meta.finish ?? null} model={meta.model ?? null} usage={meta.usage ?? null} />
                  </div>
                ) : null}
                {/* the follow-up lives INSIDE the reveal (the reader's
                    "read, then ask" flow): the collapsed preview stays a
                    pure preview + toggle -- expanding to the full answer
                    is what surfaces the composer.  The question rides the
                    AI search with THIS answer as the conversation's
                    opening history -- a sessionStorage hand-off survives
                    the navigation (the staged attachments' exact channel)
                    and the takeover's first POST carries it, so the next
                    run builds on what's established */}
                {state.phase === "done" && q ? (
                  <form
                    className="zjs-print-hide mt-3 flex items-center gap-2 border-t border-line pt-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const question = followup.trim();
                      if (!question) {
                        return;
                      }
                      window.sessionStorage.setItem(
                        "zjs-overview-thread",
                        JSON.stringify({ q: question, thread: state.threadId }),
                      );
                      setFollowup("");
                      navigate(threadUrl(state.threadId));
                    }}
                  >
                    <input
                      aria-label={t("ai_followup_placeholder")}
                      className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent"
                      onChange={(event) => {
                        setFollowup(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) {
                          event.preventDefault();
                        }
                      }}
                      placeholder={t("ai_followup_placeholder")}
                      value={followup}
                    />
                    <button
                      aria-label={t("ai_followup_action")}
                      className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-strong text-accent-contrast transition-colors hover:bg-accent-strong-hover"
                      title={t("ai_followup_action")}
                      type="submit"
                    >
                      <ArrowUp aria-hidden="true" className="size-4" />
                    </button>
                  </form>
                ) : null}
              </ClampReveal>
            )}
          </div>
        ) : streaming && !hasThink ? (
          <p className="mt-2 text-xs text-ink-3">{t("ai_overview_running")}</p>
        ) : null}
        {failed ? (
          <div className="mt-2 text-xs text-danger">
            <p>{t("ai_overview_failed")}</p>
            {state.error ? (
              // the transport's own reason (HTTP status + upstream message),
              // truncated server-side — a broken endpoint must be readable
              <p className="mt-1 break-words text-danger/80" dir="auto">
                {state.error}
              </p>
            ) : null}
            {/* a transient failure (gateway hiccup, rate limit) is worth one
              click to re-run -- the retry re-asks the SAME question */}
            <button
              className={`mt-2 ${CHIP_ACCENT}`}
              onClick={() => {
                state.regenerate();
              }}
              type="button"
            >
              <RefreshCw aria-hidden="true" className="size-3.5" />
              {t("regenerate")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
