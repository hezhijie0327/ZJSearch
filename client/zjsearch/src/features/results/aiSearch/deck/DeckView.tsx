// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * 幻灯片播放器（AI Search 的 DECK 产物视图）——ZJBlog
 * src/features/deck/DeckViewer.tsx 的孪生组件（DESIGN.md §5.2 家族契约），
 * 三处结构性差异来自「渲染运行时流式产物」：
 *
 *  1. 输入是 outline + 逐节 markdown（而非编译好的 HTML）：编译器
 *     （lib/deck/compile.ts，marp-core）按需懒加载，每个 part（封面 +
 *     每个有内容的 outline 节）独立编译并缓存——settled 节的 slides 字符串
 *     不变就不重编，流式尾节以 350ms 节流重编，未变的 part 不换 innerHTML，
 *     mermaid 岛（按元素跟踪）不闪。
 *  2. 画布是「多个 div.marpit 容器」而非一个：marpit 主题 scoping 选择器
 *     `div.marpit > section` 对每个容器独立成立；翻页/打印对画布下全部
 *     section 统一编号（DOM 序 = 封面 + outline 序）。
 *  3. 引用 chip：节 markdown 先过 citeToLinks（[n] → #ref-n 链接，与答案
 *     管线同一分词器），编译后锚点直接带上 chip 外观（主题 CSS），画布级
 *     委托点击接回引用定位链。无 JS 分词、无第二套引用正则。
 *
 * 与博客共享的机制逐字同源：tan/atan2 纯 CSS 缩放、翻页（键盘/按钮/触滑）、
 * 备注、paged↔stacked、双轨全屏（webview 回落，状态驱动而非 :fullscreen）、
 * 打印走视口无关等比缩放流（HOST_CSS 的 print 段随克隆进纸面，marpit 自带
 * @page 1280×720 接管逐页分页）。
 */

import { ChevronLeft, ChevronRight, Maximize, Minimize, Printer, StickyNote } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownAnswer, MermaidBlock } from "@/features/results/AiSummary.tsx";
import type { AiSourceMeta } from "@/features/results/aiOverview.ts";
import { fitVisibleSlides, observeLateContent } from "@/features/results/aiSearch/deck/deckFit.ts";
import { buildCitationMap, citedOrder, citedSourceRows, citeToLinks } from "@/lib/citations.ts";
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
  /** 逐节 markdown（timeline 的 section 缓冲） */
  sections: Record<string, string>;
  meta: AiSourceMeta[];
  onCite: (n: number) => void;
  settled: boolean;
  /** 打印文件名后缀（线程页 8 字 id） */
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

/** 切分逐页 HTML（marpit 的 section 不嵌套，可安全非贪婪匹配）。 */
function splitSlides(html: string): ParsedSlide[] {
  return [...html.matchAll(/<section\b[\s\S]*?<\/section>/g)].map((match) => {
    const raw = match[0] ?? "";
    const notes = /<aside class="deck-notes">([\s\S]*?)<\/aside>/.exec(raw)?.[1] ?? "";
    return { slide: raw.replace(/<aside class="deck-notes">[\s\S]*?<\/aside>/, ""), notes };
  });
}

/** 封面页（lead 变体）：outline 的 title/subtitle 铸成幻灯片——结构归大纲，
 *  内容归模型，封面是确定性的。日期行让投屏时「这份材料是什么时候的」
 *  不必开口问。 */
function coverMarkdown(outline: DeckViewOutline): string {
  const lines = ["<!-- _class: lead -->", "", `# ${outline.title}`, ""];
  if (outline.subtitle) {
    lines.push(outline.subtitle, "");
  }
  lines.push(new Date().toISOString().slice(0, 10), "");
  return lines.join("\n");
}

