// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * The slide player (the AI Search DECK artifact view) -- the ZJBlog
 * src/features/deck/DeckViewer.tsx twin (DESIGN.md §5.2 family contract).
 * Three structural differences come from "rendering a run's streaming
 * artifact":
 *
 *  1. The input is an outline + per-section markdown (not compiled HTML):
 *     the compiler (lib/deck/compile.ts, marp-core) lazy-loads on demand,
 *     and every part (the cover + each outline section with content)
 *     compiles and caches independently -- a settled section's slides
 *     string never recompiles while unchanged, the streaming tail section
 *     recompiles throttled at 350ms, an unchanged part never swaps its
 *     innerHTML, and the mermaid islands (tracked per element) do not
 *     flicker.
 *  2. The canvas is "multiple div.marpit containers", not one: marpit's
 *     theme scoping selector `div.marpit > section` holds per container;
 *     page turns / print number every section under the canvases in one
 *     sequence (DOM order = cover + outline order).
 *  3. Citation chips: a section's markdown passes citeToLinks first
 *     ([n] → #ref-n links, the answer pipeline's own tokenizer), the
 *     compiled anchors carry the chip look directly (theme CSS), and a
 *     canvas-level delegated click joins the citation-locate chain.  No
 *     JS-side tokenizing, no second citation regex.
 *
 * The mechanisms shared with the blog are verbatim kin: the tan/atan2
 * pure-CSS scaling, page turns (keyboard/buttons/touch swipe), speaker
 * notes, paged↔stacked, the dual-track fullscreen (webview fallback,
 * state-driven instead of :fullscreen), print through the
 * viewport-independent uniform-scale flow (HOST_CSS's print block rides
 * the clone onto the paper, marpit's own @page 1280×720 takes over the
 * per-page pagination).
 */

import { ChevronLeft, ChevronRight, Maximize, Minimize, Printer, StickyNote } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownAnswer, MermaidBlock } from "@/features/results/AiSummary.tsx";
import type { AiSourceMeta } from "@/features/results/aiOverview.ts";
import { fitVisibleSlides, observeLateContent } from "@/features/results/aiSearch/deck/deckFit.ts";
import { applyLocalCiteNumbers, buildCitationMap, citedSourceRows, citeToLinks } from "@/lib/citations.ts";
import { cn } from "@/lib/cn.ts";
import { useT } from "@/lib/i18n.ts";
import { type PrintSource, printDocument } from "@/lib/print.ts";
import { CHIP, ICON_BTN, META_ROW } from "@/lib/styles.ts";

interface DeckViewOutline {
  title: string;
  subtitle?: string;
  sections: Array<{ id: string; title: string; status: "pending" | "writing" | "done" }>;
}

interface DeckViewProps {
  outline: DeckViewOutline;
  /** Per-section markdown (the timeline's section buffers) */
  sections: Record<string, string>;
  meta: AiSourceMeta[];
  onCite: (n: number) => void;
  settled: boolean;
  /** Print filename suffix (the thread page's 8-char id) */
  fileTag?: string;
}

interface DeckPartHtml {
  key: string;
  html: string;
}

interface ParsedSlide {
  slide: string;
  notes: string;
}

/** Split the per-page HTML (marpit sections never nest, so a non-greedy
    match is safe). */
function splitSlides(html: string): ParsedSlide[] {
  return [...html.matchAll(/<section\b[\s\S]*?<\/section>/g)].map((match) => {
    const raw = match[0] ?? "";
    const notes = /<aside class="deck-notes">([\s\S]*?)<\/aside>/.exec(raw)?.[1] ?? "";
    return { slide: raw.replace(/<aside class="deck-notes">[\s\S]*?<\/aside>/, ""), notes };
  });
}

/** The cover slide (the lead variant): the outline's title/subtitle cast
 *  into a slide -- structure belongs to the outline,
 *  content to the model, the cover is deterministic.  The date line means
 *  nobody has to ask "when is this material from" while presenting. */
function coverMarkdown(outline: DeckViewOutline): string {
  const lines = ["<!-- _class: lead -->", "", `# ${outline.title}`, ""];
  if (outline.subtitle) {
    lines.push(outline.subtitle, "");
  }
  lines.push(new Date().toISOString().slice(0, 10), "");
  return lines.join("\n");
}

/** Host styles: the twin of ZJBlog DeckViewer's HOST_CSS (the print and
 *  preview blocks stay in sync on both sides);
 *  differences: no shiki dark switch (code blocks flip through their own
 *  tokens); one extra divider for stacked mode across part
 *  boundaries. */
