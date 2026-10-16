// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// Slide compilation (marp-core, a superset of the Marpit dialect) — the twin
// of ZJBlog's tools/deck.ts (DESIGN.md §5.2 family contract: one compilation
// pipeline runs on both sites, kernel versions pinned in lockstep, theme =
// the deckTheme.css twin).  This side's differences are exactly the "site
// seam" values: model content (html: false -- raw HTML is escaped into
// visible text, injected tags never execute), no shiki (code fences stay
// escaped code blocks), no local filesystem (imageSizes off), standalone
// deck (headings are not demoted).  See the ZJBlog side's file header for
// the dialect boundary and output contract: bridged already are mermaid
// (placeholder container + the player mounting a renderer), KaTeX math,
// callouts, ==mark==, emoji, task lists, definition lists; the Typora
// sequence/flow translation is blog-build-time only -- this side's dialect
// neither teaches nor accepts it.
//
// Output contract (three-way alignment with DeckView.tsx and printDocument):
//   - every section id is stripped and replaced with data-slide (multiple
//     parts on one page would trip the duplicate-id audit); speaker notes
//     (HTML comments) are injected into each page's .deck-notes;
//   - model content forbids raw HTML: with html:false the marpit directive
//     comments and notes parsing are unaffected (verified live), injected
//     tags render as visible escaped text -- trust the model.

import { Marp } from "@marp-team/marp-core";
import { mark } from "@mdit/plugin-mark";
import { tasklist } from "@mdit/plugin-tasklist";
import markdownItDeflist from "markdown-it-deflist";
import { deckCallouts } from "./deckCallouts.ts";
import deckThemeCss from "./deckTheme.css?raw";

export interface DeckResult {
  /** Per-page section HTML (with data-slide numbering, no wrapper) */
  slides: string[];
  /** The full stylesheet marpit generated (theme scoped to div.marpit > section
   *  + normalization, including @page 1280×720 -- the print paper breaks
   *  per page on it) */
  css: string;
  count: number;
}

/** The site seam (DESIGN.md §5.2 family contract, the twin of ZJBlog
 *  tools/deck.ts's DeckCompileOptions): defaults = this site's behavior
 *  (model content, no shiki, no image sizes, headings kept). */
export interface DeckCompileOptions {
  /** Raw HTML in the source: true = trusted-author passthrough (blog side);
   *  false = escaped into visible text (model content -- the directive
   *  comments and speaker notes parsing is unaffected, verified live) */
  html?: boolean;
  /** Code fence highlighter (takes decoded code, returns HTML); the default
   *  keeps markdown-it's default shape (escaped code blocks) -- the blog
   *  side passes its in-site shiki dual-theme pass */
  highlight?: (lang: string, code: string) => string;
  /** Inject intrinsic sizes for in-site images (the blog side's
   *  unsized-images audit); the runtime renderer has no local filesystem,
   *  always off on this site */
  imageSizes?: boolean;
  /** Demote every heading one level (the blog side gives h1 to the article
   *  title); a standalone deck keeps the author's hierarchy */
  demoteHeadings?: boolean;
}

// The kernel options pin every default marp-core raised back to Marpit
// semantics -- the DeckView and print contracts are built on a plain
// <section> flow: inlineSVG off, breaks/linkify off, headings produce no
// id (duplicate-id audit), no browser helper <script> injected; fence
// highlighting falls back to markdown-it's default shape (the built-in
// hljs class shape does not fit the placeholder bridging regex).
//
// Two instances: the math-enabled instance produces HTML; as soon as math
// is on, marp-core appends the whole KaTeX CSS (@font-face pointing at the
// jsDelivr CDN) to the rendered css, while the page already loads
// katex.min.css with the results-page styles (AiSummary's static import) --
// the deck css neither needs nor should carry it twice.  CSS is
// content-independent, so an empty render on the math:false twin instance
// yields the pure theme css.  Instances are lazily cached per (math × html)
// combination; the factory keeps the same combination's config drift-free.
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

/** Per-slide post-processing: heading demotion (optional) → mermaid
 *  placeholder / fence highlight → strip ids, add data-slide → inject
 *  speaker notes.  The site seam applies via options. */
function postProcessSlide(
  page: string,
  index: number,
  notes: readonly string[],
  options: { html: boolean; highlight?: (lang: string, code: string) => string; demoteHeadings: boolean },
): string {
  let html = page;
  if (options.demoteHeadings) {
    // the page h1 belongs to the article title, slide page titles start at
    // h2 (blog side; this site's standalone decks keep the hierarchy)
    html = html.replace(
      /<(\/?)h([1-5])(?=[\s>])/g,
      (_match, slash: string, level: string) => `<${slash}h${Number(level) + 1}`,
    );
  }
  html = html.replace(
    /<pre><code(?: class="language-([\w#+.-]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (match, lang: string | undefined, code: string) => {
      const decoded = decodeEntities(code);
      // mermaid rides the site's placeholder container: DeckView mounts
      // MermaidBlock for lazy rendering, and the print light-mode coupling
      // applies automatically (same grammar as the answer pipeline's)
      if (lang === "mermaid") {
        return `<div class="mermaid-placeholder" data-chart="${escapeAttr(decoded)}"></div>`;
      }
      return options.highlight ? options.highlight(lang ?? "", decoded) : match;
    },
  );
  // task-list checkboxes are pure decoration, add aria-hidden (same as the
  // answer pipeline's remark chain)
  html = html.replace(/<input((?:(?!aria-hidden)[^>]*)?type="checkbox"[^>]*)>/g, '<input aria-hidden="true"$1>');
  html = html.replace(/^<section\b([^>]*)>/, (_match, attrs: string) => {
    const cleaned = attrs.replace(/\s+id="[^"]*"/g, "");
    return `<section data-slide="${index + 1}"${cleaned}>`;
  });
  // the body is wrapped in .deck-body: DeckView's overflow adaptation
  // (deckFit, the ZJBlog twin) applies uniform scaling + width compensation
  // to it -- an over-tall page shrinks whole into the fixed 720px canvas
  // instead of being clipped by overflow.  The notes aside sits outside the
  // wrapper (injection happens after it).
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

/** Markdown (Marpit dialect) → per-page HTML + theme CSS.  Model output is
 *  semi-trusted: this function fails closed (compile errors propagate),
 *  DeckView catches and degrades to the markdown view -- one bad card never
 *  kills the whole answer. */
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
  // marpit's front-matter plugin requires the directive block at the
  // document's very first character -- leading whitespace makes the
  // directive block miss parsing and `---` render as markdown (verified on
  // the ZJBlog side)
  const source = markdown.replace(/^\s+/, "");
  const marp = getMarp(true, resolved.html);
  const { html: pages, comments } = marp.render(source, { htmlAsArray: true });
  const { css } = getMarp(false, resolved.html).render("");
  const list = Array.isArray(pages) ? pages : [pages];
  const slides = list.map((page, index) => postProcessSlide(page, index, comments[index] ?? [], resolved));
  return { slides, css, count: slides.length };
}
