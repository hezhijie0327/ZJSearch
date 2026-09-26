# AUDIT.md — zjsearch audit playbook

The reusable methodology for a full-theme audit. It compresses what the
2026-09 full audit did (and learned the hard way) so the next audit is:
bootstrap → gates → test matrix → measurements → fixes → regress → docs.

Goal setting: audit in rounds until a round adds no findings. Every fix
re-runs the regression for its area AND the lint gates; every round ends
with findings landed in AGENTS.md / DESIGN.md (§17 governance) so the same
mistake is never audited twice.

## 1. Environment bootstrap

```sh
# venv (first time only) + runtime deps; pinned dev tools are optional
./manage pyenv.install
local/py3/bin/pip install -r requirements.txt        # + granian if missing

# dev instance — run granian DIRECTLY: `manage webapp.run` re-runs pip and
# a mirror serving 0-byte wheels (ustc did once) fails the hash check.
# ZJSEARCH_AI_KEY is required for the AI overview: LM Studio VALIDATES the
# bearer token, the auth-free placeholder "none" gets a 401.
SEARXNG_SETTINGS_PATH=$PWD/client/zjsearch/dev-settings.yml \
ZJSEARCH_AI_KEY='<key from the secret store, never into the repo>' \
GRANIAN_INTERFACE=wsgi GRANIAN_HOST=127.0.0.1 GRANIAN_PORT=8888 \
  nohup local/py3/bin/granian searx.webapp:app > /tmp/zjsearch-dev.log 2>&1 &

# WhiteNoise snapshots the static dir at boot: after publishing new
# root-level assets, RESTART or new files 404 (existing files serve stale
# ETags for up to 30 s — reload twice before concluding anything).
```

LM Studio (or any OpenAI-compatible endpoint) must be up for AI tests;
`curl -s http://127.0.0.1:1234/v1/models` is the connectivity check.

## 2. Quality gates (every round, before browser work)

```sh
make themes.zjsearch                        # full build (also publishes static root)
cd client/zjsearch && pnpm run lint         # biome + tsc --noEmit
pnpm run audit                              # Lighthouse gate — needs Chrome installed
```

The zjsearch client is a pnpm workspace (`pnpm-lock.yaml` + `packageManager`);
`pnpm install --frozen-lockfile` is the only install path in scripts. The
upstream simple theme stays on npm — never let the two lockfiles mix.

Python (only when searx/ changed; exact manage-pinned options, Windows
variants in AGENTS.md):

```sh
local/py3/bin/python -m black --check --target-version py311 --line-length 120 \
  --skip-string-normalization --exclude "(searx/static|searx/languages.py)" \
  --include 'searxng.msg|\.pyi?$' <changed .py files>
local/py3/bin/python -m pylint --rcfile .pylintrc --ignore-paths=searx/engines <changed .py files>
```

## 3. Dependency updates (every audit round)

pnpm — `pnpm outdated` lists what moved; apply in-range updates via

```sh
cd client/zjsearch && pnpm outdated
pnpm update                                  # in-range updates, refreshes pnpm-lock.yaml
pnpm add -D @biomejs/biome@<new pin>         # for exactly-pinned dev deps
```

- HOLD major jumps for a separate decision — never ride a major through an
  unrelated audit. Standing example: typescript `~5.9` -> 7.x (the Go-based
  rewrite) was left unadopted at the 2026-09 audit; read its release notes
  and adopt deliberately, with the full matrix re-run.
- After updating: `pnpm run lint` + `make themes.zjsearch`, RESTART the
  instance (new hashes), then regress the surfaces that exercise the
  moved packages — the AI overview (react-markdown / remark-* / katex /
  mermaid / lucide-react), a grid page (ol), and the streamed boot (vite
  output shape feeds the static-root publishing contract).

python — the three AI SDK transports live in requirements.txt as exact
pins; bump only when the index is actually ahead, then reinstall, restart,
and re-run the LM Studio AI test (they have exactly one consumer,
`searx/zjsearch_ai.py`):

```sh
local/py3/bin/pip index versions openai
local/py3/bin/pip index versions anthropic
local/py3/bin/pip index versions google-genai
```

- The rest of requirements.txt is upstream-owned: check for awareness,
  update only with an upstream reason (an upstream commit that needs it),
  so rebases stay conflict-free.

## 4. Functional test matrix

