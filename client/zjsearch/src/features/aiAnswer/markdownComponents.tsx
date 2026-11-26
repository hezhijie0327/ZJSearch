// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// KaTeX typography for the math pipeline (lazy-loaded plugins, css is small
// enough to ride the results stylesheet; the woff2 fonts load on demand)
import { CitationChip, CitationGroupChip } from "@/features/aiAnswer/citationChips.tsx";
import "katex/dist/katex.min.css";

import { Copy } from "lucide-react";
import { Children, isValidElement, type ReactNode, useEffect, useRef, useState } from "react";
import type { AiSourceMeta } from "@/features/aiAnswer/aiOverview.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import { cn } from "@/lib/cn.ts";
import { useT } from "@/lib/i18n.ts";
import { MD } from "@/lib/markdownParts.ts";
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

export function markdownComponents(
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