const HOST_CSS = `
.deck-root { --deck-canvas-w: 1280px; }
.deck-stage {
  position: relative;
  container-type: inline-size;
  --deck-scale: calc(tan(atan2(100cqw, var(--deck-canvas-w))));
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--bg);
  overflow: hidden;
  box-shadow: var(--shadow-card);
}
.deck-canvas {
  width: var(--deck-canvas-w);
  transform: scale(var(--deck-scale));
  transform-origin: top left;
}
/* Paged: the stage locks 16:9, the canvas scales absolutely at the origin */
.deck-root[data-mode="paged"] .deck-stage { aspect-ratio: 16 / 9; }
.deck-root[data-mode="paged"] .deck-canvas { position: absolute; left: 0; top: 0; }
.deck-root[data-mode="paged"] .deck-canvas section { animation: deck-slide-in 0.28s ease; }
@keyframes deck-slide-in {
  from { opacity: 0; transform: translateX(14px); }
  to { opacity: 1; transform: none; }
}
/* Continuous: adjacent pages inside a part join through a divider (the
   stage height is synced by JS to the post-scale actual value) */
.deck-root[data-mode="stacked"] .deck-canvas section + section,
.deck-root[data-mode="stacked"] .deck-canvas .deck-part + .deck-part > section:first-child {
  border-top: 1px solid var(--line);
}
/* Speaker notes stay out of the canvas (paged mode shows the current
   slide's notes in the React panel) */
.deck-root .marpit section .deck-notes { display: none; }
/* Fullscreen presentation: styles are driven by React state
   (data-fullscreen) instead of the :fullscreen pseudo-class
   -- the native Fullscreen API is often "half-broken" in webview/preview
   environments (the DOM state flips, the view never expands,
   fullscreenchange never dispatches); hanging the styles on state
   guarantees a visible reaction whenever the button is clicked in any
   environment; pseudo-fullscreen = a fixed overlay, and it applies the
   same under real fullscreen.  The control bar stays on screen. */
.deck-root[data-fullscreen] {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: var(--bg);
  padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right))
    max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
  overflow: auto;
}
.deck-root[data-fullscreen] .deck-stage {
  width: min(100%, calc((100dvh - 48px - 64px) * 16 / 9));
  margin-inline: auto;
}
/* Horizontal swipes on the stage go to JS page turns; vertical swipes
   stay with page scrolling */
.deck-stage {
  touch-action: pan-y;
}
/* Paged mode's non-current slides: Tailwind preflight's [hidden] is a
 * layered !important (an unlayered rule loses to a layered one by the
 * cascade's layer inversion), so the page turn uses a custom attribute +
 * its own rule */
.deck-canvas section[data-slide-hidden] {
  display: none !important;
}
/* ── Print / preview paper: the viewport-independent uniform-scale flow
 * (the ZJBlog a0913bf same-shape flow).
 * Desktop Chrome/Edge lay out at marpit's own @page 1280×720 (landscape),
 * so the scale naturally
 * normalizes to 1; pipelines without @page size support (iOS AirPrint and
 * kin) follow the print layout width with the scale
 * (cqw-adaptive), one slide per page, nothing clipped.  Chrome hides,
 * hidden slides reveal, per-block break protection.
 * This component's HOST_CSS rides printDocument's clone onto the paper,
 * so the rules work identically inside the clone.
 * The @media print and html.zjs-print-view (preview face, lib/print.ts)
 * lists stay in sync.
 * ── */
@media print {
  .deck-root [data-deck-chrome] {
    display: none !important;
  }
  .deck-root .deck-stage {
    aspect-ratio: auto !important;
    overflow: visible !important;
    height: auto !important;
    border: none;
    box-shadow: none;
    border-radius: 0;
    margin-inline: auto !important;
  }
  .deck-root .deck-canvas {
    position: static !important;
    transform: none !important;
    zoom: var(--deck-scale) !important;
  }
  .deck-root .deck-canvas section[data-slide-hidden] {
    display: block !important;
  }
  .deck-root .deck-canvas section {
    break-inside: avoid;
    page-break-inside: avoid;
    /* one slide per landscape sheet: the sections are 1280×720 (marpit)
       and the deck paper's @page is the same box -- the explicit break
       pins the boundary even when a slide's content overflows a hair */
    break-after: page;
  }
  .deck-root .deck-canvas section:last-child {
    break-after: auto;
  }
}
.zjs-print-view .deck-root [data-deck-chrome] {
  display: none !important;
}
.zjs-print-view .deck-root .deck-stage {
  aspect-ratio: auto !important;
  overflow: visible !important;
  height: auto !important;
  border: none;
  box-shadow: none;
  border-radius: 0;
  margin-inline: auto !important;
}
.zjs-print-view .deck-root .deck-canvas {
  position: static !important;
  transform: none !important;
  zoom: var(--deck-scale) !important;
}
.zjs-print-view .deck-root .deck-canvas section[data-slide-hidden] {
  display: block !important;
}
.zjs-print-view .deck-root .deck-canvas section {
  break-inside: avoid;
  break-after: page;
}
.zjs-print-view .deck-root .deck-canvas section:last-child {
  break-after: auto;
}
`;

