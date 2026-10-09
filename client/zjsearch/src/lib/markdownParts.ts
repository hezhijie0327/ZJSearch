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
