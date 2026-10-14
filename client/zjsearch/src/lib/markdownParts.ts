// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// The AI-markdown remark vocabulary, ONE source for every answer surface
// (DESIGN.md §5.1 family contract -- shared with ZJBlog's tools/content.ts
// + tools/callouts.ts; same categories, same semantics).  The prompts
// teach exactly what this chain renders and nothing else: a grammar the
// model emits but the renderer lacks falls back to raw text, and a
// renderer path the prompts never teach is a route for untrusted output
// nobody asked for.  Adding a grammar = update DESIGN.md §5.1, then this
// chain, then the prompt surface (spine.markdown_surface) -- in that
// order.

import type { Blockquote, Paragraph } from "mdast";
import { pandocMarkFromMarkdown } from "mdast-util-mark";
import { pandocMark } from "micromark-extension-mark";
import remarkDeflist from "remark-deflist";
import remarkEmoji from "remark-emoji";
import remarkGfm from "remark-gfm";
import type { Processor } from "unified";
import type { Node } from "unist";
import { visit } from "unist-util-visit";

// ==highlight== (Pandoc/Typora style): the micromark micro-extension joins
// the parser at the standard injection points (data lists are REPLACED by
// assignment -- read-then-push or the gfm/math extensions die with it);
// mark mdast nodes carry no official hast handler, so the tree walk stamps
// data.hName="mark" (the same mechanism as gfm delete) and the
// unknown-node fallback emits <mark>.
export const remarkMark = function remarkMark(this: Processor) {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  data.micromarkExtensions ??= [];
  data.micromarkExtensions.push(pandocMark());
  data.fromMarkdownExtensions ??= [];
  data.fromMarkdownExtensions.push(pandocMarkFromMarkdown);
  return (tree: Node) => {
    visit(tree, (node) => {
      if (node.type !== "mark") {
        return;
      }
      const mark = node as Node & { data?: { hName?: string } };
      mark.data ??= {};
      mark.data.hName = "mark";
    });
  };
};

/** Obsidian-style callouts (the GitHub-alerts superset): the first
    paragraph's `[!type] optional title` header turns the blockquote into a
    `div.callout.callout-<category>` (fold marker `-`/`+` -> a
    `details/summary` with the default open state); unknown `[!x]` types
    stay ordinary blockquotes.  The alias table is the family canon
    (ZJBlog tools/callouts.ts). */
const CALLOUT_CATEGORY: Record<string, string> = {
  note: "note",
  info: "info",
  todo: "todo",
  abstract: "success",
  summary: "success",
  tldr: "success",
  tip: "tip",
  hint: "tip",
  important: "tip",
  success: "success",
  check: "success",
  done: "success",
  question: "question",
  help: "question",
  faq: "question",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  failure: "danger",
  fail: "danger",
  missing: "danger",
  danger: "danger",
  error: "danger",
  bug: "danger",
  example: "example",
  quote: "quote",
  cite: "quote",
};

export const remarkCallouts = function remarkCallouts() {
  return (tree: Node) => {
    visit(tree, "blockquote", (node: Blockquote) => {
      const children = node.children;
      const first = children[0];
      if (first?.type !== "paragraph") {
        return;
      }
      const firstChild = first.children[0];
      if (firstChild?.type !== "text") {
        return;
      }
      const match = firstChild.value.match(/^\[!([\w-]+)\]([+-])?\s*(.*)/);
      if (!match) {
        return;
      }
      const alias = (match[1] ?? "").toLowerCase();
      const category = CALLOUT_CATEGORY[alias];
      if (!category) {
        return;
      }
      const fold = match[2]; // '-' collapsed by default, '+' expanded, absent = not foldable
      const customTitle = (match[3] ?? "").trim();
      const title = customTitle || alias.charAt(0).toUpperCase() + alias.slice(1);

      const titleNode: Paragraph = {
        type: "paragraph",
        data: {
          hName: fold ? "summary" : "p",
          hProperties: { className: ["callout-title"] },
        },
        children: [{ type: "text", value: title }],
      };

      // header marker stripped -- a first paragraph with leftover inline
      // children stays as a body paragraph
      const body: Blockquote["children"] = [];
      if (first.children.length > 1) {
        body.push({ type: "paragraph", children: first.children.slice(1) });
      }
      body.push(...children.slice(1));

      node.data = {
        hName: fold ? "details" : "div",
        hProperties: {
          className: ["callout", `callout-${category}`],
          ...(fold ? { open: fold === "+" } : {}),
        },
      };
      node.children = [titleNode, ...body];
    });
  };
};