const STREAM_RECOMPILE_MS = 350;
/** The streaming tail section's compile throttle: the write phase
 *  recompiles at most once per 350ms (a marp single-section render costs
 *  tens of ms); the final render lands the moment the section settles. */

export function DeckView({ outline, sections, meta, onCite, settled, fileTag }: DeckViewProps) {
  const t = useT();
  // THE RUN PAGE SPEAKS GLOBAL (the DocumentView contract): the rail's #n
  // cards sit beside the deck -- chips render the run's registry numbers
  // 1:1 via an IDENTITY map (phantom [n]s stay unlinked verbatim).  The
  // document-local renumbering stays with the self-contained surfaces.
  const citationMap = useMemo(() => {
    const knownNs = new Set(meta.map((source) => source.n).filter((n): n is number => Number.isInteger(n)));
    // possibly EMPTY == the old undefined: verbatim global chips, no rows
    const map = new Map<number, number>();
    for (const n of [...knownNs].sort((a, b) => a - b)) {
      map.set(n, n);
    }
    return map;
  }, [meta]);
  const citedMeta = useMemo(() => citedSourceRows(citationMap, meta), [citationMap, meta]);
  const onCiteLocal = (local: number) => {
    onCite(local);
  };
  // the PRINT map: the deck on paper is self-contained -- body chips and
  // the tail read [1..N] in first-citation order (the screen above keeps
  // its global chips matching the rail)
  const printMap = useMemo(() => {
    const texts = outline.sections.map((section) => sections[section.id] ?? "").filter(Boolean);
    const knownNs = new Set(meta.map((source) => source.n).filter((n): n is number => Number.isInteger(n)));
    return buildCitationMap(texts, knownNs.size > 0 ? knownNs : undefined);
  }, [outline.sections, sections, meta]);
  const [mode, setMode] = useState<"paged" | "stacked">("paged");
  const [active, setActive] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  // Dual-track fullscreen: the native Fullscreen API can be half-broken
  // in webview/preview environments (the DOM state
  // flips but the view never expands, events never dispatch); a rejected
  // promise or an unavailable API falls back to pseudo-fullscreen
  const [nativeFs, setNativeFs] = useState(false);
  const [pseudoFs, setPseudoFs] = useState(false);
  const [css, setCss] = useState("");
  const [partsHtml, setPartsHtml] = useState<DeckPartHtml[]>([]);
  const [failed, setFailed] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const touchX = useRef<number | null>(null);
  // Compile cache (key → source text + artifact): a settled section's
  // slides never recompile while unchanged
  const compileCache = useRef(new Map<string, { src: string; html: string }>());
  const cssCache = useRef("");
  // Mermaid islands tracked per element: an unchanged part never swaps its
  // DOM, so islands never remount
  const islandsRef = useRef(new Map<HTMLElement, Root>());

  // The streaming recompile signature: cover text + each section's text
  // length (append-only streams) + the settled bit
  const signature = useMemo(
    () =>
      `${outline.title}\n${outline.subtitle ?? ""}\n${outline.sections
        .map((s) => `${s.id}:${(sections[s.id] ?? "").length}`)
        .join("|")}|${settled ? 1 : 0}`,
    [outline.title, outline.subtitle, outline.sections, sections, settled],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature string IS the dependency set (cover text + section lengths + settled) -- the closure re-reads the latest refs whenever it changes
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const run = async () => {
      try {
        const { compileDeck } = await import("@/lib/deck/compile.ts");
        if (cancelled) {
          return;
        }
        const compileKeyed = (key: string, source: string): string | null => {
          const cached = compileCache.current.get(key);
          if (cached && cached.src === source) {
            return cached.html;
          }
          const result = compileDeck(source, { html: false });
          const html = result.slides.join("\n");
          compileCache.current.set(key, { src: source, html });
          if (!cssCache.current) {
            cssCache.current = result.css;
            setCss(result.css);
          }
          return html;
        };
        const parts: DeckPartHtml[] = [
          { key: "__cover__", html: compileKeyed("__cover__", coverMarkdown(outline)) ?? "" },
        ];
        for (const section of outline.sections) {
          const source = sections[section.id] ?? "";
          if (!source) {
            continue;
          }
          const html = compileKeyed(section.id, citeToLinks(source, citationMap));
          if (html !== null) {
            parts.push({ key: section.id, html });
          }
        }
        if (!cancelled) {
          setPartsHtml(parts);
          setFailed(false);
        }
      } catch {
        // Compiler load failed (a chunk-404-grade accident): degrade to the
        // markdown view, the caller covers it (the failed bit drives it) --
        // one bad card never kills the answer
        if (!cancelled) {
          setFailed(true);
        }
      }
    };
    if (settled) {
      void run();
    } else {
      timer = window.setTimeout(() => {
        void run();
      }, STREAM_RECOMPILE_MS);
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [signature]);

  const slides = useMemo(() => partsHtml.flatMap((part) => splitSlides(part.html)), [partsHtml]);
  const total = slides.length;

  // Functional update: rapid clicks / multiple same-frame events never
  // compute from a stale `active`
  const goTo = useCallback(
    (next: number | ((prev: number) => number)) => {
      setActive((prev) => {
        const target = typeof next === "function" ? next(prev) : next;
        return Math.max(0, Math.min(total - 1, target));
      });
    },
    [total],
  );

  // Page turn = toggling hidden per section across the FULL DOM (print and
  // preview need every page resident in the document);
  // display:none ↔ block replays the CSS page-turn animation on its own.
  // Visible sections get their aria semantics in place.
  // After the toggle, run the overflow fit on the newly visible page
  // (display:none pages have no measurable size -- measured on arrival).
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit partsHtml dependency -- hidden + aria must replay once the compiled artifact reaches the DOM
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    canvas.querySelectorAll("section").forEach((section, index) => {
      const isActive = mode === "paged" && index === active;
      section.toggleAttribute("data-slide-hidden", mode === "paged" && index !== active);
      if (isActive) {
        section.setAttribute("role", "group");
        section.setAttribute("aria-roledescription", t("deck_slide"));
        section.setAttribute("aria-label", t("deck_slide_n", { n: String(index + 1), m: String(total) }));
      } else {
        section.removeAttribute("role");
        section.removeAttribute("aria-roledescription");
        section.removeAttribute("aria-label");
      }
    });
    fitVisibleSlides(canvas);
  }, [mode, active, partsHtml, total, t]);

  // Late content (mermaid svg replacing a placeholder, images loading)
  // triggers an overflow remeasure -- after a chart renders, its page may
  // go from "fits" to "overflows"
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    return observeLateContent(canvas);
  }, []);

  // Mermaid placeholder containers (compile output): mount MermaidBlock
  // onto each for lazy rendering -- the renderer brings its own
  // in-viewport gate (hidden pages never trigger; a page renders on
  // arrival) and the print light-palette tie-in.  Islands are tracked per
  // element: an unchanged part never swaps its DOM, rendered charts never
  // flicker; replaced elements die with their innerHTML and unmount the
  // moment their connection drops.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit partsHtml dependency -- the DOM comes from it, island mounting follows the compiled artifact not its reference
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const islands = islandsRef.current;
    for (const [el, root] of islands) {
      if (!el.isConnected) {
        root.unmount();
        islands.delete(el);
      }
    }
    for (const el of canvas.querySelectorAll<HTMLElement>(".mermaid-placeholder")) {
      if (islands.has(el)) {
        continue;
      }
      const root = createRoot(el);
      root.render(<MermaidBlock chart={el.dataset.chart ?? ""} />);
      islands.set(el, root);
    }
  }, [partsHtml]);
  useEffect(
    () => () => {
      for (const root of islandsRef.current.values()) {
        root.unmount();
      }
      islandsRef.current.clear();
    },
    [],
  );

  // Native fullscreen state sync (Esc / system gesture exits must also
  // land the button state)
  useEffect(() => {
    const onFullscreenChange = () => setNativeFs(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  // Pseudo-fullscreen exit: Esc (native fullscreen's Esc is the browser's
  // own business)
  useEffect(() => {
    if (!pseudoFs) {
      return;
    }
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPseudoFs(false);
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [pseudoFs]);

  // Continuous mode: the stage height = the canvas's post-scale actual
  // height (transform takes no part in layout)
  useEffect(() => {
    if (mode !== "stacked") {
      return;
    }
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) {
      return;
    }
    const sync = () => {
      stage.style.height = `${canvas.getBoundingClientRect().height}px`;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      stage.style.height = "";
    };
  }, [mode]);

  const onKey = useCallback(
    (event: { key: string; preventDefault: () => void; target: EventTarget | null }) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]")) {
        return;
      }
      switch (event.key) {
        case "ArrowRight":
        case "PageDown":
          event.preventDefault();
          goTo((prev) => prev + 1);
          break;
        case "ArrowLeft":
        case "PageUp":
          event.preventDefault();
          goTo((prev) => prev - 1);
          break;
        case "Home":
          event.preventDefault();
          goTo(0);
          break;
        case "End":
          event.preventDefault();
          goTo(total - 1);
          break;
        default:
          break;
      }
    },
    [goTo, total],
  );

  // Paged mode: window-level keyboard page turns
  useEffect(() => {
    if (mode !== "paged") {
      return;
    }
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [mode, onKey]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      // Optimistic flip: environments where fullscreenchange never
      // dispatches must still land the button state
      setNativeFs(false);
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (pseudoFs) {
      setPseudoFs(false);
      return;
    }
    const el = rootRef.current;
    if (el?.requestFullscreen && document.fullscreenEnabled) {
      el.requestFullscreen().then(
        () => setNativeFs(true),
        () => setPseudoFs(true),
      );
    } else {
      setPseudoFs(true);
    }
  };

  const fullscreen = nativeFs || pseudoFs;
  const current = slides[active];

  // Compiler unavailable (a lazy chunk-404-grade accident): degrade to the
  // markdown view -- the slide source is markdown to begin with, the
  // answer pipeline renders it readable and citable as ever
  const gluedSource = useMemo(
    () =>
      [outline.title, ...outline.sections.map((section) => sections[section.id] ?? "").filter(Boolean)].join("\n\n"),
    [outline.title, outline.sections, sections],
  );

  if (failed) {
    return (
      <MarkdownAnswer
        galleries={[]}
        markdown={citeToLinks(gluedSource, citationMap)}
        meta={citedMeta}
        onCite={onCiteLocal}
        settled={settled}
      />
    );
  }

  const onPrint = () => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    // The continuous reveal makes every page measurable: start the paper
    // only after the mode-switch effect has run the overflow fit -- the
    // clone then carries each page's inline scale (a hidden page's fit
    // never had time to measure; this gives it a beat)
    setMode("stacked");
    window.setTimeout(() => {
      const rootEl = rootRef.current;
      if (!rootEl) {
        return;
      }
      const sources: PrintSource[] = citedSourceRows(printMap, meta).map((source) => ({
        n: source.local,
        title: source.t,
        netloc: source.domain,
      }));
      // the paper is SELF-CONTAINED: its chips renumber to [1..N] in
      // first-citation order (the tail follows the same map) -- the
      // rewrite runs on the CLONE, the live deck keeps its global chips
      const clone = rootEl.cloneNode(true) as HTMLElement;
      applyLocalCiteNumbers(clone, printMap);
      printDocument({
        title: outline.title,
        fileTag,
        paper: "deck",
        hint: t("print_hint_webview"),
        source: clone,
        sources,
        sourcesLabel: t("ai_search_sources"),
        closeLabel: t("print_close"),
        dropSelectors: ["[data-deck-chrome]"],
      });
    }, 120);
  };

  // Citation chip's delegated click: citeToLinks' #ref-n anchors join the
  // citation-locate chain
  // (anchor and label are both document-local numbers -- converting back
  // to the global registry number lives in this one lambda)
  const onCanvasClick = (event: React.MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#ref-"]');
    if (!anchor) {
      return;
    }
    const local = Number.parseInt(/^#ref-(\d+)$/.exec(anchor.getAttribute("href") ?? "")?.[1] ?? "", 10);
    if (Number.isInteger(local) && local > 0) {
      event.preventDefault();
      onCiteLocal(local);
    }
  };

  return (
    <div className="deck-root" data-fullscreen={fullscreen || undefined} data-mode={mode} ref={rootRef}>
      <style dangerouslySetInnerHTML={{ __html: HOST_CSS }} />
      {css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null}

      {/* The slide canvas: ALWAYS the full DOM (the page turn toggles
          hidden per section through the effect); part containers carry the
          marpit class -- the theme scoping selector div.marpit > section
          holds per container */}
      <div
        className="deck-stage"
        onTouchEnd={(event) => {
          const start = touchX.current;
          touchX.current = null;
          if (start === null || mode !== "paged") {
            return;
          }
          const dx = (event.changedTouches[0]?.clientX ?? start) - start;
          if (Math.abs(dx) > 48) {
            goTo((prev) => prev + (dx < 0 ? 1 : -1));
          }
        }}
        onTouchStart={(event) => {
          touchX.current = event.touches[0]?.clientX ?? null;
        }}
        ref={stageRef}
      >
        {/* The citation chip's delegation container: citeToLinks' #ref-n
            anchors are focusable in their own right and
            Enter-reachable (click events join the citation-locate chain
            here, uniformly) */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: event delegation container -- the interactive children (citation anchors) bring their own keyboard reachability */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: an anchor's Enter already fires the same click event, no synthetic key handling needed */}
        <div className="deck-canvas" onClick={onCanvasClick} ref={canvasRef}>
          {partsHtml.map((part) => (
            <div
              className="deck-part marpit"
              dangerouslySetInnerHTML={{ __html: part.html }}
              data-deck-part={part.key}
              key={part.key}
            />
          ))}
        </div>
      </div>

      {/* Speaker notes panel: follows the current slide in paged mode
          (escaped at compile time) */}
      {showNotes && mode === "paged" && (current?.notes ?? "") !== "" ? (
        <div
          className="mt-3 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm leading-relaxed text-ink-2 [&_p]:m-0 [&_p+p]:mt-1.5"
          dangerouslySetInnerHTML={{ __html: current?.notes ?? "" }}
          data-deck-chrome
        />
      ) : null}

      {/* Control bar: always rendered (mount-time insertion would push the
          content below down, counting as CLS).
          Stacked mode keeps only the mode switch and fullscreen; the page
          turn controls appear/disappear with paged mode. */}
      {total > 0 ? (
        <div className="mt-3 flex items-center gap-1.5" data-deck-chrome>
          {mode === "paged" ? (
            <>
              <button
                aria-label={t("deck_prev")}
                className={ICON_BTN}
                disabled={active === 0}
                onClick={() => goTo((prev) => prev - 1)}
                type="button"
              >
                <ChevronLeft aria-hidden="true" className="size-4" />
              </button>
              <span className={cn(META_ROW, "min-w-14 text-center tabular-nums")}>
                {active + 1} / {total}
              </span>
              <button
                aria-label={t("deck_next")}
                className={ICON_BTN}
                disabled={active === total - 1}
                onClick={() => goTo((prev) => prev + 1)}
                type="button"
              >
                <ChevronRight aria-hidden="true" className="size-4" />
              </button>
            </>
          ) : null}

          <span className="flex-1" />

          {!settled ? <span className={cn(META_ROW, "text-accent")}>{t("deck_writing")}</span> : null}
          {mode === "paged" ? (
            <button
              aria-label={t("deck_notes")}
              aria-pressed={showNotes}
              className={cn(ICON_BTN, showNotes && "bg-surface-2 text-ink")}
              onClick={() => setShowNotes((v) => !v)}
              type="button"
            >
              <StickyNote aria-hidden="true" className="size-4" />
            </button>
          ) : null}
          <button
            className={cn(CHIP, "transition-colors hover:border-accent hover:text-accent")}
            onClick={() => setMode(mode === "paged" ? "stacked" : "paged")}
            type="button"
          >
            {mode === "paged" ? t("deck_mode_stacked") : t("deck_mode_paged")}
          </button>
          {settled ? (
            <button
              aria-label={t("deck_print")}
              className={ICON_BTN}
              onClick={onPrint}
              title={t("deck_print")}
              type="button"
            >
              <Printer aria-hidden="true" className="size-4" />
            </button>
          ) : null}
          <button
            aria-label={fullscreen ? t("deck_exit_fullscreen") : t("deck_fullscreen")}
            className={ICON_BTN}
            onClick={toggleFullscreen}
            type="button"
          >
            {fullscreen ? (
              <Minimize aria-hidden="true" className="size-4" />
            ) : (
              <Maximize aria-hidden="true" className="size-4" />
            )}
          </button>
        </div>
      ) : null}
    </div>
  );
}
