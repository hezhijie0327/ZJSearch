// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Build-time brand assets: copy theme SVGs and rasterize the PWA/favicon PNGs
 * into the served static folder (searx/static/themes/zjsearch/img/).
 */

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export function plgAssets(PATH: { brand: string; dist: string; root: string }): import("vite").Plugin {
  return {
    name: "zjsearch-assets",
    apply: "build",

    async closeBundle() {
      const imgDir = path.join(PATH.dist, "img");
      await fs.mkdir(imgDir, { recursive: true });

      // serve the license so the footer link resolves
      await fs.copyFile(path.resolve("LICENSE.txt"), path.join(PATH.dist, "LICENSE.txt"));
      // serve SearXNG's own license next to it (instance info page)
      await fs.copyFile(path.resolve(PATH.root, "LICENSE"), path.join(PATH.dist, "LICENSE-SearXNG.txt"));

      const copies = ["favicon.svg", "empty_favicon.svg"] as const;
      for (const file of copies) {
        await fs.copyFile(path.resolve(PATH.brand, file), path.join(imgDir, file));
      }

      const src = path.resolve(PATH.brand, "favicon.svg");
      // transparent full-bleed rasters (DESIGN.md §2.2: 透明底，明暗背景直接可用)
      const sizes: Array<[string, number]> = [
        ["favicon.png", 512],
        ["192.png", 192],
        ["512.png", 512],
      ];
      for (const [file, size] of sizes) {
        await sharp(src, { density: 300 }).resize(size, size).png().toFile(path.join(imgDir, file));
      }
      // apple-touch gets the family fixed light base + safe margin (iOS fills
      // transparent areas with black — DESIGN.md §2.2 实底 + 安全边距)
      const glyph = await sharp(src, { density: 300 }).resize(138, 138).png().toBuffer();
      await sharp({ create: { width: 180, height: 180, channels: 4, background: "#faf9f6" } })
        .composite([{ input: glyph, gravity: "centre" }])
        .png()
        .toFile(path.join(imgDir, "apple-touch-icon.png"));

      // the app bundle URLs live at the static ROOT (/static/zjsearch.min.js —
      // webapp.custom_url_for only maps filenames that exist there), so
      // publish the bundles next to the themed assets; chunk/ is rebuilt from
      // scratch so hashes removed by this build don't linger.
      // EVERY root-level *.min.js/*.min.css artifact ships, not just the entry
      // pair: vite also emits root-level CSS chunks (zjsearch2/3.min.css —
      // KaTeX & co.) that the preload helpers resolve as siblings of the JS
      // bundles.  A missing one 404s on /search and the awaited CSS dep of
      // main.tsx's `await import(ResultsPage)` never settles — the app then
      // boots into the skeleton forever (homepage SPA navigation still worked,
      // which is why this read as "direct /search?q= URLs hang").
      const rootStatic = path.resolve(PATH.root, "searx/static");
      for (const file of await fs.readdir(PATH.dist)) {
        if (/^zjsearch.*\.min\.(js|css)$/.test(file)) {
          await fs.copyFile(path.join(PATH.dist, file), path.join(rootStatic, file));
        }
      }
      // the CSS chunks' url(...) references (KaTeX woff2/woff/ttf) resolve
      // against the root-level CSS files -> /static/assets/...
      await fs.rm(path.join(rootStatic, "assets"), { force: true, recursive: true });
      await fs.cp(path.join(PATH.dist, "assets"), path.join(rootStatic, "assets"), { recursive: true });
      const rootChunk = path.join(rootStatic, "chunk");
      await fs.rm(rootChunk, { force: true, recursive: true });
      await fs.cp(path.join(PATH.dist, "chunk"), rootChunk, { recursive: true });
    },
  };
}
