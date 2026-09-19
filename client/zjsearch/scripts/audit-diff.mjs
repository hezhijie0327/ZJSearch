// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Compare two Lighthouse gate archives — `npm run audit:diff -- <runA> <runB>`.
 *
 * Each run directory (`.lighthouse-archive/<timestamp>/`) holds a
 * `scores.json` plus the raw `*.lhr.json` reports written by audit.mjs.
 * The diff prints per-page, per-category score deltas so a commit's impact
 * is visible at a glance.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [runA, runB] = process.argv.slice(2);
if (!runA || !runB) {
  console.error("usage: node scripts/audit-diff.mjs <archiveDirA> <archiveDirB>");
  process.exit(2);
}

function loadScores(dir) {
  return JSON.parse(readFileSync(join(resolve(dir), "scores.json"), "utf8"));
}

const a = loadScores(runA);
const b = loadScores(runB);

const label = (run) => `${run.git?.rev ?? "?"}${run.git?.dirty ? " (dirty)" : ""} · ${run.form_factor}`;
console.log(`A: ${runA}  [${label(a)}]`);
console.log(`B: ${runB}  [${label(b)}]`);

const categories = new Set();
for (const run of [a, b]) {
  for (const page of Object.values(run.pages)) {
    for (const cat of Object.keys(page)) {
      categories.add(cat);
    }
  }
}

let regressions = 0;
for (const page of new Set([...Object.keys(a.pages), ...Object.keys(b.pages)])) {
  const pa = a.pages[page];
  const pb = b.pages[page];
  if (!pa || !pb) {
    console.log(`\n${page}: only in ${pa ? "A" : "B"}`);
    continue;
  }
  console.log(`\n${page}`);
  for (const cat of [...categories].sort()) {
    if (pa[cat] === undefined || pb[cat] === undefined) {
      continue;
    }
    const delta = pb[cat] - pa[cat];
    const mark = delta < 0 ? "  ↓" : delta > 0 ? "  ↑" : "";
    if (delta !== 0) {
      regressions += delta < 0 ? 1 : 0;
    }
    console.log(
      `  ${cat.padEnd(16)} ${String(pa[cat]).padStart(3)} → ${String(pb[cat]).padStart(3)} (${delta >= 0 ? "+" : ""}${delta})${mark}`,
    );
  }
}

console.log(regressions > 0 ? `\n${regressions} score drop(s)` : "\nno score drops");
process.exit(regressions > 0 ? 1 : 0);
