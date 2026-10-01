// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { resultHost } from "@/lib/link.ts";
import type { InfoboxData, ResultItem } from "@/lib/types.ts";

/**
 * Quick Answer context assembly (client-side by design): the numbered source
 * list is built from the page payload the browser already has, so the server
 * carries no extra payload and stays stateless across workers.  Protocol:
 * the first 5 results deep (title + snippet head),
 * the next 15 shallow (title only), then the first infobox — one numbered
 * line each.  The model cites them as [n] / [n,m] (or [*] for common
 * knowledge); the citation numbers are these source numbers.
 */

export interface AiSourceMeta {
  favicon: string;
  domain: string;
  /** result title — hover preview on citation chips */
  t: string;
  /** result url — the panel's external-open icon */
  u: string;
}

/** Favicon + domain per result (citation order) — the AI overview chips
    render these inline, Google AI Overview style. */
export function aiSourceMeta(results: ResultItem[], max = 20): AiSourceMeta[] {
  const out: AiSourceMeta[] = [];
  for (const result of results.slice(0, max)) {
    out.push({
      domain: resultHost(result.url, result.netloc, true),
      favicon: result.favicon || "",
      t: result.title_text.slice(0, 200),
      u: result.url,
    });
  }
  return out;
}

/** One inline image group the writer embedded (the server-validated
    ``zjs-images`` fence): every URL was checked against the run's image
    registry before the event flew, so the client renders blindly.  The
    answer text carries a ``{{zjs-gallery:i}}`` placeholder at the group's
    position; the tile click reuses the citation jump (its source card). */
export interface AiSearchGallery {
  url: string;
  /** the global [n] of the source the image came from */
  n: number;
  title: string;
}

/** The answer-text placeholder the server injects where a gallery fence
    stood (the fence itself never reaches the client).  Module-internal:
    only the segment splitter and the renderer here consume it. */
const GALLERY_MARK = /\{\{zjs-gallery:(\d+)\}\}/g;

export type GallerySegment = { kind: "md"; text: string } | { kind: "gallery"; index: number };

/** Split an answer into markdown and gallery-marker segments, in order --
    the markers arrive as whole deltas (the server emits them atomically),
    so a half marker never renders. */
export function splitGallerySegments(markdown: string): GallerySegment[] {
  const out: GallerySegment[] = [];
  let last = 0;
  for (const match of markdown.matchAll(GALLERY_MARK)) {
    const index = match.index ?? 0;
    if (index > last) {
      out.push({ kind: "md", text: markdown.slice(last, index) });
    }
    out.push({ kind: "gallery", index: Number.parseInt(match[1] ?? "", 10) });
    last = index + match[0].length;
  }
  if (last < markdown.length) {
    out.push({ kind: "md", text: markdown.slice(last) });
  }
  return out;
}

const DEEP_SOURCES = 5;
const SHALLOW_SOURCES = 15;
const DEEP_SNIPPET_CHARS = 800;
const INFOBOX_CHARS = 2000;

function dateOf(result: ResultItem): string {
  return result.published_date ? ` (${result.published_date.slice(0, 10)})` : "";
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Image-result URLs (full-size img_src) for the multimodal attachment, in
    relevance order and capped — the server fetches and inlines them
    (base64, the default) or passes the references through. */
export function collectAiImages(results: ResultItem[], max = 4): string[] {
  const urls: string[] = [];
  for (const result of results) {
    if (result.img_src) {
      urls.push(result.img_src);
      if (urls.length >= max) {
        break;
      }
    }
  }
  return urls;
}

export function buildAiContext(results: ResultItem[], infoboxes: InfoboxData[]): string {
  const lines: string[] = [];
  let index = 0;
  for (const result of results.slice(0, DEEP_SOURCES)) {
    index += 1;
    lines.push(
      `[${index}] ${resultHost(result.url, result.netloc)}${dateOf(result)}: ${result.title_text}: ${result.content_text.slice(0, DEEP_SNIPPET_CHARS)}`,
    );
  }
  for (const result of results.slice(DEEP_SOURCES, DEEP_SOURCES + SHALLOW_SOURCES)) {
    index += 1;
    lines.push(`[${index}] ${resultHost(result.url, result.netloc)}: ${result.title_text}`);
  }
  const infobox = infoboxes[0];
  if (infobox) {
    index += 1;
    lines.push(`[${index}] ${infobox.title}: ${htmlToText(infobox.content_html).slice(0, INFOBOX_CHARS)}`);
  }
  return lines.join("\n");
}

/** Split a streamed Quick Answer into its `<think>` block and the visible
    answer.  `thinking` is true while the block is still open (the closing
    marker has not arrived yet); markers can stream in split across chunks,
    so a prefix of the marker renders as text for a moment and self-corrects. */
export function splitAnswerStream(text: string): { think: string; answer: string; thinking: boolean } {
  const open = text.indexOf("<think>");
  if (open === -1) {
    return { think: "", answer: text, thinking: false };
  }
  const thinkStart = open + "<think>".length;
  const close = text.indexOf("</think>", thinkStart);
  if (close === -1) {
    return { think: text.slice(thinkStart), answer: "", thinking: true };
  }
  return {
    think: text.slice(thinkStart, close),
    answer: (text.slice(0, open) + text.slice(close + "</think>".length)).trim(),
    thinking: false,
  };
}

/** The run's consolidated transport meta -- the same shape the AI Search's
    finish wire event carries. */
export interface AiRunMeta {
  finish?: string | null;
  model?: string | null;
  usage?: {
    input: number;
    output: number;
    thoughts: number | null;
    cached: number;
    cache_write: number;
  } | null;
}

/** The AI Overview's raw-text wire carries that meta as a TRAILING
    sentinel line (the <think>-style control channel of a plain-text
    stream): strip it from the answer and parse it.  Only a tail that
    actually parses is consumed -- anything else passes through untouched. */
export function extractRunMeta(text: string): { meta: AiRunMeta | null; text: string } {
  const match = /<<<zjs-meta:(\{.*\})>>>\s*$/.exec(text);
  const payload = match?.[1];
  if (!payload || match === null) {
    return { meta: null, text };
  }
  try {
    return { meta: JSON.parse(payload) as AiRunMeta, text: text.slice(0, match.index).trimEnd() };
  } catch {
    return { meta: null, text };
  }
}