/** 宿主样式：ZJBlog DeckViewer HOST_CSS 的孪生（打印/预览段两侧同步），
 *  差异：无 shiki 暗态切换（代码块走 token 自身翻转）；stacked 跨 part
 *  边界的分隔线补一条。 */
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
/* 逐页：stage 锁 16:9，画布绝对定位在原点缩放 */
.deck-root[data-mode="paged"] .deck-stage { aspect-ratio: 16 / 9; }
.deck-root[data-mode="paged"] .deck-canvas { position: absolute; left: 0; top: 0; }
.deck-root[data-mode="paged"] .deck-canvas section { animation: deck-slide-in 0.28s ease; }
@keyframes deck-slide-in {
  from { opacity: 0; transform: translateX(14px); }
  to { opacity: 1; transform: none; }
}
/* 连续：part 内相邻页以分隔线相连（高度由 JS 按缩放后实际值同步到 stage） */
.deck-root[data-mode="stacked"] .deck-canvas section + section,
.deck-root[data-mode="stacked"] .deck-canvas .deck-part + .deck-part > section:first-child {
  border-top: 1px solid var(--line);
}
/* 演讲者备注不进画布（逐页模式下由 React 面板展示当前页备注） */
.deck-root .marpit section .deck-notes { display: none; }
/* 全屏放映：由 React 状态（data-fullscreen）驱动样式而非 :fullscreen 伪类
 * ——webview/预览环境里原生 Fullscreen API 常是「半残」的（DOM 状态进了、
 * 视图不展开、fullscreenchange 不派发），样式挂在状态上保证任何环境点按钮
 * 都有可见反应；伪全屏 = fixed 覆盖层，真全屏下同样适用。控制条留屏。 */
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
/* 舞台上的横滑交给 JS 翻页，纵滑留给页面滚动 */
.deck-stage {
  touch-action: pan-y;
}
/* 逐页模式的非当前页：Tailwind preflight 的 [hidden] 是 layered !important
 * （unlayered 规则按层反转规则必输），因此换页用自定义属性 + 自带规则 */
.deck-canvas section[data-slide-hidden] {
  display: none !important;
}
/* ── 打印 / 预览纸面：视口无关的等比缩放流（ZJBlog a0913bf 同款）。
 * 桌面 Chrome/Edge 按 marpit 自带的 @page 1280×720（横屏）布局，缩放自然
 * 归一为 1；iOS AirPrint 等不支持 @page size 的管线里缩放跟随打印布局宽度
 * （cqw 自适应），一页一条不截断。chrome 隐藏、隐藏页揭示、逐块防裂。
 * 本组件的 HOST_CSS 随 printDocument 的克隆进纸面，规则在克隆里同样生效。
 * @media print 与 html.zjs-print-view（预览脸，lib/print.ts）两份列表同步。
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
/** 流式尾节的编译节流：写阶段每 350ms 至多重编一次（marp 单节渲染是
 *  几十毫秒级），settled 后立即出终稿。 */

