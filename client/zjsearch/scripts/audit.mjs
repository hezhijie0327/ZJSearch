// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * zjsearch Lighthouse gate — `npm run audit`.
 *
 * Boots a throwaway granian on :8907 with audit-settings.yml and runs
 * Lighthouse over the home page plus one page per result presentation
 * (offline fixture engine, see below), then fails when a category drops
 * below the thresholds.
 *
 * The gate is fully OFFLINE: audit-settings.yml reduces the engine list to
 * `zjaudit` (searx/engines/zjsearch_fixtures.py), a deterministic offline
 * engine whose fixture sets are keyed by the query token (zjaudit
 * general/images/videos/music/files/science/apps).  Remote engines would
 * make the audited pages variance-sensitive — timeouts, captchas and dead
 * image URLs change the page between runs.
 *
 * Raw LHR reports are archived under `.lighthouse-archive/<run>/` together
 * with a scores.json (git rev included); compare two runs with
 * scripts/audit-diff.mjs.
 *
 * Needs the venv (local/py3) and a Chromium: set CHROME_PATH when
 * chrome-launcher does not autodetect yours.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(HERE, "..");
const ROOT = resolve(CLIENT, "../..");
const PORT = 8907;
const BASE = `http://127.0.0.1:${PORT}`;
const ARCHIVE_ROOT = process.env.LH_ARCHIVE_DIR ?? join(CLIENT, ".lighthouse-archive");

/** Desktop is the default gate; LH_FORM_FACTOR=mobile opts into the harsher
    mobile throttling profile. */
const MOBILE = process.env.LH_FORM_FACTOR === "mobile";

/** One gate page per result presentation: the general list (infobox +
    suggestions) and the dedicated category layouts — image masonry,
    video/music/apps grids, torrent grid, science papers, IT packages.
    The `zjaudit <kind>` token picks the fixture set (see
    searx/engines/zjsearch_fixtures.py). */
const SEARCH_PATHS = [
  "/search?q=zjaudit+general",
  "/search?q=zjaudit+images&categories=images",
  "/search?q=zjaudit+videos&categories=videos",
  "/search?q=zjaudit+music&categories=music",
  "/search?q=zjaudit+files&categories=files",
  "/search?q=zjaudit+science&categories=science",
  "/search?q=zjaudit+packages&categories=it",
  "/search?q=zjaudit+apps&categories=apps",
];

/** Floors.  Every search page's SEO category is EXEMPT (null): upstream
    robots.txt disallows `/*?*q=*` and upstream wants search pages
    unindexed — correct behaviour, not a theme defect.  The fixture engine
    makes the pages deterministic, so the floors are enforceable without
    live-engine variance. */
function thresholdsFor(path) {
  if (path === "/") {
    return MOBILE
      ? { performance: 85, accessibility: 100, "best-practices": 100, seo: 95, "agentic-browsing": 100 }
      : { performance: 90, accessibility: 100, "best-practices": 100, seo: 95, "agentic-browsing": 100 };
  }
  return MOBILE
    ? { performance: 80, accessibility: 100, "best-practices": 100, seo: null, "agentic-browsing": 100 }
    : { performance: 90, accessibility: 100, "best-practices": 100, seo: null, "agentic-browsing": 100 };
}

const PATHS = [
  { path: "/", thresholds: thresholdsFor("/") },
  ...SEARCH_PATHS.map((path) => ({ path, thresholds: thresholdsFor(path) })),
  /** The no-JS face, materialised by the gate: Lighthouse needs script
      execution, so the gate strips every <script> and unwraps the
      <noscript> wrappers of the streamed page — the resulting document is
      what a JS-disabled browser renders. */
  {
    path: "/static/audit-nojs.html",
    thresholds: MOBILE
      ? { performance: 85, accessibility: 100, "best-practices": 100, seo: 95, "agentic-browsing": 100 }
      : { performance: 90, accessibility: 100, "best-practices": 100, seo: 95, "agentic-browsing": 100 },
  },
  /** The 404 screen: ignoreStatusCode lets Lighthouse audit the document.
      Its SEO category is exempt — a 404 failing "successful status code"
      and crawlability is correct behaviour. */
  {
    path: "/this-page-does-not-exist",
    ignoreStatusCode: true,
    thresholds: MOBILE
      ? { performance: 85, accessibility: 100, "best-practices": 90, seo: null, "agentic-browsing": 100 }
      : { performance: 90, accessibility: 100, "best-practices": 90, seo: null, "agentic-browsing": 100 },
  },
];

/** granian executable of the repo venv (Windows and POSIX venv layouts). */
function venvBin(name) {
  const candidates =
    process.platform === "win32"
      ? [join(ROOT, "local", "py3", "Scripts", `${name}.exe`), join(ROOT, "local", "py3", "Scripts", name)]
      : [join(ROOT, "local", "py3", "bin", name)];
  return candidates.find((p) => existsSync(p));
}

