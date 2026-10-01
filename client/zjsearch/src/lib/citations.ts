// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The AI answers' citation grammar, one home for every reader of it:
    `[n]` / `[n,m]` chips (and the literal `[*]` = common knowledge),
    parsed and rewritten OUTSIDE code -- fenced blocks and inline spans
    hold array indexes, not citations.  Lives in lib so both the
    features/ renderers AND lib-level consumers (the thread store's
    cited-flag bookkeeping) share one parser. */

export const CITATION_RE = /\[(\d+(?:\s*[,，]\s*\d+)*)\]|\[\*\]/g;

/** The source numbers actually cited in a settled answer.  1-based;
    sorted, deduped. */
export function citedSourceNumbers(answer: string): number[] {
  const out = new Set<number>();
  let inFence = false;
  for (const line of answer.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    for (const part of line.split(/(`[^`]*`)/)) {
      if (part.startsWith("`")) {
        continue;
      }
      for (const match of part.matchAll(CITATION_RE)) {
        const group = match[1];
        if (!group) {
          continue; // [*] — common knowledge, no source behind it
        }
        for (const n of group.split(/\s*[,，]\s*/)) {
          const num = Number.parseInt(n, 10);
          if (Number.isInteger(num) && num > 0) {
            out.add(num);
          }
        }
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** One [n] / [n,m] match -> the `#ref-n` markdown links (one per number);
    `[*]` stays literal text. */
function rewriteCitation(match: string, group: string | undefined): string {
  if (!group) {
    return match;
  }
  return group
    .split(/\s*[,，]\s*/)
    .map((n: string) => `[${n}](#ref-${n})`)
    .join("");
}

/** Rewrite [n] / [n,m] citations into `#ref-n` links that the markdown `a`
    override renders as citation chips -- OUTSIDE code: the rewrite runs on
    the raw markdown, so fenced blocks and inline spans must pass through
    untouched (a `[1]` in a code example is an array index, not a source).
    Shared by the AI Overview and the AI Search synthesis renderer. */
export function citeToLinks(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) {
        return line;
      }
      return line
        .split(/(`[^`]*`)/)
        .map((part, index) => (index % 2 === 1 ? part : part.replace(CITATION_RE, rewriteCitation)))
        .join("");
    })
    .join("\n");
}
