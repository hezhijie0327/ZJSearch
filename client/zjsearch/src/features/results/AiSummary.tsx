// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  ArrowUp,
  ArrowUpRight,
  Brain,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Children, isValidElement, memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Collapse } from "@/components/Collapse.tsx";
import { type AiSourceMeta, splitAnswerStream } from "@/features/results/aiAnswer.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { fetchStream } from "@/lib/http.ts";
import { useT } from "@/lib/i18n.ts";
import type { AiCapability } from "@/lib/types.ts";

/**
 * The whole-page AI Overview.  The server puts an {@link AiCapability}
 * into the page-data globals only when the feature is configured;
 * ResultsPage hosts the state (`useAiAnswer`) and renders the entry in the
 * results meta row (`AiAnswerTrigger`) plus the answer card at the top of
 * the answers area (`AiAnswerCard`).  The stream is plain text: the model's
 * reasoning arrives wrapped in <think>...</think> (rendered as a block that
 * is expanded live while the reasoning streams and folds once the answer
 * starts, height-capped and tail-following inside), the answer is markdown
 * (GFM) rendered through react-markdown with [n] citations rewritten into
 * `#ref-n` links that the `a` override turns into favicon-domain chips
 * which click-jump to the matching result row.  Follow-up questions replay
 * the prior turns; the timeline switcher browses them.  The LLM call
 * happens on click only; before the first streamed byte errors answer as
 * clean HTTP statuses (403 / 422 / 502).
 */

export type AiAnswerPhase = "idle" | "streaming" | "done" | "error";

/** One completed exchange, replayed to the model with every follow-up (the
    server stays stateless): question + the visible answer (thinking
    stripped). */
export interface AiHistoryTurn {
  a: string;
  q: string;
}

export interface AiAnswerState {
  phase: AiAnswerPhase;
  /** raw stream text: <think> block (when the model reasons) followed by
      the visible markdown answer with [n] citations */
  text: string;
  open: boolean;
  /** completed follow-up turns; the live answer is the +1 entry of the
      timeline (history + current), which viewIndex points into */
  history: AiHistoryTurn[];
  viewIndex: number;
  /** ask the question for the current results (or re-ask after an error) */
  start: (q: string, context: string, images?: string[]) => void;
  toggle: (q: string, context: string, images?: string[]) => void;
  /** step through the answer timeline: -1 = previous, +1 = next */
  go: (delta: number) => void;
  /** ask a follow-up: the prior turns (incl. the answer on screen) travel
      with the request, so a short question like 换成表格 or 画成流程图
      restyles or extends the previous answer */
  followUp: (q: string) => void;
  /** re-run the last question against the same results */
  regenerate: () => void;
  /** drop everything (a new search invalidates the answer) */
  reset: () => void;
}

/** ResultsPage-level state: the trigger chip lives in the results meta row,
    the card at the top of the answers area — one hook owns the stream so
    both stay in sync.  Same abort discipline everywhere: the controller is
    captured at start, aborted on unmount / re-ask / collapse, and every
    settled callback re-checks the signal. */
