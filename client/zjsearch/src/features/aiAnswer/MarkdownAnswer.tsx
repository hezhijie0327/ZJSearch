// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// KaTeX typography for the math pipeline (lazy-loaded plugins, css is small
// enough to ride the results stylesheet; the woff2 fonts load on demand)
import "katex/dist/katex.min.css";

import { ArrowUpRight, Copy } from "lucide-react";
import { Children, isValidElement, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import type { PluggableList } from "unified";
import { AnswerGallery, renderWithGalleries } from "@/features/aiAnswer/AnswerGallery.tsx";
import { Lightbox, type LightboxItem } from "@/features/aiAnswer/AttachmentLightbox.tsx";
import type { AiSearchGallery, AiSourceMeta } from "@/features/aiAnswer/aiOverview.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { cn } from "@/lib/cn.ts";
import { useHostFavicon } from "@/lib/favicons.ts";
import { useT } from "@/lib/i18n.ts";
import { hostnameOf } from "@/lib/link.ts";
import { MD, normalizeEmphasis, SHARED_REMARK, sharedRemarkWithMath } from "@/lib/markdownParts.ts";
import { HOVER_CHIP } from "@/lib/styles.ts";

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

/** The hover panel's favicon cell: the source's wire favicon first, then
    the classic channel (lib/favicons' host route) for the hosts the wire
    left blank -- page reads, browser mints and recalled pages all carry
    favicon:"" on their sources events.  No icon anywhere: the caller's
    fallback keeps the row rhythm. */
function PanelFavicon({
  favicon,
  url,
  className,
  fallback,
}: {
  favicon?: string;
  url: string;
  className: string;
  fallback: ReactNode;
}) {
  const fetched = useHostFavicon(favicon ? null : hostnameOf(url));
  const src = favicon || fetched || "";
  return src ? <img alt="" className={className} src={src} /> : fallback;
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
                <PanelFavicon
                  className="size-4 rounded-full object-contain"
                  fallback={null}
                  favicon={source.favicon}
                  url={source.u}
                />
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
                    <PanelFavicon
                      className="mt-0.5 size-4 shrink-0 rounded-full object-contain"
                      fallback={
                        <span aria-hidden="true" className="mt-0.5 size-4 shrink-0 rounded-full bg-surface-2" />
                      }
                      favicon={source?.favicon}
                      url={source?.u ?? ""}
                    />
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

// the family editorial levels (DESIGN.md §5.1): serif, weighted by depth.
// MODULE LEVEL so the component identity is stable across renders (biome's
// noComponentHookFactories: a heading factory rebuilt per render remounts
// every heading subtree on every streaming chunk). An incoming class rides
// along -- the GFM footnotes' sr-only section label is the one producer,
// and stripping it would paint an a11y-only heading in full serif
function MdHeading({ children, className, level }: MdProps & { level: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" }) {
  const Tag = level as "h3";
  return (
    <Tag className={className ? `${MD[level]} ${className}` : MD[level]} dir="auto">
      {children}
    </Tag>
  );
}

function markdownComponents(
  meta: AiSourceMeta[],
  onCite: ((index: number) => void) | undefined,
  settled: boolean,
  figureLightbox: boolean,
): Record<string, (props: MdProps) => ReactNode> {
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
    h1: ({ children, className }) => (
      <MdHeading className={className} level="h1">
        {children}
      </MdHeading>
    ),
    h2: ({ children, className }) => (
      <MdHeading className={className} level="h2">
        {children}
      </MdHeading>
    ),
    h3: ({ children, className }) => (
      <MdHeading className={className} level="h3">
        {children}
      </MdHeading>
    ),
    h4: ({ children, className }) => (
      <MdHeading className={className} level="h4">
        {children}
      </MdHeading>
    ),
    h5: ({ children, className }) => (
      <MdHeading className={className} level="h5">
        {children}
      </MdHeading>
    ),
    h6: ({ children, className }) => (
      <MdHeading className={className} level="h6">
        {children}
      </MdHeading>
    ),
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
    a sizable dependency, lazy-loaded only when the answer actually
    carries math; until it loads the body renders as plain markdown (the
    delimiters flash raw for a beat -- the mermaid placeholder's own
    pattern).  DELIBERATE FAMILY DIVERGENCE (DESIGN.md §5.1's separator
    seam):
    singleDollarTextMath is OFF -- our content is UNAUDITED model output,
    and a currency pair ($3,000 ... $5,000) would ride straight into
    KaTeX as garbled formulas (the false-positive class ZJBlog's
    0f92d7a had to escape by hand in its human-audited content; a model
    cannot be taught to escape every dollar).  Inline math is therefore
    $$..$$ only, exactly what spine.markdown_surface teaches. */
const MATH_FENCE = /\$\$[\s\S]+?\$\$|^```math/m;

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
        setMathPlugins([[rm.default, { singleDollarTextMath: false }] as PluggableList, [rh.default] as PluggableList]);
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
      remarkPlugins={withMath ? sharedRemarkWithMath(mathPlugins[0]) : SHARED_REMARK}
    >
      {text}
    </Markdown>
  );
  const content = renderWithGalleries(normalizeEmphasis(markdown), galleries, body, (index, key) => (
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
