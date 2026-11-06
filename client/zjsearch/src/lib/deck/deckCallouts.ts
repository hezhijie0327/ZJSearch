// The deck flavour of Obsidian Callouts (a markdown-it port; the vocabulary
// and output structure align with tools/callouts.ts -- all ten categories
// map through the same table, the emitted
// div.callout.callout-<category> / details+summary structure is identical,
// and the colors map from deckTheme.css's category classes onto site tokens).
//
// Implementation: a core rule scans blockquote_open … blockquote_close
// pairs; when the first paragraph's inline starts with [!alias][+-], the
// container tag and class are rewritten and the title prefix stripped
// (title = the rest of the line, defaulting to the capitalized alias;
// `-`/`+` are the fold switches).  Types are minimal structural
// declarations: md-core's state/token shape is stable across markdown-it
// versions, avoiding a dependency on markdown-it's type export shape.

interface DeckToken {
  type: string;
  tag: string;
  content: string;
  children: DeckToken[] | null;
  attrSet: (name: string, value: string) => void;
}

interface DeckCoreState {
  tokens: DeckToken[];
  Token: new (type: string, tag: string, nesting: number) => DeckToken;
}

/** Every built-in Obsidian alias → color category (same table as
    tools/callouts.ts -- never drift) */
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

export function deckCallouts(md: {
  core: { ruler: { push: (name: string, fn: (state: DeckCoreState) => void) => void } };
}): void {
  md.core.ruler.push("deck_callouts", (state) => {
    const tokens = state.tokens;

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]?.type !== "blockquote_open") {
        continue;
      }
      // find the paired blockquote_close (cascading count guards against
      // nested quotes interfering)
      let depth = 0;
      let close = -1;
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j]?.type === "blockquote_open") {
          depth += 1;
        } else if (tokens[j]?.type === "blockquote_close") {
          if (depth === 0) {
            close = j;
            break;
          }
          depth -= 1;
        }
      }
      if (close === -1) {
        continue;
      }
      // the callout syntax sits at the start of the first paragraph's
      // inline: blockquote_open → paragraph_open → inline
      const open = tokens[i];
      const pOpen = tokens[i + 1];
      const inline = tokens[i + 2];
      const closeToken = tokens[close];
      if (!open || !pOpen || !inline || !closeToken) {
        continue;
      }
      if (pOpen.type !== "paragraph_open" || inline.type !== "inline") {
        continue;
      }
      const match = /^\[!([\w-]+)\]([+-])?\s*(.*)/.exec(inline.content);
      if (!match) {
        continue;
      }
      const alias = (match[1] ?? "").toLowerCase();
      const category = CALLOUT_CATEGORY[alias];
      if (!category) {
        continue;
      }
      const fold = match[2]; // '-' collapsed by default, '+' expanded by default, absent = not foldable
      const customTitle = (match[3] ?? "").trim();
      const title = customTitle || alias.charAt(0).toUpperCase() + alias.slice(1);

      // container retag (details/summary when foldable, same semantics as
      // the remark version's hName)
      const containerTag = fold ? "details" : "div";
      open.tag = containerTag;
      closeToken.tag = containerTag;
      open.attrSet("class", `callout callout-${category}`);
      if (fold && fold === "+") {
        open.attrSet("open", "");
      }

      // title segment: paragraph gets a new tag + class, the inline content
      // is replaced with the title text
      pOpen.tag = fold ? "summary" : "p";
      pOpen.attrSet("class", "callout-title");
      inline.content = title;
      const firstChild = inline.children?.[0];
      if (firstChild && firstChild.type === "text") {
        firstChild.content = title;
      } else {
        const textToken = new state.Token("text", "", 0);
        textToken.content = title;
        inline.children = [textToken];
      }
    }
  });
}
