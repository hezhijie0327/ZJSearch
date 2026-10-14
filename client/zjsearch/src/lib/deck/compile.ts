// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// 幻灯片编译（marp-core，Marpit 方言的超集）——ZJBlog tools/deck.ts 的孪生
// 文件（DESIGN.md §5.2 家族契约：同一编译管线跑两个站点，内核版本对钉，
// 主题 = deckTheme.css 孪生）。本侧差异即「站点缝」的取值：模型内容
// （html: false——raw HTML 转义为可见文本，注入的标签不会执行）、无 shiki
// （代码 fence 保留转义代码块）、无本地文件系统（imageSizes 关）、独立
// deck（标题不降级）。方言边界与产物约定见 ZJBlog 侧文件头注：已桥接
// mermaid（占位容器 + 播放器挂渲染器）、数学 KaTeX、callouts、==mark==、
// emoji、任务清单、定义列表；Typora sequence/flow 翻译是博客构建期专属，
// 本侧方言不教也不接。
//
// 产物约定（与 DeckView.tsx、printDocument 三方对齐）：
//   - section 的 id 一律剥掉换成 data-slide（多个 part 同页会撞
//     duplicate-id 审计）；演讲者备注（HTML 注释）注入每页 .deck-notes；
//   - 模型内容禁 raw HTML：html:false 下 marpit 指令注释与备注解析不受
//     影响（实测确认），注入的标签渲染为可见转义文本——信任模型。

import { Marp } from "@marp-team/marp-core";
import { mark } from "@mdit/plugin-mark";
import { tasklist } from "@mdit/plugin-tasklist";
import markdownItDeflist from "markdown-it-deflist";
import { deckCallouts } from "./deckCallouts.ts";
import deckThemeCss from "./deckTheme.css?raw";

export interface DeckResult {
  /** 逐页 section HTML（含 data-slide 标号，无容器） */
  slides: string[];
  /** marpit 生成的完整样式（主题 scoping 到 div.marpit > section + 归一化，
   *  含 @page 1280×720——打印纸面据此逐页 break） */
  css: string;
  count: number;
}

/** 站点缝（DESIGN.md §5.2 家族契约，ZJBlog tools/deck.ts DeckCompileOptions
 *  的孪生）：缺省值 = 本站行为（模型内容、无 shiki、无图尺寸、标题保留）。 */
export interface DeckCompileOptions {
  /** 源内 raw HTML：true = 可信作者直通（博客侧）；false = 转义为可见文本
   *  （模型内容——指令注释与演讲者备注的解析不受影响，实测确认） */
  html?: boolean;
  /** 代码 fence 高亮器（吃解码后的代码，返回 HTML）；缺省保留 markdown-it
   *  默认形态（转义代码块）——博客侧传站内 shiki 双主题 pass */
  highlight?: (lang: string, code: string) => string;
  /** 站内图注入固有尺寸（博客侧的 unsized-images 审计）；运行时渲染器
   *  没有本地文件系统，本站恒关 */
  imageSizes?: boolean;
  /** 标题整体降一级（博客侧 h1 让给文章标题）；独立 deck 保留作者层级 */
  demoteHeadings?: boolean;
}

// 内核参数把 marp-core 调高的默认值全部钉回 Marpit 语义——DeckView 与打印
// 契约建立在普通 <section> 流上：inlineSVG 关、breaks/linkify 关、标题不产
// id（duplicate-id 审计）、不注入浏览器 helper <script>；fence 高亮让回
// markdown-it 默认形态（内置 hljs 的 class 形态吃不进占位桥接正则）。
//
// 双实例：开数学的实例产 HTML；marp-core 只要开着数学就会把整套 KaTeX CSS
// （@font-face 指向 jsDelivr CDN）追加进渲染 css，而页面已随结果页样式装入
// katex.min.css（AiSummary 的静态 import），deck css 不需要也不该重复背它
// ——css 与内容无关，用 math:false 的孪生实例空渲染取纯主题 css。实例按
// (math × html) 组合惰性缓存，工厂保证同组合配置不漂移。
function createMarp(math: boolean, html: boolean): Marp {
  const marp = new Marp({
    inlineSVG: false,
    looseYAML: false,
    cssContainerQuery: false,
    emoji: { shortcode: true, unicode: false },
    math: math ? "katex" : false,
    script: false,
    slug: false,
    markdown: {
      html,
      breaks: false,
      linkify: false,
      highlight: () => "",
    },
  });
  marp.use(deckCallouts);
  marp.use(mark);
  marp.use(tasklist);
  marp.use(markdownItDeflist);
  marp.themeSet.default = marp.themeSet.add(deckThemeCss);
  return marp;
}

