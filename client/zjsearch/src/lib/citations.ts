// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The AI answers' citation grammar, one home for every reader of it:
    `[n]` / `[n,m]` chips (and the literal `[*]` = common knowledge),
    parsed and rewritten OUTSIDE code -- fenced blocks and inline spans
    hold array indexes, not citations.  Lives in lib so both the
    features/ renderers AND lib-level consumers (the thread store's
    cited-flag bookkeeping) share one parser.

    THE DOCUMENT-LOCAL RENUMBERING: the [n] in stored text are the run's
    GLOBAL registry numbers (minted at gather time -- a deep run cites
    [792]), which is plumbing no reader should see.  A self-contained
    DOCUMENT (report, answer, their print tails and markdown exports)
    renumbers its citations [1..N] in FIRST-CITATION order -- the human-
    report convention -- via `buildCitationMap` + the map-taking
    `citeToLinks`; the tail rows come from `citedSourceRows` in the SAME
    order, so body and 引用来源 always agree.  The stored event log keeps
    global numbers (replays, the continue contract and the rail's #n
    cards are untouched); the map is a render-time view, and the
    local→global translation is the call site's one lambda
    (`citedOrder(map)[local - 1]`). */

export const CITATION_RE = /\[(\d+(?:\s*[,，]\s*\d+)*)\]|\[\*\]/g;

/** Attachment framework rule IDs ([META-04], [RULE-CCM-02]) -- the
    writer cites them verbatim beside their claims (synth.py teaches
    exactly this).  Not sources: they render as code-style badges, join
    no tail list and take no click.  The hyphen segment requirement
    keeps bare [ABC] reference-style marks out. */
export const RULE_ID_RE = /\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\]/g;

/** global registry n -> document-local [1..N], insertion order =
    first-citation order. */
export type CitationMap = Map<number, number>;

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

/** The document's citation map over the texts IN READING ORDER (a
    report's summary-then-sections, an answer's single body): each
    distinct [n] gets its first-citation slot.  `knownNs` (the run's
    source registry) keeps phantom citations OUT of the numbering -- an
    [n] with no source behind it stays untouched and joins no tail.
    Fence/code-aware, like every reader of the grammar. */
export function buildCitationMap(texts: string[], knownNs?: ReadonlySet<number>): CitationMap {
  const map: CitationMap = new Map();
  let inFence = false;
  for (const text of texts) {
    for (const line of text.split("\n")) {
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
            continue;
          }
          for (const n of group.split(/\s*[,，]\s*/)) {
            const num = Number.parseInt(n, 10);
            if (Number.isInteger(num) && num > 0 && !map.has(num) && (!knownNs || knownNs.has(num))) {
              map.set(num, map.size + 1);
            }
          }
        }
      }
    }
  }
  return map;
}

/** The cited globals in first-citation order (slot k = local [k]). */
export function citedOrder(map: CitationMap): number[] {
  return [...map.keys()];
}

/** The cited rows in first-citation order, each carrying its local
    label -- the document tail's own data (print, markdown exports, the
    inspector's 来源 card).  Rows match by their `n` field, falling back
    to the positional index for n-less arrays; an unmatched slot drops. */
export function citedSourceRows<C extends { n?: number }>(map: CitationMap, rows: C[]): Array<C & { local: number }> {
  const out: Array<C & { local: number }> = [];
  for (const [globalN, local] of map) {
    const row = rows.find((item) => item.n === globalN) ?? rows[globalN - 1];
    if (row) {
      out.push({ ...row, local });
    }
  }
  return out;
}

/** One [n] / [n,m] match -> the `#ref-n` markdown links (one per number);
    `[*]` stays literal text.  With a document map the LINK text is the
    local label while the anchor keeps the local slot (the renderer's
    positional meta contract), so hover previews and clicks keep working
    unchanged; an unmapped number passes through verbatim. */
function rewriteCitation(match: string, group: string | undefined, map?: CitationMap): string {
  if (!group) {
    return match;
  }
  return group
    .split(/\s*[,，]\s*/)
    .map((n: string) => {
      const num = Number.parseInt(n, 10);
      if (map) {
        const local = map.get(num);
        if (local) {
          return `[${local}](#ref-${local})`;
        }
      }
      return `[${n}](#ref-${n})`;
    })
    .join("");
}

/** Rewrite [n] / [n,m] citations into `#ref-n` links that the markdown `a`
    override renders as citation chips -- OUTSIDE code: the rewrite runs on
    the raw markdown, so fenced blocks and inline spans must pass through
    untouched (a `[1]` in a code example is an array index, not a source).
    With a document map the chips read the LOCAL numbers (see the module
    head).  Framework rule IDs ([META-04]) become inline-code badges --
    deliberate marks, not broken citations.  Shared by the AI Overview,
    the AI Search synthesis renderer and the report/deck documents. */
export function citeToLinks(text: string, map?: CitationMap): string {
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
        .map((part, index) => {
          if (index % 2 === 1) {
            return part;
          }
          return part
            .replace(CITATION_RE, (match, group) => rewriteCitation(match, group, map))
            .replace(RULE_ID_RE, "`[$1]`");
        })
        .join("");
    })
    .join("\n");
}

/** The plain-text renumbering for exports whose body must read the same
    numbers as its tail (the markdown copy keeps the raw [n] shape, no
    links).  Unmapped numbers pass through. */
export function renumberCitations(text: string, map: CitationMap): string {
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
        .map((part, index) =>
          index % 2 === 1
            ? part
            : part.replace(CITATION_RE, (match, group: string | undefined) => {
                if (!group) {
                  return match;
                }
                return group
                  .split(/\s*[,，]\s*/)
                  .map((n: string) => {
                    const local = map.get(Number.parseInt(n, 10));
                    return local ? `[${local}]` : `[${n}]`;
                  })
                  .join("");
              }),
        )
        .join("");
    })
    .join("\n");
}