export function DeckView({ outline, sections, meta, onCite, settled, fileTag }: DeckViewProps) {
  const t = useT();
  // THE DOCUMENT-LOCAL CITATION MAP (the DocumentView contract): the
  // slides' stored [n] are the run's global registry numbers; the deck
  // reads [1..N] in first-citation order -- chips, the fallback markdown
  // view and the print tail share the one map.
  const citationMap = useMemo(() => {
    const texts = outline.sections.map((section) => sections[section.id] ?? "").filter(Boolean);
    const knownNs = new Set(meta.map((source) => source.n).filter((n): n is number => Number.isInteger(n)));
    return buildCitationMap(texts, knownNs.size > 0 ? knownNs : undefined);
  }, [outline.sections, sections, meta]);
  const citedMeta = useMemo(() => citedSourceRows(citationMap, meta), [citationMap, meta]);
  const order = citedOrder(citationMap);
  const onCiteLocal = (local: number) => {
    const globalN = order[local - 1];
    if (globalN != null) {
      onCite(globalN);
    }
  };
  const [mode, setMode] = useState<"paged" | "stacked">("paged");
  const [active, setActive] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  // 全屏双轨：原生 Fullscreen API 在 webview/预览环境里可能半残（DOM 状态
  // 进了但视图不展开、事件不派发），promise 拒绝或不可用时回落伪全屏
  const [nativeFs, setNativeFs] = useState(false);
  const [pseudoFs, setPseudoFs] = useState(false);
  const [css, setCss] = useState("");
  const [partsHtml, setPartsHtml] = useState<DeckPartHtml[]>([]);
  const [failed, setFailed] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const touchX = useRef<number | null>(null);
  // 编译缓存（key → 源文本 + 产物）：settled 节的 slides 不变就不重编
  const compileCache = useRef(new Map<string, { src: string; html: string }>());
  const cssCache = useRef("");
  // mermaid 岛按元素跟踪：未变的 part 不换 DOM，岛不重挂
  const islandsRef = useRef(new Map<HTMLElement, Root>());

  // 流式重编译的签名：封面文案 + 各节文本长度（追加式流）+ settled 位
  const signature = useMemo(
    () =>
      `${outline.title}\n${outline.subtitle ?? ""}\n${outline.sections
        .map((s) => `${s.id}:${(sections[s.id] ?? "").length}`)
        .join("|")}|${settled ? 1 : 0}`,
    [outline.title, outline.subtitle, outline.sections, sections, settled],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: signature 字符串就是依赖集本身（封面文案 + 各节长度 + settled）——闭包在它变化时取到最新引用
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
        // 编译器加载失败（chunk 404 级别的事故）：降级为 markdown 视图由
        // 调用方兜底（failed 位驱动），不让一张坏卡片杀掉回答
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

  // 函数式更新：快速连按/同帧多次事件也不会基于过期 active 计算
  const goTo = useCallback(
    (next: number | ((prev: number) => number)) => {
      setActive((prev) => {
        const target = typeof next === "function" ? next(prev) : next;
        return Math.max(0, Math.min(total - 1, target));
      });
    },
    [total],
  );

  // 换页 = 对全量 DOM 逐节切换 hidden（打印/预览需要全部页面常驻文档）；
  // display:none ↔ block 会自动重放 CSS 换页动画。可见节就地补 aria 语义。
  // 切换后对新可见的页跑溢出适配（display:none 页量不出尺寸，翻到即量）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 显式依赖 partsHtml——编译产物进 DOM 后需重放 hidden 与 aria
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

  // 迟到内容（mermaid svg 替换占位符、图片加载）触发的溢出重测——chart
  // 渲染后原页可能从「装得下」变「装不下」
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    return observeLateContent(canvas);
  }, []);

  // mermaid 占位容器（compile 产出）：逐个挂 MermaidBlock 惰性渲染——渲染器
  // 自带进入视口门控（隐藏页不触发，翻到即渲染）与打印浅色联动。岛按元素
  // 跟踪：未变的 part 不换 DOM，已渲染的图不闪；换下的元素随 innerHTML 失效，
  // 连接断开即卸载。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 显式依赖 partsHtml——DOM 由此而来，岛挂载跟随编译产物而非其引用
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

  // 原生全屏状态同步（Esc / 系统手势退出也要落回按钮态）
  useEffect(() => {
    const onFullscreenChange = () => setNativeFs(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  // 伪全屏退出：Esc（原生全屏的 Esc 由浏览器自己处理）
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

  // 连续模式：stage 高度 = 缩放后画布实际高度（transform 不参与布局）
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

  // 逐页模式：窗口级键盘翻页
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
      // 乐观置位：fullscreenchange 不派发的环境也要落回按钮态
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

  // 编译器不可用（懒加载 chunk 404 级别的事故）：降级为 markdown 视图——
  // 幻灯片源本来就是 markdown，走答案管线照常可读可引用
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
    // 连续揭示让所有页可测量：模式切换的 effect 跑完溢出适配后再起纸，
    // 克隆携带每页的 inline 缩放——隐藏页的适配来不及量，这里给一拍
    setMode("stacked");
    window.setTimeout(() => {
      const rootEl = rootRef.current;
      if (!rootEl) {
        return;
      }
      const sources: PrintSource[] = citedSourceRows(citationMap, meta).map((source) => ({
        n: source.local,
        title: source.t,
        netloc: source.domain,
      }));
      printDocument({
        title: outline.title,
        fileTag,
        paper: "deck",
        hint: t("print_hint_webview"),
        source: rootEl,
        sources,
        sourcesLabel: t("ai_search_sources"),
        closeLabel: t("print_close"),
        dropSelectors: ["[data-deck-chrome]"],
      });
    }, 120);
  };

  // 引用 chip 的委托点击：citeToLinks 产出的 #ref-n 锚点接回引用定位链
  // （锚点与标签都是文档局部号——换算回全局注册表号在这一个 lambda 里）
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

      {/* 幻灯片画布：恒为全量 DOM（换页由 effect 逐节 hidden）；part 容器
          挂 marpit 类——主题 scoping 选择器 div.marpit > section 逐容器成立 */}
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
        {/* 引用 chip 的委托容器：citeToLinks 产出的 #ref-n 锚点自身可聚焦、
            Enter 可达（click 事件统一在此接引用定位链） */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: 事件委托容器——可交互子元素（引用锚点）自带键盘可达 */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: 锚点的 Enter 已触发同一 click 事件，无需合成键处理 */}
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

      {/* 演讲者备注面板：逐页模式下跟随当前页（compile 期已转义） */}
      {showNotes && mode === "paged" && (current?.notes ?? "") !== "" ? (
        <div
          className="mt-3 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm leading-relaxed text-ink-2 [&_p]:m-0 [&_p+p]:mt-1.5"
          dangerouslySetInnerHTML={{ __html: current?.notes ?? "" }}
          data-deck-chrome
        />
      ) : null}

      {/* 控制条：始终渲染（挂载后插入会把下方内容顶下去，计入 CLS）。
          堆叠模式只留模式切换与全屏；翻页控件随逐页模式出现/消失。 */}
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
