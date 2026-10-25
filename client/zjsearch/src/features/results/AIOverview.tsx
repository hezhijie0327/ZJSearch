// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// KaTeX typography for the math pipeline (lazy-loaded plugins, css is small
// enough to ride the results stylesheet; the woff2 fonts load on demand)
import "katex/dist/katex.min.css";

import { ArrowUp, ArrowUpRight, Brain, ChevronDown, Copy, FileText, RefreshCw, Search, Sparkles } from "lucide-react";
import { Children, isValidElement, memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import type { PluggableList } from "unified";
import { ClampReveal } from "@/components/ClampReveal.tsx";
import { Collapse } from "@/components/Collapse.tsx";
import { Tape } from "@/components/Tape.tsx";
import { AiRunFooter } from "@/features/results/AiRunFooter.tsx";
import {
  type AiSearchGallery,
  type AiSourceMeta,
  extractRunMeta,
  splitAnswerStream,
} from "@/features/results/aiOverview.ts";
import { AnswerGallery, renderWithGalleries } from "@/features/results/aiSearch/AnswerGallery.tsx";
import { Lightbox, type LightboxItem } from "@/features/results/aiSearch/AttachmentLightbox.tsx";
import { citeToLinks } from "@/lib/citations.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { cn } from "@/lib/cn.ts";
import { buildAnswerMarkdown } from "@/lib/exporters.ts";
import { fetchStream } from "@/lib/http.ts";
import { useT } from "@/lib/i18n.ts";
import { appendRunEvents } from "@/lib/kb/events.ts";
import { settleRun, startRun } from "@/lib/kb/projections.ts";
import { newThreadId, threadUrl } from "@/lib/kb/shared.ts";
import { holdBackTail, MD, SHARED_REMARK } from "@/lib/markdownParts.ts";
import { useRouter } from "@/lib/router.tsx";
import { CHIP_ACCENT, HOVER_CHIP, META_TOGGLE } from "@/lib/styles.ts";
import type { AiCapability } from "@/lib/types.ts";

/** mermaid is initialized ONCE per palette (global state — re-running
    initialize per rendered block per theme flip is wasted work); the lazy
    import only happens when an answer really carries a diagram. */
let mermaidInitKey: string | null = null;
async function mermaidFor(dark: boolean) {
  const mermaid = (await import("mermaid")).default;
  const key = dark ? "dark" : "neutral";
  if (mermaidInitKey !== key) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      fontFamily: "var(--font-sans)",
      theme: key,
    });
    mermaidInitKey = key;
  }
  return mermaid;
}

/** The base remark plugin set -- the shared chain SHARED_REMARK
    (lib/markdownParts.ts, DESIGN.md
    §5.1 family contract): the syntax the prompt teaches and the syntax
    rendered here must mirror each other exactly -- a taught-but-unrendered
    construct bleeds raw into the page, a rendered-but-unteached path is an
    open door for untrusted output
    (GFM / ==mark== / emoji shortcode / callouts / definition lists); the
    KaTeX math
    pipeline lazy-loads for size, see MarkdownAnswer. */

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
          const { answer } = splitAnswerStream(accumulated);
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
          const { answer } = splitAnswerStream(accumulated);
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

/** The props react-markdown hands to component overrides (hast props, whose
    shape varies per tag -- hence the index signature). */
type MdProps = {
  alt?: string;
  children?: ReactNode;
  className?: string;
  href?: string;
  src?: string;
  [key: string]: unknown;
};

/** The citation chips' shared hover-panel state: open on hover/focus with
    the anchor's rect (kept inside the viewport), a 120ms grace when the
    pointer leaves (moving onto the panel keeps it), unmount clears the
    timer.  Both the single chip and the group pill ride it. */
function useFloatPanel() {
  const [panel, setPanel] = useState<{ x: number; y: number; w: number } | null>(null);
  const hideTimer = useRef<number | null>(null);

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

  const openPanel = (anchor: HTMLElement | null, width: number, height: number) => {
    keepPanel();
    const rect = anchor?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    // keep the floating panel inside the viewport
    const x = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const y = rect.bottom + 8 + height <= window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - height - 8);
    setPanel({ x, y, w: width });
  };

  useEffect(
    () => () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
      }
    },
    [],
  );

  return { panel, openPanel, keepPanel, closeSoon, close: () => setPanel(null) };
}

