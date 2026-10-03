// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// KaTeX typography for the math pipeline (lazy-loaded plugins, css is small
// enough to ride the results stylesheet; the woff2 fonts load on demand)
import "katex/dist/katex.min.css";

import { ArrowUpRight, Brain, ChevronDown, Copy, RefreshCw, Sparkles } from "lucide-react";
import { Children, isValidElement, memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkDeflist from "remark-deflist";
import remarkEmoji from "remark-emoji";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { ClampReveal } from "@/components/ClampReveal.tsx";
import { Collapse } from "@/components/Collapse.tsx";
import { AiRunFooter } from "@/features/results/AiRunFooter.tsx";
import {
  type AiSearchGallery,
  type AiSourceMeta,
  extractRunMeta,
  splitAnswerStream,
} from "@/features/results/aiOverview.ts";
import { AnswerGallery, renderWithGalleries } from "@/features/results/aiSearch/AnswerGallery.tsx";
import { citeToLinks } from "@/lib/citations.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { fetchStream } from "@/lib/http.ts";
import { useT } from "@/lib/i18n.ts";
import { CODE_CHIP, HOVER_CHIP, META_TOGGLE } from "@/lib/styles.ts";
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

/** 基础 remark 插件集 —— 系统 Prompt 实际广告的语法面（GFM / 表情 shortcode /
    定义列表），随 results chunk 加载；KaTeX 数学管线因体积懒加载，见
    MarkdownAnswer。不在 Prompt 里的扩展（如 ==mark==）刻意不装：模型不输出
    它们，装了只是给不可信输出多开一条渲染路径。 */
const BASE_REMARK = [remarkGfm, remarkEmoji, remarkDeflist];

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
 * which click-jump to the matching result row.  The LLM call happens on
 * click only; before the first streamed byte errors answer as clean HTTP
 * statuses (403 / 422 / 502) — the 502 body carries the upstream reason,
 * which the card renders under its failed label.
 */

export type AiAnswerPhase = "idle" | "streaming" | "done" | "error";

export interface AiAnswerState {
  phase: AiAnswerPhase;
  /** the asked question (the MD/PDF exports' title + filename base) */
  query: string;
  /** raw stream text: <think> block (when the model reasons) followed by
      the visible markdown answer with [n] citations */
  text: string;
  open: boolean;
  /** the transport's error message (HTTP status + upstream reason) when
      phase === "error" — rendered under the card's failed label */
  error: string | null;
  /** ask the question for the current results (or re-ask after an error) */
  start: (q: string, context: string, images?: string[]) => void;
  toggle: (q: string, context: string, images?: string[]) => void;
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
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastAskRef = useRef<{ context: string; images: string[]; q: string } | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = (q: string, context: string, images: string[] = []) => {
    if (!capability) {
      return;
    }
    abortRef.current?.abort();
    lastAskRef.current = { context, images, q };
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("streaming");
    setText("");
    setError(null);
    setOpen(true);
    // the endpoint streams the SAME timeline NDJSON as search (closed-set
    // wire events); this hook adapts it into the card's raw-text rendering
    // contract: <think> markers around the reasoning, the meta sentinel at
    // the tail (both parsed back out by splitAnswerStream/extractRunMeta)
    let accumulated = "";
    let thinkOpen = false;
    let lineBuffer = "";
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
        const meta = {
          finish: event.finish ?? null,
          model: event.model ?? null,
          usage: event.usage ?? null,
        };
        accumulated += `\n<<<zjs-meta:${JSON.stringify(meta)}>>>`;
      }
    };
    void fetchStream(
      "/zjsearch/ai/answer",
      { context, images, lang, q, tk: capability.tk },
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
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
          setPhase(accumulated ? "done" : "error");
        }
      });
  };

  const regenerate = () => {
    const last = lastAskRef.current;
    if (last && phase !== "streaming") {
      start(last.q, last.context, last.images);
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
    setError(null);
    setOpen(false);
  };

  return { error, open, phase, query: lastAskRef.current?.q ?? "", regenerate, reset, start, text, toggle };
}