Offline fixtures first (deterministic, no network): queries containing the
`zjaudit` token hit `searx/engines/zjsearch_fixtures.py` — see the module
for the token list (`zjaudit general`, `zjaudit images`, `zjaudit videos`,
…); `&categories=` forces the single-category layout. Append a cache-buster
(`&r=Date.now()`) when re-testing after a rebuild.

| Surface | Query / URL | Expect |
|---|---|---|
| Direct URL boot | `/search?q=test` (no homepage hop) | React mounts, results render |
| Zero results | `zzxxqq11223344 +notpresentwordxyz` (`+` = `%2B`) | engines panel open, NO pager, Sorry state |
| Themes | `simple_style=light/dark/black` cookie | palette flips, skeleton included |
| Mobile | 390×844 viewport | filter rows swipe, no layout break |
| Wide | 1920 / centered-mode toggle | container-query grids re-step |
| Preferences | drawer, all 5 tabs | row language uniform, autosave toast |
| About/Stats | header icon buttons | drawer panels, internal links browse in-panel |
| 404 / NoJS / RSS | `/nonexistent`, noscript block, `format=rss` | canonical faces (rss.xsl self-contained) |
| AI Overview | results page → AI Overview trigger | stream, thinking fold, [n] chips, show more, regen, copy |
| AI failure UX | point `zjsearch.ai.base_url` at a dead port | 502 body reason readable under the card's failed label |

Plugin answers (server-side; test via curl §6, not the browser):

| Query | Expected answer `kind` |
|---|---|
| `md5 hello` / `sha256 abc` | hash |
| `time tokyo` AND `time in tokyo` | time (filler word regression) |
| `random string` / `random int` | value (+swatch) |
| `min 2 8` / `max 1 5 3` / `avg 4 6` | stats |
| `kg to lb`, `usd to cny` | unit_conversion |
| `5 usd to eur in gbp` | unit_conversion → **usd→eur**, never usd→gbp |
| `$AAPL` (=`%24AAPL`), `AAPL stock` | stock (mind the URL encoding!) |
| `user-agent`, `ip` | self |
| `python site:docs.python.org` | only that domain survives |
| `test -wikipedia.org` | **zero** wikipedia hits (-domain promotion) |
| `test -site:en.wikipedia.org` | same, explicit form |
| `"finite state machine"` | exact phrase |

## 5. Browser measurement recipes (browser-use)

The in-app browser has THREE documented failure modes that fake product
bugs. Probe BEFORE concluding anything:

1. **Jammed compositor** (rAF starvation): transitions snap, rAF-driven
   opens never fire, timers clamp, screenshots serve stale frames.
   Probe: `await Promise.race([new Promise(r => requestAnimationFrame(r)),
   new Promise(r => setTimeout(() => r("JAMMED"), 1500))])`. If jammed →
   close the tab, open a fresh one, re-measure. **Measurements taken in a
   jam are void** (a healthy animation once "proved" broken this way).
2. **Stale screenshot frames**: DOM can be correct while the capture lags.
   Verify state via DOM (`aria-expanded`, computed `gridTemplateRows`,
   `getBoundingClientRect().height`), use screenshots only for final
   visual confirmation. Nudge with `scrollBy(0, 1)` + wait before capturing.
3. **Smooth scrolling silently disabled**: this webview drops EVERY native
   smooth scroll — `scrollIntoView({behavior:"smooth"})`,
   `window.scrollTo({behavior:"smooth"})` and CSS `scroll-behavior:smooth`
   all no-op (no animation AND no jump) while instant scrolling, CSS
   transitions and rAF stay healthy. Probe: sample `window.scrollY` per
   frame around a `scrollTo({top: X, behavior:"smooth"})` — 0 moves with a
   live rAF = this trap. Never call a "broken" animation until this probe
   is clean; the theme's own `animateScroll` tween
   (`src/lib/motion.ts`) exists precisely because of it (fixed citation
   jumps / hotkeys / BackToTop "no scroll animation" in one stroke).
4. **Dead locators / dead keyboard injection**: if Playwright locator
   clicks time out but `elementsFromPoint` shows the target on top, fall
   back to CUA coordinates; if synthetic keydown never reaches the page,
   CUA `type`/`keypress` carries real input events.

Animation measurement (the reusable sampler — attach BEFORE the action):

```js
const panel = /* the Collapse wrapper: '[class*="grid-template-rows"]' */;
const events = [];
["transitionrun", "transitionend", "transitioncancel"].forEach(ev =>
  panel.addEventListener(ev, e => events.push(ev + "@" + e.elapsedTime.toFixed(2)), true));
const samples = []; const t0 = performance.now();
(function sample() { samples.push(Math.round(panel.getBoundingClientRect().height));
  if (performance.now() - t0 < 800) requestAnimationFrame(sample); })();
trigger.click();  // then compare: first vs min vs last sample + events non-empty
```

