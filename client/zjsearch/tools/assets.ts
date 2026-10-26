// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Build-time brand assets: copy theme SVGs and rasterize the PWA/favicon PNGs
 * into the served static folder (searx/static/themes/zjsearch/img/).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, gzipSync, constants as zlibConstants } from "node:zlib";
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
      // transparent full-bleed rasters (DESIGN.md §2.2: transparent ground, usable on light and dark backgrounds as-is)
      const sizes: Array<[string, number]> = [
        ["favicon.png", 512],
        ["192.png", 192],
        ["512.png", 512],
      ];
      for (const [file, size] of sizes) {
        await sharp(src, { density: 300 }).resize(size, size).png().toFile(path.join(imgDir, file));
      }
      // apple-touch gets the family fixed light base + safe margin (iOS fills
      // transparent areas with black — DESIGN.md §2.2 solid base + safe margin)
      const glyph = await sharp(src, { density: 300 }).resize(138, 138).png().toBuffer();
      await sharp({ create: { width: 180, height: 180, channels: 4, background: "#faf9f6" } })
        .composite([{ input: glyph, gravity: "centre" }])
        .png()
        .toFile(path.join(imgDir, "apple-touch-icon.png"));
      // the PWA maskable variant: the same recipe at 512 (the mark holds the
      // 80% safe zone; Android's circular mask crops the fixed base, not
      // the mark)
      const maskable = await sharp(src, { density: 300 }).resize(410, 410).png().toBuffer();
      await sharp({ create: { width: 512, height: 512, channels: 4, background: "#faf9f6" } })
        .composite([{ input: maskable, gravity: "centre" }])
        .png()
        .toFile(path.join(imgDir, "maskable-512.png"));

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
      // the PGlite WORKER SIDE: vite emits the worker AND its Emscripten
      // bundles at the dist ROOT (pglite/initdb wasm, the pglite.data FS
      // bundle, the three extension tars), and the worker resolves EVERY one
      // of them against `self.location` -- i.e. /static/pg.worker-*.js's own
      // directory, the static root.  A missing bundle is not a graceful
      // degradation: the FS bundle check throws (`Invalid FS bundle size`)
      // inside the worker, PGliteWorker.create never resolves, and boot()
      // falls back to the MAIN-THREAD engine -- every store write (the live
      // run's 1.5s evt flush above all) then runs WASM Postgres + the
      // IndexedDB fsync on the main thread, the research page's ~1s freezes
      // (the "page unresponsive" jam).  REBUILT from scratch like chunk/: a hash
      // change must not leave stale artifacts at the static root.
      const workerArtifact = /^(pglite|initdb|vector|pg_trgm|pg_textsearch).*\.(wasm|data|gz|br)$/;
      for (const file of await fs.readdir(rootStatic)) {
        if (workerArtifact.test(file) || /^pg\.worker.*\.js(\.(gz|br))?$/.test(file)) {
          await fs.rm(path.join(rootStatic, file), { force: true });
        }
      }
      for (const file of await fs.readdir(PATH.dist)) {
        if (workerArtifact.test(file) || /^pg\.worker.*\.js$/.test(file)) {
          await fs.copyFile(path.join(PATH.dist, file), path.join(rootStatic, file));
        }
      }
      // THE DIST COPY DIES HERE: the served copies live at the static root
      // (the built worker bakes ONLY those hashed URLs -- grep-verified),
      // so the dist originals are dead weight in every deployment that
      // ships searx/ wholesale (~16.6MB per image).  Deleted only while
      // UNLINKED (st.nlink === 1): nlink > 1 means an out-of-band hardlink
      // flow shares the inode (the Windows local-verification links into
      // themes/zjsearch) -- deleting our name there saves no space and
      // would leave the flow's link sources missing.  emptyOutDir rebuilds
      // them next build either way.
      let distFreed = 0;
      for (const file of await fs.readdir(PATH.dist)) {
        if (!workerArtifact.test(file) && !/^pg\.worker.*\.js$/.test(file)) {
          continue;
        }
        const distFile = path.join(PATH.dist, file);
        const st = await fs.stat(distFile);
        if (st.nlink > 1) {
          continue;
        }
        distFreed += st.size;
        await fs.rm(distFile, { force: true });
      }
      if (distFreed > 0) {
        console.log(
          `zjsearch-assets: dist dedup freed ${(distFreed / 1024 / 1024).toFixed(1)}MB (served copies live at the static root)`,
        );
      }
      // the CSS chunks' url(...) references (KaTeX woff2/woff/ttf) resolve
      // against the root-level CSS files -> /static/assets/...
      // THE UNHASHED TWINS SHIP: vite/emscripten also emit assets/pglite.wasm,
      // pglite.data, initdb.wasm and the three plain tar.gz, and the
      // MAIN-THREAD fallback engine (worker-less webviews: module workers
      // unsupported or blocked) resolves exactly these unhashed names
      // relative to /static/assets/ -- the live verification caught every
      // one 404ing into the FS-bundle size check (live diagnosis
      // 2026-10-26).  The worker's baked URLs are the hashed static-root
      // names only (grep-verified -- `assets/` appears nowhere in
      // pg.worker-*.js), so the worker lane ignores these copies.  They
      // change only with the pglite version and keep their literal names,
      // so they stay on WhiteNoise's DEFAULT caching (no immutable).
      await fs.cp(path.join(PATH.dist, "assets"), path.join(rootStatic, "assets"), { recursive: true });
      const rootChunk = path.join(rootStatic, "chunk");
      await fs.rm(rootChunk, { force: true, recursive: true });
      await fs.cp(path.join(PATH.dist, "chunk"), rootChunk, { recursive: true });
      await gzipPublished(rootStatic);
    },
  };
}