/** Meta-row entry (the 12px toggle tier of 「found N results · took X s」). */
export function AiAnswerTrigger({
  phase,
  open,
  onToggle,
}: {
  phase: AiAnswerPhase;
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
      {phase === "streaming" ? t("ai_answering") : phase === "error" ? t("ai_answer_failed") : t("ai_answer")}
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

/** Compact [n] citation chip: hovering opens a floating preview panel with
    the source favicon, site and title (portalled to <body> so the clamp
    wrapper's overflow-hidden cannot clip it); clicking jumps to the
    matching result row.  Moving between chip and panel keeps it open. */
function CitationChip({ n, source, onCite }: { n: number; source: AiSourceMeta; onCite?: (index: number) => void }) {
  const t = useT();
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
        aria-label={`${t("open_source")} ${n}`}
        className="mx-0.5 inline-flex items-center rounded align-middle text-xs text-accent transition-colors hover:text-accent-hover hover:underline underline-offset-2"
        onBlur={closeSoon}
        onClick={() => {
          onCite?.(n);
          setPanel(null);
        }}
        onFocus={openPanel}
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
const HEADING = "mt-3 text-base font-semibold text-ink first:mt-0";

const CODE_BLOCK = "mt-2 overflow-x-auto rounded-xl bg-surface-2 p-3 font-mono text-xs leading-relaxed text-ink";

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
export function MermaidBlock({ chart }: { chart: string }) {
  const t = useT();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [nearViewport, setNearViewport] = useState(
    () => typeof window !== "undefined" && !("IntersectionObserver" in window),
  );
  const [theme, setTheme] = useState(() => isDarkTheme());

  // 进入视口(含 300px 缓冲)才触发加载 —— 长答案里屏外的图不白白付费
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

  // 打印时未滚动到的图是空占位 —— 尽力触发一次渲染
  useEffect(() => {
    const onBeforePrint = () => {
      setNearViewport(true);
    };
    window.addEventListener("beforeprint", onBeforePrint);
    return () => {
      window.removeEventListener("beforeprint", onBeforePrint);
    };
  }, []);

  // 主题切换(html class 翻转,含 auto 跟随系统)后以新主题重渲
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
      <div
        aria-label={t("ai_figure")}
        className="zjs-mermaid mt-2 overflow-x-auto rounded-xl bg-surface-2 p-3"
        dangerouslySetInnerHTML={{ __html: svg }}
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
): Record<string, (props: MdProps) => ReactNode> {
  const heading = ({ children }: MdProps) => (
    <h3 className={HEADING} dir="auto">
      {children}
    </h3>
  );
  const external = ({ children, href }: MdProps) => (
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
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-s-2 border-line ps-3 text-ink-2">{children}</blockquote>
    ),
    code: ({ className, children }) =>
      className ? <code className={className}>{children}</code> : <code className={CODE_CHIP}>{children}</code>,
    dd: ({ children }) => <dd className="ms-5 text-ink-2">{children}</dd>,
    dt: ({ children }) => <dt className="mt-2 font-medium text-ink">{children}</dt>,
    h1: heading,
    h2: heading,
    h3: heading,
    img: ({ alt, src }) => (
      <img alt={alt ?? ""} className="my-2 max-w-full rounded-xl border border-line" loading="lazy" src={src} />
    ),
    hr: () => <hr className="my-3 border-line" />,
    li: ({ children }) => (
      <li className="break-words marker:text-accent" dir="auto">
        {children}
      </li>
    ),
    ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 ps-5 first:mt-0">{children}</ol>,
    p: ({ children }) => (
      <p className="my-2 break-words first:mt-0" dir="auto">
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
        return <MermaidBlock chart={textOf(props?.children)} />;
      }
      return <CodeBlock>{children}</CodeBlock>;
    },
    table: ({ children }) => (
      // a wide table scrolls INSIDE its block (same language as the code
      // blocks) — a bare table's min-content width would push the whole
      // page into a horizontal pan on narrow screens
      <div className="zjs-md-table my-2 overflow-x-auto" dir="auto">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    ),
    td: ({ children }) => <td className="break-words border border-line px-2 py-1 align-top">{children}</td>,
    th: ({ children }) => (
      <th className="break-words border border-line bg-surface-2 px-2 py-1 text-start font-medium">{children}</th>
    ),
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 ps-5 first:mt-0">{children}</ul>,
  };
}

/** The answer body, memoized: the card re-renders on every clamp
    measurement (contentPx), and a fresh components object made
    react-markdown rebuild the whole tree each time -- which remounted
    MermaidBlock and reset its svg/failed state on every tick, flickering
    the answer (and any diagram) for as long as the content height kept
    changing.  Stable props (markdown text, per-result meta, settled) keep
    the subtree untouched by measurement churn.
    KaTeX 数学管线（ZJBlog 同款 remark-math + rehype-katex）：体积可观，仅在
    答案里出现 $ / $$ 定界符时才懒加载；加载完成前先按纯 markdown 渲染
    （定界符短暂裸奔，与 mermaid 占位符同一模式）。 */
const MATH_FENCE = /\$\$[\s\S]+?\$\$|\$[^\s$][^$\n]*\$/;

export const MarkdownAnswer = memo(function MarkdownAnswer({
  markdown,
  meta,
  onCite,
  settled,
  galleries,
}: {
  markdown: string;
  meta: AiSourceMeta[];
  onCite?: (index: number) => void;
  settled: boolean;
  /** the run's validated inline image groups -- the answer's
      {{zjs-gallery:i}} placeholders render these in place */
  galleries?: AiSearchGallery[][];
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
      components={markdownComponents(meta, onCite, settled)}
      key={key}
      rehypePlugins={withMath ? mathPlugins[1] : undefined}
      remarkPlugins={withMath ? [...BASE_REMARK, ...mathPlugins[0]] : BASE_REMARK}
    >
      {text}
    </Markdown>
  );
  return renderWithGalleries(markdown, galleries, body, (index, key) => (
    <AnswerGallery gallery={galleries?.[index] ?? EMPTY_GALLERY} key={key} onCite={onCite} />
  ));
});

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
  onCite?: (index: number) => void;
}) {
  const t = useT();
  const [thinkForced, setThinkForced] = useState<boolean | null>(null);
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
  // a finished stream with neither answer nor reasoning content is a
  // failure; a user stop keeps the partial content without an error label
  const failed = state.phase === "error" || (state.phase === "done" && !hasAnswer && !hasThink);

  const markdown = useMemo(() => citeToLinks(answer), [answer]);

  return (
    <div className="animate-fade-up rounded-2xl border border-line bg-surface p-4" id="ai-answer-card">
      <div className="zjs-print-hide flex min-w-0 items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
          <Sparkles className="size-3.5" />
        </span>
        <span className="text-[13px] font-medium text-ink">{t("ai_answer")}</span>
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
            {state.phase === "done" && hasAnswer ? <CopyChip value={answer.trim()} /> : null}
            {/* downloads (MD/PDF) live in the knowledge base's inspector
                ONLY -- the answer surfaces stay read-and-ask */}
          </div>
        ) : null}
      </div>
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
        <div className="mt-2 text-sm leading-relaxed text-ink">
          {/* streaming renders uncapped (active=false); once settled the
              shared clamp-and-reveal takes over the preview cap */}
          <ClampReveal
            active={state.phase === "done"}
            buttonClassName="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full border border-line py-2 text-[13px] font-medium text-ink-2 transition-colors hover:text-ink"
            previewPx={OVERVIEW_PREVIEW_PX}
          >
            <MarkdownAnswer markdown={markdown} meta={sourceMeta} onCite={onCite} settled={state.phase === "done"} />
            {/* the run's meta line folds INTO 查看更多 (the transport
                outcome is detail, not headline) */}
            {!streaming && !failed && meta ? (
              <div className="mt-2">
                <AiRunFooter finish={meta.finish ?? null} model={meta.model ?? null} usage={meta.usage ?? null} />
              </div>
            ) : null}
          </ClampReveal>
        </div>
      ) : streaming && !hasThink ? (
        <p className="mt-2 text-xs text-ink-3">{t("ai_answering")}</p>
      ) : null}
      {failed ? (
        <div className="mt-2 text-xs text-danger">
          <p>{t("ai_answer_failed")}</p>
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
            className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-accent-strong/40 bg-accent-soft px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:text-accent-hover"
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
  );
}