A healthy 300 ms Collapse shows first≈146 → min 0 (or reverse), 2+ events.
Judge disclosure state by `aria-expanded` + panel height, never by eye.

Waiting for streamed pages: never trust `goto` (the late chunk can exceed
navigation timeouts) — poll `document.querySelector("#app")` innerText for
`/Found \d+ results|找到 \d+ 条/` in 1.5–2 s intervals.

## 6. Server-side inspection (answers & contracts)

Plugin/answer testing bypasses the browser — the answer is fully formed in
page-data:

```sh
curl -s -m 60 "http://127.0.0.1:8888/search?q=<urlencoded>" | python3 -c "
import sys, json, re
html = sys.stdin.read()
m = re.search(r'<script id=\"page-data\" type=\"application/json\">(.*?)</script>', html, re.DOTALL)
data = json.loads(m.group(1))
print(json.dumps(data.get('answers') or [], ensure_ascii=False)[:400])
print('results:', len(data.get('results') or []))"
```

Watch for multiple `#page-data` blocks (stream-recovery path — the client
prefers the LAST parseable one). Contract sync checks: walk
`data/macros.html` vs `lib/types.ts` field-by-field per result template and
answer kind; check every serialized key has a consumer.

## 7. Code audit dimensions (the sweep)

Dispatch parallel read-only Explore agents (client / server) with the layer
rules and the shared-token inventory from AGENTS.md, covering:

0. **Structure/naming/reuse** — duplicated JSX blocks, hand-typed tokens
   (CHIP/PILL/SEGMENT_*), reinvented hostname/date/number formatting, dead
   exports (grep-verify each claim), parts-file naming, layer inversions.
1. **Performance** — bundle sizes, eager graph, lazy boundaries, memo on
   hot trees (results during AI streaming).
2. **Animation completeness** — every conditional render either animates
   in/out or is a sanctioned instant swap; every disclosure has
   `aria-expanded`; hover/press transitions on every interactive element.
   The IndexPage options panel and in-thumbnail iframes were past gaps.
3. **Plugin behaviour** — the §4 matrix plus edge cases (CJK terms,
   multi-keyword queries, unknown locations = silence).
4. **Icons** — text-only controls next to icon-paired siblings.
5. **Design tokens** — light/dark/black sweeps, widescreen/centered,
   contrast tiers, skeleton geometry vs real page (boot.css drift audit).
6. **Result cards** — every category layout renders its full presentation;
   field-shape tolerance (filesize string|number, timedelta variants).
7. **Interface uniformity** — preferences tabs share the row language;
   empty/final states share the composition language; zero-result pages
   carry no pager.
8. **AI feature** — LM Studio live test (stream, citations, thinking,
   regenerate, copy) + backend review (timeouts, silence contracts, token
   gate, image SSRF path).
9. **A11y** — icon-only buttons labelled, dialogs named + focus-trapped,
   `alt` on images, keyboard reachability.

## 8. Known environment traps

- `pnpm run audit` needs Chrome (`ChromeNotInstalledError`) —
  not a theme regression; run on a machine with Chrome.
- `manage`-anything re-runs pip; a mirror serving 0-byte wheels fails the
  hash check → start granian directly (§1) and/or pin `-i` to a working
  index.
- Template edits need an instance restart (Jinja caches compiled
  templates); python edits too (no reload in this start mode).
- In-app-browser screenshots may serve a STALE compositor frame right
  after load/animation — nudge and wait (§5).
- `$AAPL` is `%24AAPL` — a mis-encoded test vector once sent the audit
  chasing a non-existent stock-plugin bug. Double-check encodings before
  suspecting the code.

## 9. Closing the loop

1. Fix → rebuild (`make themes.zjsearch`) → restart instance (WhiteNoise +
   Jinja caches) → regress the touched area in the browser AND the plugin
   matrix via curl.
2. Lint gates (§2) until clean; pylint must hold 10.00/10.
3. Land every lesson: AGENTS.md (contracts, gotchas, debugging recipes)
   and DESIGN.md §5 (new fragments are registered BEFORE landing in code).
4. Commit in the house style — granular `[fix]/[mod]/[docs] theme
   zjsearch: …` commits; docs separate from code; never commit build
   output (static-root artifacts are git-ignored).