/** The eager chain every AI-markdown surface mounts (order mirrors
    ZJBlog's content.ts); the math pipeline stays lazy beside it. */
export const SHARED_REMARK = [remarkGfm, remarkMark, remarkEmoji, remarkCallouts, remarkDeflist];

/** The family EDITORIAL recipe (DESIGN.md §5.1): every AI-content markdown
    surface (answers, report documents, the knowledge inspector) renders in
    ZJBlog's prose voice — serif body and headings, amber quote bars,
    hairline tables, accent inline code — so a copied answer reads the same
    on both sides of the family.  Class strings only; consumers spread these
    onto their react-markdown components.  Machine-voice surfaces (think
    panes, tool rows, meta) stay sans — THINK vs CONTENT still splits at a
    glance. */
export const MD = {
  // the in-prose heading chain (DESIGN.md §4, the blog's 2026-10 audit):
  // six legible steps at em of the 17px long-form root — 34 / 25.5 / 21.3 /
  // 19.1 / 17 / 14.9 — the Typography defaults were unreadable/inverted
  // (h4 same size as body, h5/h6 invisible); weights follow the plugin
  h1: "mt-5 font-serif text-[2em] font-extrabold tracking-tight text-ink first:mt-0",
  h2: "mt-5 font-serif text-[1.5em] font-bold tracking-tight text-ink first:mt-0",
  h3: "mt-4 font-serif text-[1.25em] font-bold text-ink first:mt-0",
  h4: "mt-3 font-serif text-[1.125em] font-semibold text-ink first:mt-0",
  h5: "mt-3 font-serif text-[1em] font-semibold text-ink first:mt-0",
  h6: "mt-3 font-serif text-[0.875em] font-semibold text-ink first:mt-0",
  p: "my-3 break-words first:mt-0",
  a: "font-medium text-accent underline decoration-1 underline-offset-4 transition-colors hover:text-accent-hover",
  blockquote: "my-3 border-s-2 border-accent-strong ps-4 text-ink-2",
  ul: "my-3 list-disc space-y-1.5 ps-6 first:mt-0 marker:text-ink-3",
  ol: "my-3 list-decimal space-y-1.5 ps-6 first:mt-0 marker:text-ink-3",
  li: "break-words",
  hr: "my-4 border-line",
  img: "my-3 max-w-full rounded-xl border border-line",
  /** inline code: the blog prose recipe — surface chip + the AA-safe accent
      hover tier (--accent fails 4.5:1 on --surface-2, --accent-hover passes);
      the 0.875em tier follows the 17px root (§4: 表格/代码同档惯例) */
  code: "rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.875em] text-accent-hover",
  pre: "mt-3 overflow-x-auto rounded-xl border border-line bg-surface-2 p-3 font-mono text-[0.875em] leading-relaxed text-ink",
  tableWrap: "zjs-md-table my-3 overflow-x-auto",
  table: "w-full border-collapse text-[0.875em]",
  th: "break-words border-b border-line px-2.5 py-1.5 text-start font-semibold text-ink",
  td: "break-words border-b border-line/70 px-2.5 py-1.5 align-top",
  dt: "mt-3 font-medium text-ink",
  dd: "ms-5 text-ink-2",
  /** ==mark==: the blog prose recipe — accent-soft chip, ink text */
  mark: "rounded bg-accent-soft px-0.5 text-ink",
};
