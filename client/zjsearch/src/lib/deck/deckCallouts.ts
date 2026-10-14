// deck 版 Obsidian Callouts（markdown-it 移植，词汇表与输出结构与
// tools/callouts.ts 对齐——十类别配色映射同一张表，输出的
// div.callout.callout-<category> / details+summary 结构一致，
// 配色由 deckTheme.css 的 category 类映射到站点 token）。
//
// 实现：core 规则扫描 blockquote_open … blockquote_close 配对，首段
// inline 以 [!alias][+-] 开头即改写容器 tag 与 class，并剥掉标题前缀
// （标题 = 同行剩余文字，缺省用别名首字母大写；`-`/`+` 为折叠开关）。
// 类型用最小结构声明：md-core 的 state/token 形态跨 markdown-it 版本
// 稳定，避免依赖 markdown-it 的类型导出形态。

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

/** Obsidian 全部内置别名 → 配色类别（与 tools/callouts.ts 同表，勿漂移） */
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
      // 找配对的 blockquote_close（级联计数防嵌套引用干扰）
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
      // callout 语法在首段 inline 的行首：blockquote_open → paragraph_open → inline
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
      const fold = match[2]; // '-' 默认收起，'+' 默认展开，无则不可折叠
      const customTitle = (match[3] ?? "").trim();
      const title = customTitle || alias.charAt(0).toUpperCase() + alias.slice(1);

      // 容器换型（可折叠时 details/summary，同 remark 版 hName 语义）
      const containerTag = fold ? "details" : "div";
      open.tag = containerTag;
      closeToken.tag = containerTag;
      open.attrSet("class", `callout callout-${category}`);
      if (fold && fold === "+") {
        open.attrSet("open", "");
      }

      // 标题段：paragraph 换 tag + 类，inline 内容替换为标题文字
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