/** Short git identity embedded into the archive summary. */
function gitInfo() {
  const run = (args) => {
    try {
      return execSync(`git ${args}`, { cwd: ROOT }).toString().trim();
    } catch {
      return "unknown";
    }
  };
  return { rev: run("rev-parse --short HEAD"), dirty: run("status --porcelain").length > 0 };
}

async function waitFor(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`audit server did not come up at ${url}`);
}

// Lighthouse internals can leak unhandled rejections on transient trace
// aborts (e.g. PROTOCOL_TIMEOUT mid-gather) — keep the gate alive and let
// the per-page error handling report it instead.
process.on("unhandledRejection", (reason) => {
  console.log(`  … ignored internal rejection: ${String(reason?.message ?? reason).slice(0, 120)}`);
});

async function main() {
  const built = join(ROOT, "searx", "static", "zjsearch.min.js");
  if (!existsSync(built)) {
    throw new Error("zjsearch.min.js is not synced into searx/static — run the theme build first");
  }
  const granian = venvBin("granian");
  if (!granian) {
    throw new Error("granian not found in local/py3 — run the venv bootstrap first (see AGENTS.md)");
  }

  const env = {
    ...process.env,
    SEARXNG_SETTINGS_PATH: join(CLIENT, "audit-settings.yml"),
    GRANIAN_INTERFACE: "wsgi",
    GRANIAN_HOST: "127.0.0.1",
    GRANIAN_PORT: String(PORT),
  };
  // Windows: searx.valkeydb imports the POSIX-only pwd module; the shim also
  // normalizes backslash static paths (see AGENTS.md).  A private copy keeps
  // the gate self-contained instead of leaning on a machine-specific shim.
  if (process.platform === "win32") {
    const shimDir = join(process.env.TEMP ?? HERE, "zjs-audit-shim");
    await mkdir(shimDir, { recursive: true });
    await writeFile(
      join(shimDir, "pwd.py"),
      [
        "import os",
        "from collections import namedtuple",
        "Passwd = namedtuple('Passwd', ['pw_name', 'pw_uid', 'pw_gid', 'pw_gecos', 'pw_dir', 'pw_shell'])",
        "",
        "",
        "def getpwuid(uid):",
        "    return Passwd('unknown', uid, 0, '', '', '')",
        "",
        "",
        "# Windows dev shim: get_static_file_list returns os.sep paths while",
        "# webapp.custom_url_for compares with forward slashes.",
        "try:",
        "    import searx.webutils as _wu",
        "",
        "    _orig = _wu.get_static_file_list",
        "",
        "",
        "    def _posix_file_list():",
        "        return [f.replace('\\\\', '/') for f in _orig()]",
        "",
        "    _wu.get_static_file_list = _posix_file_list",
        "except Exception:",
        "    pass",
        "",
      ].join("\n"),
    );
    env.PYTHONPATH = env.PYTHONPATH ? `${shimDir};${env.PYTHONPATH}` : shimDir;
  }

  const runDir = join(
    ARCHIVE_ROOT,
    `${new Date().toISOString().replace(/[:.]/g, "-")}${MOBILE ? "-mobile" : "-desktop"}`,
  );
  const scores = { form_factor: MOBILE ? "mobile" : "desktop", git: gitInfo(), pages: {} };
  const NOJS_PORT = 8908;

  console.log(`booting offline audit instance on :${PORT} …`);
  // granian's stderr surfaces (boot errors would otherwise die silently
  // behind the waitFor timeout)
  const server = spawn(granian, ["searx.webapp:app"], { cwd: ROOT, env, stdio: ["ignore", "ignore", "inherit"] });
  let chrome;
  let nojsServer;
  let failed = false;
  try {
    await waitFor(`${BASE}/`);
    // materialise the no-JS face: Lighthouse needs script execution, so the
    // gate serves a stripped copy of the streamed page — every <script>
    // removed and the <noscript> wrappers unwrapped, which renders exactly
    // what a JS-disabled browser sees.  Relative asset URLs are re-pointed
    // at the audit instance and the copy is served from a private :8908
    // server (writing into the instance's static tree does not work — its
    // file listing is built at boot).
    {
      const html = await (await fetch(`${BASE}/search?q=zjaudit+general`)).text();
      const robotsTxt = await (await fetch(`${BASE}/robots.txt`)).text();
      const stripped = html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<link rel="manifest"[^>]*>/gi, "")
        .replace(/<\/?noscript[^>]*>/gi, "")
        .replaceAll(/(src|href)="\/static\//g, `$1="${BASE}/static/`);
      const http = await import("node:http");
      const llmsTxt = [
        "# ZJSearch audit instance",
        "",
        "> Offline fixture instance for the zjsearch Lighthouse gate",
        " (deterministic results served by the zjaudit engine).",
        "",
        "## Pages",
        "",
        "- [Home](https://example.com/zjaudit): fixture home page",
        "- [Results](https://example.com/zjaudit/search): fixture results",
      ].join("\n");
      nojsServer = http.createServer((_req, res) => {
        // Lighthouse fetches /robots.txt and /llms.txt from the audited
        // origin — serve the instance's real robots.txt and a fixture
        // llms.txt, not this HTML page
        if (_req.url === "/robots.txt") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(robotsTxt);
          return;
        }
        if (_req.url === "/llms.txt") {
          res.writeHead(200, { "Content-Type": "text/markdown" });
          res.end(llmsTxt);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(stripped);
      });
      await new Promise((resolve) => nojsServer.listen(NOJS_PORT, "127.0.0.1", resolve));
      console.log(`no-JS face served on :${NOJS_PORT}`);
    }
    const { launch } = await import("chrome-launcher");
    chrome = await launch({ chromeFlags: ["--headless=new"] });
    const lighthouse = (await import("lighthouse")).default;
    // desktop preset: the desktop-config preset wires form factor, screen
    // emulation and the (mild) desktop throttling in one go
    const config = MOBILE ? undefined : (await import("lighthouse/core/config/desktop-config.js")).default;

    /** One Lighthouse run.  Headless Chrome occasionally aborts a trace
        (Lantern "missing metric scores" / interstitial errors) — those come
        back as all-zero categories and are retried once. */
    async function runPage(url, ignoreStatusCode) {
      let lastError;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const pageConfig = ignoreStatusCode
            ? { ...(config ?? {}), settings: { ...(config?.settings ?? {}), ignoreStatusCode: true } }
            : config;
          const result = await lighthouse(url, { port: chrome.port, output: "json" }, pageConfig);
          const lhr = result.lhr;
          const allZero = Object.values(lhr.categories).every((c) => (c.score ?? 0) === 0);
          if (!allZero) {
            return lhr;
          }
          lastError = new Error(lhr.runtimeError?.message ?? "all categories scored 0 (load error)");
        } catch (error) {
          lastError = error;
        }
        if (attempt === 1) {
          console.log("  … lighthouse trace failed, retrying once");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      throw lastError;
    }

    for (const { path, thresholds, ignoreStatusCode } of PATHS) {
      console.log(`\n${path}${MOBILE ? "  (mobile)" : ""}`);
      let lhr;
      try {
        lhr = await runPage(
          path.startsWith("/static/audit-nojs") ? `http://127.0.0.1:8908/nojs.html` : `${BASE}${path}`,
          ignoreStatusCode,
        );
      } catch (error) {
        failed = true;
        console.log(`  ERROR: ${String(error.message ?? error).slice(0, 160)}`);
        continue;
      }
      await mkdir(runDir, { recursive: true });
      const slug = path.replace(/^\/+/, "").replace(/[?&=/]+/g, "_") || "home";
      await writeFile(join(runDir, `${slug}.lhr.json`), JSON.stringify(lhr));
      const pageScores = {};
      for (const [cat, threshold] of Object.entries(thresholds)) {
        const score = Math.round((lhr.categories[cat]?.score ?? 0) * 100);
        const gated = threshold !== null;
        const ok = !gated || score >= threshold;
        failed = failed || !ok;
        pageScores[cat] = score;
        console.log(
          `  ${cat.padEnd(16)} ${String(score).padStart(3)}  (${gated ? `min ${threshold}` : "exempt"})${ok ? "" : "  FAIL"}`,
        );
      }
      scores.pages[path] = pageScores;
      for (const category of Object.values(lhr.categories)) {
        for (const ref of category.auditRefs) {
          const audit = lhr.audits[ref.id];
          if (
            audit &&
            audit.score !== null &&
            audit.score !== undefined &&
            audit.score < 1 &&
            !["manual", "notApplicable"].includes(audit.scoreDisplayMode)
          ) {
            console.log(`    ! ${audit.id}${audit.displayValue ? ` (${audit.displayValue})` : ""}`);
          }
        }
      }
    }
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "scores.json"), JSON.stringify(scores, null, 2));
    console.log(`\narchived: ${runDir}`);
  } finally {
    if (chrome) {
      // chrome-launcher's Windows profile cleanup can throw after the
      // browser is already gone — the audit result is unaffected
      try {
        await chrome.kill();
      } catch {}
    }
    server.kill();
    if (nojsServer) {
      nojsServer.close();
    }
  }

  console.log(failed ? "\naudit FAILED" : "\naudit passed");
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