const marpCache = new Map<string, Marp>();

function getMarp(math: boolean, html: boolean): Marp {
  const key = `${math ? 1 : 0}${html ? 1 : 0}`;
  let marp = marpCache.get(key);
  if (!marp) {
    marp = createMarp(math, html);
    marpCache.set(key, marp);
  }
  return marp;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

function decodeEntities(text: string): string {
  const el = document.createElement("textarea");
  el.innerHTML = text;
  return el.value;
}

/** 单页后处理：标题降级（可选）→ mermaid 占位 / fence 高亮 → 剥 id 加
 *  data-slide → 注入演讲者备注。站点缝经 options 生效。 */
function postProcessSlide(
  page: string,
  index: number,
  notes: readonly string[],
  options: { html: boolean; highlight?: (lang: string, code: string) => string; demoteHeadings: boolean },
): string {
  let html = page;
  if (options.demoteHeadings) {
    // 页面 h1 属文章标题，幻灯片页题从 h2 起（博客侧；本站独立 deck 保留层级）
    html = html.replace(
      /<(\/?)h([1-5])(?=[\s>])/g,
      (_match, slash: string, level: string) => `<${slash}h${Number(level) + 1}`,
    );
  }
  html = html.replace(
    /<pre><code(?: class="language-([\w#+.-]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (match, lang: string | undefined, code: string) => {
      const decoded = decodeEntities(code);
      // mermaid 走站内同款占位容器：DeckView 挂 MermaidBlock 惰性渲染，
      // 打印浅色联动自动生效（语法与答案词汇表一致）
      if (lang === "mermaid") {
        return `<div class="mermaid-placeholder" data-chart="${escapeAttr(decoded)}"></div>`;
      }
      return options.highlight ? options.highlight(lang ?? "", decoded) : match;
    },
  );
  // 任务清单复选框纯装饰，补 aria-hidden（与答案管线 remark 链同款）
  html = html.replace(/<input((?:(?!aria-hidden)[^>]*)?type="checkbox"[^>]*)>/g, '<input aria-hidden="true"$1>');
  html = html.replace(/^<section\b([^>]*)>/, (_match, attrs: string) => {
    const cleaned = attrs.replace(/\s+id="[^"]*"/g, "");
    return `<section data-slide="${index + 1}"${cleaned}>`;
  });
  // 正文包一层 .deck-body：DeckView 的溢出适配（deckFit，ZJBlog 孪生）对它
  // 做等比缩放 + 宽度补偿——固定 720px 画布上超高的页整页缩小落进画布，
  // 而不是被 overflow 裁掉。备注 aside 在 wrapper 之外（注入发生在其后）。
  html = html.replace(
    /^(<section\b[^>]*>)([\s\S]*)<\/section>\s*$/,
    (_match, open: string, inner: string) => `${open}<div class="deck-body">${inner}</div></section>`,
  );
  if (notes.length > 0) {
    const body = notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("");
    html = html.replace(/<\/section>\s*$/, `<aside class="deck-notes">${body}</aside></section>`);
  }
  return html;
}

/** Markdown（Marpit 方言）→ 逐页 HTML + 主题 CSS。模型输出是半可信的：本
 *  函数 fail-closed（编译错误上抛），DeckView 捕获后降级为 markdown 视图，
 *  不让一张坏卡片杀掉整个回答。 */
export function compileDeck(markdown: string, options: DeckCompileOptions = {}): DeckResult {
  const resolved: {
    html: boolean;
    highlight?: (lang: string, code: string) => string;
    imageSizes: boolean;
    demoteHeadings: boolean;
  } = {
    html: options.html ?? false,
    highlight: options.highlight,
    imageSizes: options.imageSizes ?? false,
    demoteHeadings: options.demoteHeadings ?? false,
  };
  // marpit 的 front-matter 插件要求指令块位于文档第 0 个字符——前导空白
  // 会让指令块漏解析，`---` 被当成 markdown 渲染（ZJBlog 侧实测）
  const source = markdown.replace(/^\s+/, "");
  const marp = getMarp(true, resolved.html);
  const { html: pages, comments } = marp.render(source, { htmlAsArray: true });
  const { css } = getMarp(false, resolved.html).render("");
  const list = Array.isArray(pages) ? pages : [pages];
  const slides = list.map((page, index) => postProcessSlide(page, index, comments[index] ?? [], resolved));
  return { slides, css, count: slides.length };
}
