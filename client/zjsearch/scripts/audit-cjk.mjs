// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// THE CJK AUDIT GATE: the theme's standing rule is that Chinese lives ONLY
// in the i18n material — every other shipped source (client src, server
// python, templates, build tooling, config comments) is English-only, so
// language can never leak into code the locale does not own.  This script
// enforces it inside `pnpm run lint` (part of the lint gate, `make
// themes.zjsearch.lint`).
//
// Two character classes, two policies:
//   - Han ideographs (\u3400-\u9fff etc.) are ALWAYS a violation outside
//     the allowlist — comments, strings, JSX text, anything.
//   - CJK punctuation (fullwidth ！？：（）、 and corner brackets 「」【】)
//     is allowed ONLY on regex/code-context lines — pattern data like the
//     citation splitter's `split(/[,，]/)` is functional, a hardcoded
//     `{pair.q}：` label is not.
//
// Allowlist (deliberate, keep in sync with the rule):
//   - src/lib/i18n/**  — the catalogs and the per-locale template preset
//     table are the one sanctioned home of Chinese.
//   - debugFixtures.ts — the AI debug stage's scenarios simulate zh runs;
//     their query/answer/title content is test data, not UI strings.
//   - stock_quote.py `in market_label` lines — functional detection of the
//     upstream data source's own Chinese field values.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";

const CLIENT_ROOT = process.cwd();
const REPO_ROOT = join(CLIENT_ROOT, "..", "..");

const ROOTS = [
  join(CLIENT_ROOT, "src"),
  join(REPO_ROOT, "searx", "zjsearch"),
  join(REPO_ROOT, "searx", "templates", "zjsearch"),
  join(REPO_ROOT, "searx", "plugins", "stock_quote.py"),
  ...process.argv.slice(2),
];

const EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".html", ".svg", ".yml", ".py"]);

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_PUNCT = /[\u3000-\u303f\uff01-\uff5e\uffe0-\uffef]/;
// a CJK-punctuation carrier that reads as pattern data, not display text
const CODE_CONTEXT =
  /(re\.(compile|split|match|sub|search|fullmatch|findall)|\.split\(|\.matchAll\(|\.match\(|\.exec\(|\.test\(|\.replace\(|new RegExp|=\s*\/|===|!==)/;

function isAllowlisted(relPath, line) {
  if (relPath.startsWith(`src${sep}lib${sep}i18n${sep}`) || relPath.startsWith("src/lib/i18n/")) {
    return true;
  }
  if (relPath.replaceAll(sep, "/").endsWith("debugFixtures.ts")) {
    return true;
  }
  if (relPath.replaceAll(sep, "/").endsWith("stock_quote.py") && line.includes("in market_label")) {
    return true;
  }
  return false;
}

function* walk(path) {
  const stat = statSync(path);
  if (stat.isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    yield* walk(join(path, entry));
  }
}

const violations = [];
for (const root of ROOTS) {
  let files;
  try {
    files = [...walk(root)];
  } catch {
    console.error(`audit-cjk: cannot walk ${root}`);
    process.exit(2);
  }
  for (const file of files) {
    if (!EXTS.has(file.slice(file.lastIndexOf(".")))) {
      continue;
    }
    const rel = relative(CLIENT_ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isAllowlisted(rel, line)) {
        continue;
      }
      if (HAN.test(line)) {
        violations.push({ rel, line: i + 1, text: line.trim(), kind: "Han" });
      } else if (CJK_PUNCT.test(line) && !CODE_CONTEXT.test(line)) {
        violations.push({ rel, line: i + 1, text: line.trim(), kind: "CJK punctuation" });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `audit-cjk: ${violations.length} violation(s) — Chinese lives ONLY in src/lib/i18n/ (and the allowlisted pattern data):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.kind}  ${v.rel}:${v.line}\n    ${v.text.slice(0, 140)}`);
  }
  process.exit(1);
}
console.log("audit-cjk: clean — no CJK outside the i18n material and the allowlisted pattern data");