export function useAiAnswer(capability: AiCapability | undefined, lang: string): AiAnswerState {
  const [phase, setPhase] = useState<AiAnswerPhase>("idle");
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<AiHistoryTurn[]>([]);
  const [viewIndex, setViewIndex] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const lastAskRef = useRef<{ context: string; history: AiHistoryTurn[]; images: string[]; q: string } | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = (q: string, context: string, images: string[] = [], history: AiHistoryTurn[] = []) => {
    if (!capability) {
      return;
    }
    abortRef.current?.abort();
    lastAskRef.current = { context, history, images, q };
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("streaming");
    setText("");
    setOpen(true);
    setHistory(history);
    setViewIndex(history.length); // a new stream is always the newest view
    let accumulated = "";
    void fetchStream(
      "/ai/answer",
      { context, history, images, lang, q, tk: capability.tk },
      (chunk) => {
        accumulated += chunk;
        if (!controller.signal.aborted) {
          setText(accumulated);
        }
      },
      controller.signal,
    )
      .then(() => {
        if (!controller.signal.aborted) {
          setPhase("done");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPhase(accumulated ? "done" : "error");
        }
      });
  };

  const go = (delta: number) => {
    const total = history.length + (text.trim() ? 1 : 0);
    if (total < 1) {
      return;
    }
    setViewIndex((index) => Math.min(Math.max(index + delta, 0), total - 1));
  };

  const followUp = (q: string) => {
    const last = lastAskRef.current;
    if (!capability || !last || phase !== "done" || !text.trim()) {
      return;
    }
    // the visible answer (thinking stripped) becomes the model's prior turn
    const { answer } = splitAnswerStream(text);
    if (!answer.trim()) {
      return;
    }
    start(q, last.context, last.images, [...last.history, { a: answer, q: last.q }]);
  };

  const regenerate = () => {
    const last = lastAskRef.current;
    if (last && phase !== "streaming") {
      start(last.q, last.context, last.images, last.history);
    }
  };

  const toggle = (q: string, context: string, images?: string[]) => {
    if (phase === "idle" || phase === "error") {
      start(q, context, images);
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
    setOpen(false);
    setHistory([]);
    setViewIndex(0);
  };

  return { followUp, go, history, open, phase, regenerate, reset, start, text, toggle, viewIndex };
}

/** Meta-row entry (the 12px toggle tier of 「found N results · took X s」). */
export function AiAnswerTrigger({ phase, onToggle }: { phase: AiAnswerPhase; onToggle: () => void }) {
  const t = useT();
  return (
    <button
      className="inline-flex min-h-6 items-center gap-1 transition-colors hover:text-ink"
      onClick={onToggle}
      type="button"
    >
      <Sparkles className="size-3 shrink-0" />
      {phase === "streaming" ? t("ai_answering") : phase === "error" ? t("ai_answer_failed") : t("ai_answer")}
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

const CITATION = /\[(\d+(?:\s*[,，]\s*\d+)*)\]|\[\*\]/g;

/** Rewrite [n] / [n,m] citations into `#ref-n` links (one link per number)
    that the markdown `a` override renders as citation chips.  `[*]` stays
    literal text. */
function citeToLinks(text: string): string {
  return text.replace(CITATION, (_match, group) => {
    if (!group) {
      return _match;
    }
    return group
      .split(/\s*[,，]\s*/)
      .map((n: string) => `[${n}](#ref-${n})`)
      .join("");
  });
}

/** Compact [n] citation chip: hovering opens a floating preview panel with
    the source favicon, site and title (portalled to <body> so the clamp
    wrapper's overflow-hidden cannot clip it); clicking jumps to the
    matching result row.  Moving between chip and panel keeps it open. */
function CitationChip({ n, source, onCite }: { n: number; source: AiSourceMeta; onCite?: (index: number) => boolean }) {
  const [panel, setPanel] = useState<{ x: number; y: number } | null>(null);
  const hideTimer = useRef<number | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);

  const keepPanel = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const closeSoon = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
    }
    hideTimer.current = window.setTimeout(() => {
      setPanel(null);
      hideTimer.current = null;
    }, 120);
  };

  const openPanel = () => {
    keepPanel();
    const rect = chipRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    // keep the floating panel inside the viewport
    const x = Math.max(8, Math.min(rect.left, window.innerWidth - 336));
    const y = rect.bottom + 8 + 150 <= window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - 158);
    setPanel({ x, y });
  };

  useEffect(
    () => () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
      }
    },
    [],
  );

  return (
    <>
      <button
        className="mx-0.5 inline-flex items-center rounded align-middle text-xs text-accent transition-colors hover:text-accent-hover hover:underline underline-offset-2"
        onClick={() => {
          onCite?.(n);
          setPanel(null);
        }}
        onMouseEnter={openPanel}
        onMouseLeave={closeSoon}
        ref={chipRef}
        type="button"
      >
        [{n}]
      </button>
      {panel
        ? createPortal(
            <div
              className="fixed z-50 w-80 cursor-pointer rounded-2xl border border-line bg-surface p-3 shadow-pop"
              onClick={() => {
                onCite?.(n);
                setPanel(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onCite?.(n);
                  setPanel(null);
                }
              }}
              onMouseEnter={keepPanel}
              onMouseLeave={closeSoon}
              role="button"
              style={{ left: panel.x, top: panel.y }}
              tabIndex={0}
            >
              <div className="flex items-center gap-1.5 text-xs text-ink-3">
                {source.favicon ? (
                  <img alt="" className="size-4 rounded-full object-contain" src={source.favicon} />
                ) : null}
                <span className="truncate">{source.domain}</span>
                <a
                  aria-label="open"
                  className="ms-auto inline-flex items-center rounded p-0.5 transition-colors hover:bg-surface-2 hover:text-accent"
                  href={source.u}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                  rel="noreferrer"
                  target="_blank"
                  title={source.u}
                >
                  <ArrowUpRight className="size-3.5" />
                </a>
              </div>
              <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-ink">{source.t}</p>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
const HEADING = "mt-3 text-base font-semibold text-ink first:mt-0";

const CODE_BLOCK = "mt-2 overflow-x-auto rounded-xl bg-surface-2 p-3 font-mono text-xs leading-relaxed text-ink";

let mermaidSeq = 0;

/** A settled ```mermaid fence renders as a diagram: the mermaid package
    (heavy) is imported only when a block actually exists, the theme follows
    the palette, and a chart the parser rejects falls back to a plain code
    block.  The card only mounts this once its stream has settled -- the
    fence grows chunk by chunk while streaming, and re-rendering the SVG on
    every chunk reads as flicker (the streaming view is the code fallback). */
function MermaidBlock({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const dark =
          document.documentElement.classList.contains("dark") || document.documentElement.classList.contains("black");
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral" });
        const rendered = await mermaid.render(`zjs-mmd-${(mermaidSeq++).toString(36)}`, chart);
        if (!cancelled) {
          setSvg(rendered.svg);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chart]);
  if (svg) {
    return (
      <div
        className="zjs-mermaid mt-2 overflow-x-auto rounded-xl bg-surface-2 p-3"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  if (failed) {
    return <pre className={CODE_BLOCK}>{chart}</pre>;
  }
  return <div className="zjs-mermaid mt-2 min-h-24 rounded-xl bg-surface-2" />;
}

/** The text content of a react-markdown code child (the raw fence body). */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  if (isValidElement(node)) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

function markdownComponents(
  meta: AiSourceMeta[],
  onCite: ((index: number) => boolean) | undefined,
  settled: boolean,
): Record<
  string,
  (props: { alt?: string; children?: ReactNode; className?: string; href?: string; src?: string }) => ReactNode
> {
  const heading = ({ children }: { children?: ReactNode }) => (
    <h3 className={HEADING} dir="auto">
      {children}
    </h3>
  );
  const external = ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a
      className="text-accent underline-offset-2 transition-colors hover:text-accent-hover hover:underline"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
  return {
    a: ({ children, href }) => {
      const m = /^#ref-(\d+)$/.exec(href ?? "");
      if (!m) {
        return external({ children, href });
      }
      const n = Number.parseInt(m[1] ?? "", 10);
      if (Number.isNaN(n)) {
        return external({ children, href });
      }
      const source = meta[n - 1];
      if (!source) {
        return <span className="rounded bg-surface-2 px-1 text-xs text-ink-2">[{n}]</span>;
      }
      // compact [n] whose hover opens the source preview panel
      return <CitationChip n={n} onCite={onCite} source={source} />;
    },
    code: ({ className, children }) =>
      className ? (
        <code className={className}>{children}</code>
      ) : (
        <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{children}</code>
      ),
    h1: heading,
    h2: heading,
    h3: heading,
    img: ({ alt, src }) => (
      <img alt={alt ?? ""} className="my-2 max-w-full rounded-xl border border-line" loading="lazy" src={src} />
    ),
    li: ({ children }) => (
      <li className="marker:text-accent" dir="auto">
        {children}
      </li>
    ),
    ol: ({ children }) => <ol className="ms-5 list-decimal space-y-1">{children}</ol>,
    p: ({ children }) => <p dir="auto">{children}</p>,
    pre: ({ children }) => {
      // a settled ```mermaid fence becomes a rendered diagram -- while the
      // stream is still growing into the fence it stays a code block (a
      // diagram re-rendered on every chunk reads as flicker); every other
      // block keeps the mono chrome of the 12px tier
      const child = Children.toArray(children).find(isValidElement);
      const props = child?.props as { children?: ReactNode; className?: string } | undefined;
      if ((props?.className ?? "").includes("language-mermaid")) {
        if (!settled) {
          return <pre className={CODE_BLOCK}>{props?.children}</pre>;
        }
        return <MermaidBlock chart={textOf(props?.children)} />;
      }
      return <pre className={CODE_BLOCK}>{children}</pre>;
    },
    table: ({ children }) => (
      <table className="my-2 w-full border-collapse text-xs" dir="auto">
        {children}
      </table>
    ),
    td: ({ children }) => <td className="border border-line px-2 py-1 align-top">{children}</td>,
    th: ({ children }) => (
      <th className="border border-line bg-surface-2 px-2 py-1 text-start font-medium">{children}</th>
    ),
    ul: ({ children }) => <ul className="ms-5 list-disc space-y-1">{children}</ul>,
  };
}

/** The answer body, memoized: the card re-renders on every clamp
    measurement (contentPx), and a fresh components object made
    react-markdown rebuild the whole tree each time -- which remounted
    MermaidBlock and reset its svg/failed state on every tick, flickering
    the answer (and any diagram) for as long as the content height kept
    changing.  Stable props (markdown text, per-result meta, settled) keep
    the subtree untouched by measurement churn. */
const MarkdownAnswer = memo(function MarkdownAnswer({
  markdown,
  meta,
  onCite,
  settled,
}: {
  markdown: string;
  meta: AiSourceMeta[];
  onCite?: (index: number) => boolean;
  settled: boolean;
}) {
  return (
    <Markdown components={markdownComponents(meta, onCite, settled)} remarkPlugins={[remarkGfm]}>
      {markdown}
    </Markdown>
  );
});

/** The capped reasoning scroll area: while the stream runs it keeps the
    newest line in view (no-op once settled or folded). */
function ThinkScroll({ active, text }: { active: boolean; text: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the live stream tail
  useEffect(() => {
    if (active && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [active, text]);
  return (
    <div
      className="max-h-32 overflow-y-auto pe-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-3"
      dir="auto"
      ref={scrollRef}
    >
      {text.trim()}
    </div>
  );
}

/** The Quick Answer card at the top of the answers area — the infobox's
    neutral panel language (`border-line bg-surface`) with an accent disc
    header instead of a tinted box: accent stays punctuation (icon, bullets,
    citation chips), not fill.  The reasoning renders as a block expanded
    live while the model thinks and folded once the answer starts
    (Google behaviour); a long overview settles truncated with a 展开 pill.
    The header's refresh chip re-runs the question. */
export function AiAnswerCard({
  state,
  sourceMeta = [],
  onCite,
}: {
  state: AiAnswerState;
  /** favicon + domain + title per result, in citation order (position = [n]) */
  sourceMeta?: AiSourceMeta[];
  onCite?: (index: number) => boolean;
}) {
  const t = useT();
  const [thinkForced, setThinkForced] = useState<boolean | null>(null);
  const [overviewExpanded, setOverviewExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const live = splitAnswerStream(state.text);
  // the answer timeline: completed follow-up turns + the live one; viewIndex
  // points into it (clamped here -- a new stream always lands on the newest
  // view), historical turns are stored thinking-stripped
  const total = state.history.length + (state.text.trim() ? 1 : 0);
  const viewIndex = Math.min(state.viewIndex, Math.max(total - 1, 0));
  const viewingLatest = viewIndex >= state.history.length;
  const think = viewingLatest ? live.think : "";
  const thinking = viewingLatest ? live.thinking : false;
  const answer = viewingLatest ? live.answer : (state.history[viewIndex]?.a ?? "");
  const hasThink = think.trim().length > 0;
  const hasAnswer = answer.trim().length > 0;
  const streaming = state.phase === "streaming";
  // the reasoning block is expanded live while the model thinks and folds
  // once the answer starts arriving so the result takes over (manual
  // override wins)
  const thinkOpen = thinkForced ?? (thinking && !hasAnswer);
  // a finished stream with neither answer nor reasoning content is a
  // failure; a user stop keeps the partial content without an error label
  const failed = state.phase === "error" || (state.phase === "done" && !hasAnswer && !hasThink);

  const markdown = useMemo(() => citeToLinks(answer), [answer]);
  const overviewRef = useRef<HTMLDivElement | null>(null);
  const [contentPx, setContentPx] = useState<number | null>(null);

  // the measured node mounts with the answer (it does not exist before the
  // first chunk), so the observer attaches when it appears -- a mount-only
  // effect would measure nothing on the click -> stream -> done path
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the measured node mounts
  useEffect(() => {
    const el = overviewRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => {
      // +1 guards against sub-pixel rounding clipping the last text line
      setContentPx(Math.ceil(el.getBoundingClientRect().height) + 1);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [hasAnswer]);

  // content that fits the preview needs no clamp, gradient or toggle
  const needsClamp = state.phase === "done" && contentPx !== null && contentPx > OVERVIEW_PREVIEW_PX + 24;

  // expanded: the cap rides at contentPx while the 300ms ease plays, then is
  // lifted entirely -- late content growth (a mermaid svg that renders after
  // the measurement, fonts, view switches) must never sit under a stale cap.
  // collapsing re-applies the cap at the fresh contentPx first (same visual
  // height) so the ease down to the preview interpolates instead of snapping.
  const [expandCapless, setExpandCapless] = useState(false);
  const toggleExpanded = () => {
    if (overviewExpanded) {
      setExpandCapless(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setOverviewExpanded(false);
        });
      });
    } else {
      setExpandCapless(false);
      setOverviewExpanded(true);
    }
  };

  return (
    <div className="animate-fade-up rounded-2xl border border-line bg-surface p-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
          <Sparkles className="size-3.5" />
        </span>
        <span className="text-[13px] font-medium text-ink">{t("ai_answer")}</span>
        {/* the turn switcher lives inline in the header: appearing and
            disappearing takes only horizontal space, the card never shifts */}
        {total > 1 ? (
          <div className="flex items-center gap-0.5 text-xs text-ink-3">
            <button
              aria-label={t("ai_prev_answer")}
              className="inline-flex min-h-6 items-center rounded px-1 transition-colors hover:text-ink disabled:opacity-40"
              disabled={viewIndex <= 0}
              onClick={() => {
                state.go(-1);
              }}
              type="button"
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <span className="min-h-6 leading-6 tabular-nums">
              {viewIndex + 1} / {total}
            </span>
            <button
              aria-label={t("ai_next_answer")}
              className="inline-flex min-h-6 items-center rounded px-1 transition-colors hover:text-ink disabled:opacity-40"
              disabled={viewIndex >= total - 1}
              onClick={() => {
                state.go(1);
              }}
              type="button"
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        ) : null}
        {!streaming ? (
          <div className="ms-auto flex shrink-0 items-center gap-1.5">
            {viewingLatest ? (
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
            ) : null}
            {state.phase === "done" && hasAnswer ? <CopyChip value={answer.trim()} /> : null}
          </div>
        ) : null}
      </div>
      {hasThink ? (
        <div className="mt-2">
          <button
            aria-expanded={thinkOpen}
            className="inline-flex min-h-6 items-center gap-1 text-xs text-ink-3 transition-colors hover:text-ink"
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
      {hasAnswer ? (
        <div className={`${hasThink ? "mt-2 " : ""}text-sm leading-relaxed text-ink`}>
          <div
            className="relative overflow-hidden transition-[max-height] duration-300 ease-out"
            onTransitionEnd={(event) => {
              if (event.propertyName === "max-height" && overviewExpanded) {
                setExpandCapless(true);
              }
            }}
            style={{
              maxHeight: needsClamp
                ? overviewExpanded
                  ? expandCapless
                    ? undefined
                    : (contentPx ?? OVERVIEW_PREVIEW_PX)
                  : OVERVIEW_PREVIEW_PX
                : (contentPx ?? undefined),
            }}
          >
            <div ref={overviewRef}>
              <MarkdownAnswer markdown={markdown} meta={sourceMeta} onCite={onCite} settled={state.phase === "done"} />
            </div>
            {needsClamp ? (
              <div
                className={`pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent transition-opacity duration-300 ${
                  overviewExpanded ? "opacity-0" : "opacity-100"
                }`}
              />
            ) : null}
          </div>
          {needsClamp ? (
            <button
              aria-expanded={overviewExpanded}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full border border-line py-2 text-[13px] font-medium text-ink-2 transition-colors hover:text-ink"
              onClick={toggleExpanded}
              type="button"
            >
              {overviewExpanded ? t("collapse") : t("expand")}
              <ChevronDown className={`size-3.5 transition-transform ${overviewExpanded ? "rotate-180" : ""}`} />
            </button>
          ) : null}
        </div>
      ) : streaming && !hasThink ? (
        <p className="mt-2 text-xs text-ink-3">{t("ai_answering")}</p>
      ) : null}
      {failed ? <p className="mt-2 text-xs text-danger">{t("ai_answer_failed")}</p> : null}
      {state.phase === "done" && hasAnswer ? (
        <form
          className="mt-3 flex items-center gap-2 border-t border-line pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            const q = draft.trim();
            if (!q) {
              return;
            }
            state.followUp(q);
            setDraft("");
          }}
        >
          <input
            className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface-2 px-4 text-[13px] text-ink transition-colors placeholder:text-ink-3 focus:border-accent-strong focus:outline-none"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder={t("ai_followup")}
            value={draft}
          />
          <button
            aria-label={t("send")}
            className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-contrast transition-opacity disabled:opacity-40"
            disabled={!draft.trim()}
            type="submit"
          >
            <ArrowUp className="size-4.5" />
          </button>
        </form>
      ) : null}
    </div>
  );
}