/** Compact [n] citation chip: hovering opens a floating preview panel with
    the source favicon, site and title (portalled to <body> so the clamp
    wrapper's overflow-hidden cannot clip it); clicking jumps to the
    matching result row.  Moving between chip and panel keeps it open. */
function CitationChip({ n, source, onCite }: { n: number; source: AiSourceMeta; onCite?: (index: number) => void }) {
  const t = useT();
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const float = useFloatPanel();
  return (
    <>
      <button
        aria-label={`${t("open_source")} ${n}`}
        className="mx-0.5 inline-flex items-center rounded align-middle text-xs text-accent transition-colors hover:text-accent-hover hover:underline underline-offset-2"
        onBlur={float.closeSoon}
        onClick={() => {
          onCite?.(n);
          float.close();
        }}
        onFocus={() => float.openPanel(chipRef.current, 320, 150)}
        onMouseEnter={() => float.openPanel(chipRef.current, 320, 150)}
        onMouseLeave={float.closeSoon}
        ref={chipRef}
        type="button"
      >
        [{n}]
      </button>
      {float.panel
        ? createPortal(
            <div
              className="fixed z-50 cursor-pointer rounded-2xl border border-line bg-surface p-3 shadow-pop"
              onClick={() => {
                onCite?.(n);
                float.close();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onCite?.(n);
                  float.close();
                }
              }}
              onMouseEnter={float.keepPanel}
              onMouseLeave={float.closeSoon}
              role="button"
              style={{ left: float.panel.x, top: float.panel.y, width: float.panel.w }}
              tabIndex={0}
            >
              <div className="flex items-center gap-1.5 text-xs text-ink-3">
                {source.favicon ? (
                  <img alt="" className="size-4 rounded-full object-contain" src={source.favicon} />
                ) : null}
                <span className="truncate">{source.domain}</span>
                <a
                  aria-label={t("open_source")}
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

/** The GROUP pill ([1,2]): one button where the adjacent single chips used
    to cluster -- hovering/focusing opens a panel listing every member
    source (favicon + domain + title row), and each row jumps to the rail's
    matching #n card.  Members without a source behind them (phantoms) do
    not get a row; a group with NO resolvable member renders as the static
    fallback span (the `a` branch handles that before mounting this). */
function CitationGroupChip({
  nums,
  sources,
  onCite,
}: {
  nums: number[];
  sources: Array<AiSourceMeta | undefined>;
  onCite?: (index: number) => void;
}) {
  const t = useT();
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const float = useFloatPanel();
  const rows = nums.map((n, i) => ({ n, source: sources[i] })).filter((row) => row.source);
  return (
    <>
      <button
        aria-expanded={float.panel !== null}
        aria-label={`${t("open_source")} ${nums.join(",")}`}
        className="mx-0.5 inline-flex items-center rounded align-middle text-xs text-accent transition-colors hover:text-accent-hover hover:underline underline-offset-2"
        onBlur={float.closeSoon}
        onClick={() => {
          // keyboard/touch activation opens the panel; a row click jumps
          const first = rows[0];
          if (first && float.panel) {
            onCite?.(first.n);
            float.close();
          } else {
            float.openPanel(chipRef.current, 320, Math.min(48 + rows.length * 44, 220));
          }
        }}
        onFocus={() => float.openPanel(chipRef.current, 320, Math.min(48 + rows.length * 44, 220))}
        onMouseEnter={() => float.openPanel(chipRef.current, 320, Math.min(48 + rows.length * 44, 220))}
        onMouseLeave={float.closeSoon}
        ref={chipRef}
        type="button"
      >
        [{nums.join(",")}]
      </button>
      {float.panel
        ? createPortal(
            <div
              aria-label={t("open_source")}
              className="fixed z-50 rounded-2xl border border-line bg-surface p-2 shadow-pop"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  float.close();
                }
              }}
              onMouseEnter={float.keepPanel}
              onMouseLeave={float.closeSoon}
              role="group"
              style={{ left: float.panel.x, top: float.panel.y, width: float.panel.w }}
              tabIndex={-1}
            >
              <div className="space-y-1">
                {rows.map(({ n, source }) => (
                  <button
                    className="flex w-full items-start gap-2 rounded-xl p-1.5 text-start transition-colors hover:bg-surface-2"
                    key={n}
                    onClick={() => {
                      onCite?.(n);
                      float.close();
                    }}
                    type="button"
                  >
                    {source?.favicon ? (
                      <img alt="" className="mt-0.5 size-4 shrink-0 rounded-full object-contain" src={source.favicon} />
                    ) : (
                      <span aria-hidden="true" className="mt-0.5 size-4 shrink-0 rounded-full bg-surface-2" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-ink-3">
                        {source?.domain}
                        <span className="ms-1 text-ink-2">#{n}</span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-ink">{source?.t}</span>
                    </span>
                    <ArrowUpRight aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-ink-3" />
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
const CODE_BLOCK = MD.pre;

/** A fenced code block with a hover copy button (ZJBlog's code-card
    language): the shared clipboard+toast path in a corner chip. */
function CodeBlock({ children }: { children: ReactNode }) {
  const t = useT();
  const copyToast = useCopyToast();
  const ref = useRef<HTMLPreElement | null>(null);
  return (
    <div className="group relative">
      <pre className={CODE_BLOCK} ref={ref}>
        {children}
      </pre>
      <button
        aria-label={t("copy")}
        className={`absolute end-2 top-2 ${HOVER_CHIP}`}
        onClick={() => {
          copyToast(ref.current?.textContent ?? "");
        }}
        title={t("copy")}
        type="button"
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

function isDarkTheme(): boolean {
  return document.documentElement.classList.contains("dark") || document.documentElement.classList.contains("black");
}

let mermaidSeq = 0;

/** A settled ```mermaid fence renders as a diagram: the mermaid package
    (heavy) is imported only when a block actually exists, the theme follows
    the palette (html class watch -- a mid-view flip re-renders the svg),
    rendering waits for the viewport (300px buffer, tall diagrams below the
    fold never pay; beforeprint forces it so a print never shows empty
    placeholders), and a chart the parser rejects falls back to a plain
    code block (parse() runs first -- a failed render can litter the DOM).
    The card only mounts this once its stream has settled -- the fence grows
    chunk by chunk while streaming, and re-rendering the SVG on every chunk
    reads as flicker (the streaming view is the code fallback).  The chart
    source rides a data-zjs-mermaid attribute so the print view can render
    its own LIGHT copies off-screen (print.css's token force cannot recolor
    a baked svg, and re-rendering in place would flash the live page). */
export function MermaidBlock({ chart, lightbox = false }: { chart: string; lightbox?: boolean }) {
  const t = useT();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [nearViewport, setNearViewport] = useState(
    () => typeof window !== "undefined" && !("IntersectionObserver" in window),
  );
  const [theme, setTheme] = useState(() => isDarkTheme());

  // Load only once in the viewport (with a 300px buffer) -- offscreen
  // figures in a long answer never pay for nothing
  useEffect(() => {
    const el = containerRef.current;
    if (!el || nearViewport) {
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true);
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [nearViewport]);

  // A figure never scrolled to prints as an empty placeholder -- best
  // effort, trigger one render
  useEffect(() => {
    const onBeforePrint = () => {
      setNearViewport(true);
    };
    window.addEventListener("beforeprint", onBeforePrint);
    return () => {
      window.removeEventListener("beforeprint", onBeforePrint);
    };
  }, []);

  // Re-render in the new palette after a theme flip (html class swap,
  // including auto following the system)
  useEffect(() => {
    const mo = new MutationObserver(() => {
      setTheme(isDarkTheme());
    });
    mo.observe(document.documentElement, { attributeFilter: ["class"] });
    return () => {
      mo.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!nearViewport) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const mermaid = await mermaidFor(theme);
        await mermaid.parse(chart);
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
  }, [nearViewport, chart, theme]);
  if (svg) {
    return (
      // data-zjs-figure is the delegation entry marker of the figure
      // lightbox (only the figureLightbox reading panes carry it,
      // self-managed surfaces like the deck do not); matching the whole
      // card (whitespace included) beats matching just the svg
      <div
        aria-label={t("ai_figure")}
        className={cn("zjs-mermaid mt-2 overflow-x-auto rounded-xl bg-surface-2 p-3", lightbox && "cursor-zoom-in")}
        dangerouslySetInnerHTML={{ __html: svg }}
        data-zjs-figure={lightbox || undefined}
        data-zjs-mermaid={chart}
        role="img"
      />
    );
  }
  if (failed) {
    return <CodeBlock>{chart}</CodeBlock>;
  }
  return (
    <div className="zjs-mermaid mt-2 min-h-24 rounded-xl bg-surface-2" data-zjs-mermaid={chart} ref={containerRef} />
  );
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
  onCite: ((index: number) => void) | undefined,
  settled: boolean,
  figureLightbox: boolean,
): Record<string, (props: MdProps) => ReactNode> {
  // the family editorial levels (DESIGN.md §5.1): serif, weighted by depth
  const heading = (level: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
    function Heading({ children, className }: MdProps) {
      const Tag = level as "h3";
      // an incoming class rides along -- the GFM footnotes' sr-only
      // section label is the one producer, and stripping it would paint
      // an a11y-only heading in full serif
      return (
        <Tag className={className ? `${MD[level]} ${className}` : MD[level]} dir="auto">
          {children}
        </Tag>
      );
    };
  const external = ({ children, href }: MdProps) => (
    <a className={MD.a} href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
  return {
    a: ({ children, href }) => {
      const g = /^#refs-([\d.]+)$/.exec(href ?? "");
      if (g) {
        // the citation GROUP pill (citations.ts emits one #refs-a.b link
        // per [a,b] match): members resolve positionally like single chips
        const nums = (g[1] ?? "")
          .split(".")
          .map((part) => Number.parseInt(part, 10))
          .filter((n) => Number.isInteger(n) && n > 0);
        const sources = nums.map((n) => meta[n - 1]);
        if (nums.length > 1 && sources.some(Boolean)) {
          return <CitationGroupChip nums={nums} onCite={onCite} sources={sources} />;
        }
        return external({ children, href });
      }
      const m = /^#ref-(\d+)$/.exec(href ?? "");
      if (!m) {
        // an in-page anchor (the GFM footnotes' refs and back-refs are the
        // chain's producers): a plain same-document jump -- external's
        // target="_blank" would open this very page in a new tab
        if (href?.startsWith("#")) {
          return (
            <a className={MD.a} href={href}>
              {children}
            </a>
          );
        }
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
    blockquote: ({ children }) => <blockquote className={MD.blockquote}>{children}</blockquote>,
    code: ({ className, children }) =>
      className ? <code className={className}>{children}</code> : <code className={MD.code}>{children}</code>,
    dd: ({ children }) => <dd className={MD.dd}>{children}</dd>,
    dt: ({ children }) => <dt className={MD.dt}>{children}</dt>,
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    h5: heading("h5"),
    h6: heading("h6"),
    img: ({ alt, src }) => <img alt={alt ?? ""} className={MD.img} loading="lazy" src={src} />,
    hr: () => <hr className={MD.hr} />,
    li: ({ children }) => (
      <li className={MD.li} dir="auto">
        {children}
      </li>
    ),
    mark: ({ children }) => <mark className={MD.mark}>{children}</mark>,
    ol: ({ children }) => <ol className={MD.ol}>{children}</ol>,
    p: ({ children, className }) => (
      <p className={className ? `${MD.p} ${className}` : MD.p} dir="auto">
        {children}
      </p>
    ),
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
        // the lightbox follows the reading pane -- the data-zjs-figure
        // marker is FigureLightboxRoot
        // delegation's entry (the blog side's same wiring: the Prose mount
        // passes lightbox)
        return <MermaidBlock chart={textOf(props?.children)} lightbox={figureLightbox} />;
      }
      return <CodeBlock>{children}</CodeBlock>;
    },
    section: ({ children, className }) =>
      // the GFM footnotes block (the shared chain's only section
      // producer): the answer's asides collect at the 0.875em tier under
      // a hairline, per the §4 footnote area; the sr-only "Footnotes"
      // label keeps speaking through the heading merge
      className?.includes("footnotes") ? (
        <section className="mt-4 border-t border-line pt-2 text-[0.875em] text-ink-2">{children}</section>
      ) : (
        <section className={className}>{children}</section>
      ),
    table: ({ children }) => (
      // a wide table scrolls INSIDE its block (same language as the code
      // blocks) — a bare table's min-content width would push the whole
      // page into a horizontal pan on narrow screens
      <div className={MD.tableWrap} dir="auto">
        <table className={MD.table}>{children}</table>
      </div>
    ),
    td: ({ children }) => <td className={MD.td}>{children}</td>,
    th: ({ children }) => <th className={MD.th}>{children}</th>,
    ul: ({ children }) => <ul className={MD.ul}>{children}</ul>,
  };
}

/** The answer body, memoized: the card re-renders on every clamp
    measurement (contentPx), and a fresh components object made
    react-markdown rebuild the whole tree each time -- which remounted
    MermaidBlock and reset its svg/failed state on every tick, flickering
    the answer (and any diagram) for as long as the content height kept
    changing.  Stable props (markdown text, per-result meta, settled) keep
    the subtree untouched by measurement churn.
    The KaTeX math pipeline (the ZJBlog remark-math + rehype-katex pair):
    a sizable dependency, lazy-loaded only when the
    answer actually carries $ / $$ delimiters; until it loads the body
    renders as plain markdown
    (the delimiters flash raw for a beat -- the mermaid placeholder's own
    pattern). */
const MATH_FENCE = /\$\$[\s\S]+?\$\$|\$[^\s$][^$\n]*\$/;

export const MarkdownAnswer = memo(function MarkdownAnswer({
  markdown,
  meta,
  onCite,
  settled,
  galleries,
  figureLightbox = false,
}: {
  markdown: string;
  meta: AiSourceMeta[];
  onCite?: (index: number) => void;
  settled: boolean;
  /** the run's validated inline image groups -- the answer's
      {{zjs-gallery:i}} placeholders render these in place */
  galleries?: AiSearchGallery[][];
  /** The reading pane turns ON the figure lightbox (the ZJBlog Prose
      family mechanism): body images + rendered
      mermaid cards form one document-order mixed gallery.  Self-managed
      surfaces (the deck's own paging semantics) do not pass it */
  figureLightbox?: boolean;
}) {
  const needsMath = MATH_FENCE.test(markdown);
  const [mathPlugins, setMathPlugins] = useState<[PluggableList, PluggableList] | null>(null);
  useEffect(() => {
    if (!needsMath || mathPlugins) {
      return;
    }
    let cancelled = false;
    void Promise.all([import("remark-math"), import("rehype-katex")]).then(([rm, rh]) => {
      if (!cancelled) {
        setMathPlugins([[rm.default], [rh.default]]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [needsMath, mathPlugins]);
  const withMath = needsMath && mathPlugins;
  const body = (text: string, key: string) => (
    <Markdown
      components={markdownComponents(meta, onCite, settled, figureLightbox)}
      key={key}
      rehypePlugins={withMath ? mathPlugins[1] : undefined}
      remarkPlugins={withMath ? [...SHARED_REMARK, ...mathPlugins[0]] : SHARED_REMARK}
    >
      {text}
    </Markdown>
  );
  const content = renderWithGalleries(markdown, galleries, body, (index, key) => (
    <AnswerGallery gallery={galleries?.[index] ?? EMPTY_GALLERY} key={key} onCite={onCite} />
  ));
  if (!figureLightbox) {
    return content;
  }
  return <FigureLightboxRoot>{content}</FigureLightboxRoot>;
});

/** The figure lightbox container (the ZJBlog Prose family mechanism,
    DESIGN.md §5.1): delegates clicks on body
    images and rendered mermaid cards (data-zjs-figure) into one
    document-order mixed gallery--
    prev/next walks every figure.  SVG must be inline-cloned into the
    lightbox's svg item (serialized at click
    time, consistent with the current theme): <img src>'s secure static
    mode does not render
    htmlLabels' foreignObject.  AnswerGallery thumbnail blocks are buttons
    with citation-jump click semantics -- doubly excluded. */
function FigureLightboxRoot({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  // Focus returns to the trigger element after the lightbox closes
  // (keyboard/screen-reader users land back where they started)
  const lastTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) {
      return;
    }
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !container.contains(target)) {
        return;
      }
      if (target.closest("button")) {
        return; // gallery thumbnails / citation chips keep their own click semantics, out of the lightbox
      }
      const image = target.closest("img");
      const figure = image ? null : target.closest<HTMLElement>("[data-zjs-figure]");
      if (!image && !figure) {
        return;
      }
      // Gallery = every image + every rendered mermaid (not-yet-rendered
      // ones are still placeholders, no svg -- skipped);
      // querySelectorAll returns the mixed sequence in document order
      const items: LightboxItem[] = [];
      let index = -1;
      for (const node of container.querySelectorAll("img, [data-zjs-figure]")) {
        if (node.closest("button")) {
          continue;
        }
        if (node instanceof HTMLImageElement) {
          if (node === image) {
            index = items.length;
          }
          items.push({ alt: node.alt, kind: "img", src: node.currentSrc || node.src });
        } else {
          const svg = node.querySelector("svg");
          if (!svg) {
            continue;
          }
          if (node === figure) {
            index = items.length;
          }
          items.push({
            alt: node.getAttribute("aria-label") ?? "",
            html: svg.outerHTML,
            kind: "svg",
          });
        }
      }
      if (index === -1) {
        return;
      }
      event.preventDefault();
      lastTriggerRef.current = image ?? figure;
      setPreview({ items, index });
    };
    container.addEventListener("click", onClick);
    return () => {
      container.removeEventListener("click", onClick);
    };
  }, []);

  // The dialog's close event fires (top layer already released): return
  // focus to the trigger first, then unmount
  const closePreview = () => {
    const trigger = lastTriggerRef.current;
    if (trigger) {
      trigger.tabIndex = -1;
      trigger.focus({ preventScroll: true });
    }
    setPreview(null);
  };

  return (
    <>
      <div ref={ref}>{children}</div>
      {preview && preview.items.length > 0 && (
        <Lightbox initialIndex={preview.index} items={preview.items} onClose={closePreview} />
      )}
    </>
  );
}

const EMPTY_GALLERY: AiSearchGallery[] = [];

/** The capped reasoning scroll area: while the stream runs it keeps the
    newest line in view (no-op once settled or folded). */
export function ThinkScroll({ active, text }: { active: boolean; text: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // tail-follow must not fight the reader: while streaming the tail is
  // followed ONLY until the user scrolls away from it; scrolling back to
  // the bottom re-pins (the classic live-log pattern)
  const pinnedRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the live stream tail
  useEffect(() => {
    const el = scrollRef.current;
    if (active && el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [active, text]);
  return (
    <div
      // the machine-voice chrome: the reasoning stream sits on the same
      // boxed ground as the reading pane and the args debug pane -- THINK
      // (12px ink-3 on surface-2) vs CONTENT (14px ink on the plain
      // ground) distinguishes at a glance
      className="max-h-40 overflow-y-auto overscroll-contain rounded-lg bg-surface-2/50 px-3 py-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-3"
      dir="auto"
      onScroll={() => {
        const el = scrollRef.current;
        if (el) {
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }
      }}
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
          // body tier: the same shared MD document on a 14px root -- the
          // em-based recipe (headings/tables/code) scales the whole thing
          // proportionally, and the overview sits IN the 14px snippet
          // column instead of towering over it
          <div className="mt-2 text-sm font-serif leading-[1.8] text-ink">
            {/* streaming renders uncapped (active=false); once settled the
              shared clamp-and-reveal takes over the preview cap */}
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
              {!streaming && !failed && meta ? (
                <div className="mt-2">
                  <AiRunFooter finish={meta.finish ?? null} model={meta.model ?? null} usage={meta.usage ?? null} />
                </div>
              ) : null}
            </ClampReveal>
          </div>
        ) : streaming && !hasThink ? (
          <p className="mt-2 text-xs text-ink-3">{t("ai_overview_running")}</p>
        ) : null}
        {/* the follow-up: the question rides the AI search with THIS
            answer as the conversation's opening history -- a sessionStorage
            hand-off survives the navigation (the staged attachments' exact
            channel) and the takeover's first POST carries it, so the next
            run builds on what's established */}
        {state.phase === "done" && hasAnswer && q ? (
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
