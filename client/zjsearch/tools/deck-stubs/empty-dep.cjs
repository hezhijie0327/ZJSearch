// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// Stub for marp-core's two heavyweight dependencies (DESIGN.md §5.2 deck
// family contract): the kernel statically requires mathjax-full
// (megabyte-scale) and highlight.js's full language registry at module top
// level, while the deck compilation pins its config to math: "katex" +
// highlight: () => "" -- those two code paths never execute.  The bundler
// alias points both require groups at this file: a Proxy that "is"
// everything (any property access / call / construct returns itself), so
// the kernel's top-level destructuring passes safely and the lazy chunk
// only carries marpit + markdown-it + katex.
// When upgrading marp-core, re-check this file too (a new top-level
// require needs a new alias entry).
const stub = new Proxy(() => {}, {
  get: (_target, prop) => (prop === "__esModule" ? false : stub),
  apply: () => stub,
  construct: () => stub,
});

module.exports = stub;
