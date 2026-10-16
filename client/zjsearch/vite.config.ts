// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * zjsearch theme -- Vite build configuration.
 *
 * Sources live in client/zjsearch, build output goes straight into the
 * served static folder searx/static/themes/zjsearch (same layout as the
 * upstream "simple" theme workspace).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import browserslistToEsbuild from "browserslist-to-esbuild";
import manifest from "./package.json" with { type: "json" };
import { plgAssets } from "./tools/assets.ts";

const ROOT = "../../"; // root of the git repository

const PATH = {
  brand: "src/brand/",
  dist: resolve(ROOT, "searx/static/themes/zjsearch/"),
  root: ROOT,
  src: "src/",
} as const;

// local SearXNG instance used by `pnpm run dev` (start it with: make run)
const DEV_BACKEND = process.env.ZJSEARCH_BACKEND || "http://127.0.0.1:8888";

export default {
  base: "./",

  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // marp-core (the deck compilation kernel, lazy-loaded by lib/deck/)
      // statically requires mathjax-full and highlight.js's full language
      // registry at module top level; the deck config pins
      // math: "katex" + highlight: () => "" so those two paths never run --
      // the aliases point at the Proxy stub (tools/deck-stubs/empty-dep.cjs)
      // and the deck lazy chunk never carries those two dependency trees.
      // When upgrading marp-core, re-check this alongside the stub's header.
      {
        find: /^mathjax-full.*/,
        replacement: fileURLToPath(new URL("./tools/deck-stubs/empty-dep.cjs", import.meta.url)),
      },
      {
        find: /^highlight\.js.*/,
        replacement: fileURLToPath(new URL("./tools/deck-stubs/empty-dep.cjs", import.meta.url)),
      },
    ],
  },

  publicDir: "static/",

  server: {
    port: 5175,
    proxy: Object.fromEntries(
      [
        "/search",
        "/autocompleter",
        "/preferences",
        "/clear_cookies",
        "/image",
        "/favicon_proxy",
        "/config",
        "/stats",
        "/info",
        "/about",
        "/engine_descriptions.json",
        "/opensearch.xml",
        "/manifest.json",
        "/client",
        "/favicon.ico",
        "/logo",
        // the catch-all goes last so the specific entries above win
        "/",
      ].map((path) => [path, { target: DEV_BACKEND, changeOrigin: true }]),
    ),
  },

  build: {
    target: browserslistToEsbuild(manifest.browserslist),
    assetsDir: "",
    outDir: PATH.dist,
    // build.manifest stays OFF: the emitted chunk graph (~86KB json) had no
    // reader anywhere -- the PWA manifest is the per-theme TEMPLATE rendered
    // at /manifest.json, never this static artifact
    emptyOutDir: true,
    // source maps are a debugging aid only — keep the ~1.5 MB of .map files
    // out of the deployed static folder unless they are explicitly requested
    sourcemap: process.env.ZJSEARCH_SOURCEMAP === "1",
    rollupOptions: {
      input: {
        app: `${PATH.src}/main.tsx`,
      },
      output: {
        entryFileNames: "zjsearch.min.js",
        // the results feature tree gets a STABLE chunk name so the streamed
        // results shell can pre-warm it with an inline import() while the
        // engines run (see results.html) — the home page never pays for it
        manualChunks: (id) => {
          if (id.includes("/src/features/results/") || id.includes("/src/pages/ResultsPage")) {
            return "zjs-results";
          }
          return undefined;
        },
        chunkFileNames: (chunkInfo) =>
          chunkInfo.name === "zjs-results" ? "chunk/zjs-results.min.js" : "chunk/[hash].min.js",
        assetFileNames: (asset) => {
          const [name] = asset.names;
          if (name?.endsWith(".css")) {
            return "zjsearch.min[extname]";
          }
          return "assets/[name][extname]";
        },
      },
    },
  },

  plugins: [tailwindcss(), plgAssets(PATH)],
} satisfies import("vite").UserConfig;