/** WhiteNoise (the static layer in webapp.py) never compresses on the fly:
    it only serves on-disk ``.gz``/``.br`` SIBLINGS of a file, negotiated by
    Accept-Encoding (verified against whitenoise 6.12).  Without this pass
    the PGLite engine's WASM + FS bundles (~16MB raw) and the JS chunks ride
    every cold page load / store boot UNCOMPRESSED -- and the first AI
    search of a browser session pays that on its critical path (the recall
    lane boots the store before the run's POST can fire).  gzip-9 + brotli-9
    at build time: ~16.6MB -> ~5.4MB gz / ~4.9MB br on the wire (~3x); the
    Docker image's own find step (`client/zjsearch/Dockerfile`) brotlis at
    --best and overwrites these for its filter set.  Identity clients and
    every already-compressed artifact (the extension tars, woff2) are
    skipped by the gain guard.  A fresh sibling takes effect only after the
    instance restart -- the same rule the bundles already follow (WhiteNoise
    indexes files once at import). */
const GZIPPABLE = /\.(js|css|wasm|data|json|ttf|svg)$/;

async function gzipPublished(rootStatic: string): Promise<void> {
  // ONLY the published roots (top level + chunk/ + assets/): a blind
  // recursive walk spills .gz siblings into themes/ -- the upstream simple
  // theme's COMMITTED static dir included (observed, cleaned).
  let saved = 0;
  const compress = async (file: string): Promise<void> => {
    const raw = await fs.readFile(file);
    if (raw.length < 1024) return;
    const gz = gzipSync(raw, { level: 9 });
    if (gz.length < raw.length * 0.9) {
      await fs.writeFile(`${file}.gz`, gz);
      saved += raw.length - gz.length;
    }
    const br = brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } });
    if (br.length < raw.length * 0.9) {
      await fs.writeFile(`${file}.br`, br);
      saved += raw.length - br.length;
    }
  };
  for (const entry of await fs.readdir(rootStatic, { withFileTypes: true })) {
    if (entry.isFile() && GZIPPABLE.test(entry.name) && !entry.name.endsWith(".gz")) {
      await compress(path.join(rootStatic, entry.name));
    }
  }
  for (const sub of ["chunk", "assets"]) {
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(file);
        } else if (entry.isFile() && GZIPPABLE.test(entry.name) && !entry.name.endsWith(".gz")) {
          await compress(file);
        }
      }
    };
    await walk(path.join(rootStatic, sub));
  }
  if (saved > 0) {
    console.log(`zjsearch-assets: gzip siblings wrote ${(saved / 1024 / 1024).toFixed(1)}MB off the wire`);
  }
}
