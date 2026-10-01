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
# ZJSEARCH_AI_KEY feeds the LLM transport (zjsearch.llm — the endpoint
# VALIDATES the bearer token, the placeholder "none" gets a 401).
# ZJSEARCH_EMBEDDING_KEY is optional: the research library's semantic search.
SEARXNG_SETTINGS_PATH=$PWD/client/zjsearch/dev-settings.yml \
ZJSEARCH_AI_KEY='<key from the secret store, never into the repo>' \
GRANIAN_INTERFACE=wsgi GRANIAN_HOST=127.0.0.1 GRANIAN_PORT=8888 \
  nohup local/py3/bin/granian searx.webapp:app > /tmp/zjsearch-dev.log 2>&1 &

# WhiteNoise snapshots the static dir at boot: after publishing new
# root-level assets, RESTART or new files 404 (existing files serve stale
# ETags for up to 30 s — reload twice before concluding anything).
```

The configured LLM endpoint (dev-settings' `zjsearch.llm` — any
OpenAI-compatible server, or the anthropic/gemini protocol per `sdk`) must
be up for live AI tests; the embedding endpoint (`zjsearch.embedding`) only
when the library's semantic search is under test.  dev-settings.yml ships
PLACEHOLDER keys — paste the real ones locally, never commit them.

## 2. Quality gates (every round, before browser work)

```sh
make themes.zjsearch                        # full build (also publishes static root)
cd client/zjsearch && pnpm run lint         # biome + tsc --noEmit
pnpm run audit                              # Lighthouse gate — home + every result
                                            # presentation + the AI surfaces (deterministic
                                            # mock LLM transport; Edge fallback built in)
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
  mermaid / lucide-react), the research library drawer and the
  preferences PGlite tab (@electric-sql/pglite*), a grid page (ol), and
  the streamed boot (vite output shape feeds the static-root publishing
  contract).

python — the three AI SDK transports live in requirements.txt as exact
pins; bump only when the index is actually ahead, then reinstall, restart,
and re-run the live AI test (their only consumers are the SDK factories in
`searx/zjsearch/ai/infra/sdk/`).  The theme's other own pins (bm25s =
the reranker plugin, mcp = the tool-server bridge, html-to-markdown =
the reader) follow the same rule, each with its area's regression: the
§4 plugin matrix for bm25s, one real MCP tool call for mcp, one
web_crawler read for html-to-markdown.

```sh
local/py3/bin/pip index versions openai
local/py3/bin/pip index versions anthropic
local/py3/bin/pip index versions google-genai
local/py3/bin/pip index versions bm25s
local/py3/bin/pip index versions mcp
local/py3/bin/pip index versions html-to-markdown
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
| SPA search (homepage) | submit from the ask-card | leaves the hero IMMEDIATELY (pending skeleton), results swap in when engines settle; the page must never sit on the homepage or show a ghost of it |
| SPA re-search (results) | new query from the results header | pending skeleton with the NEW query — never the previous query's results/input text |
| Race | submit query B while query A streams | B wins; A's late payload is dropped (seq guard) |
| Back/forward | back from search B to search A | content matches the URL (pending skeleton → A's results), never a foreign page |
| Zero results | `zzxxqq11223344 +notpresentwordxyz` (`+` = `%2B`) | engines panel open, NO pager, Sorry state |
| Themes | `simple_style=light/dark/black` cookie | palette flips, skeleton included |
| Mobile | 390×844 viewport | filter rows swipe, no layout break |
| Wide | 1920 / centered-mode toggle | container-query grids re-step |
| Preferences | drawer, all 6 tabs (incl. PGlite) | row language uniform, autosave toast |
| About/Stats | header icon buttons | drawer panels, internal links browse in-panel |
| 404 / NoJS / RSS | `/nonexistent`, noscript block, `format=rss` | canonical faces (rss.xsl self-contained) |
| AI Overview | results page → AI Overview trigger | stream, thinking fold, [n] chips, show more, regen, copy |
| AI Overview deep link | `?q=zjaudit+general&ai_overview=1` (mock or live) | card auto-opens WITHOUT interaction — the Lighthouse gate's overview page |
| AI Search takeover | `?q=searxng&ai=1` (live model) / `?q=zjaudit+general&ai=1` (audit mock) | research timeline (think → intent → parallel call rows incl. a web_crawler read: the row's char count, the reading pane, the read-in-full badge), cited synthesis with the inline gallery strip, related, own source rail; follow-ups continue the [n] numbering.  The research box STAYS OPEN through the run's whole life; the follow-up box unlocks on `settle` (never on the trailing related/memory); quality/goal add the task card (0/N → N/N, per-subtask sources) |
| AI clarify / ask_user | an ambiguous query in quality/goal (live), or the mock's clarify fixture | the clarify modal with the 2-question form (提交 / 跳过); answering seeds a clarify step at the timeline head; a mid-research ask_user renders as a call row + the same modal |
| AI memory | any researched run (live model) | stored facts ride the run's `<user_memory>` block; a `user_memory` save renders a memory row AFTER settle; the extractor's saves appear in the drawer's 记忆 tab |
| Research library | header History icon | four tabs (搜索 会话 来源 记忆); source rows carry favicons + ↗ open + the reading pane when web_reader read them; EVERY delete (source/search/thread/memory) goes through one confirm dialog; the search box filters its tab |
| Thread page | `/zjsearch/ai/thread/<id>` direct boot + REFRESH | the run replays with its timeline; a refresh must NEVER flash 找不到该会话 (resume awaits the store fallback, not just the per-tab mirror) |
| Print view | 📄 on a settled run, in EVERY theme (light/dark/black) | the print dialog opens IMMEDIATELY (no preview hop); the sheet is light on pure white in all themes; the live page never re-renders (no mermaid flash); the saved filename mirrors the MD export |
| MD thread export | the export action on the run actions row | valid markdown: one `## ` per question, sources at the foot, `{{zjs-gallery:i}}` NEVER appears (each becomes its images' markdown figures) |
| AI failure UX (overview) | point `zjsearch.llm.base_url` at a dead port | 502 body reason readable under the card's failed label |
| AI failure UX (search) | a settled run with NO answer (writer empty/dead stream) | the failed box with reason + retry + classic fallback — a researched-then-empty run must NEVER settle as silent nothing (stop-button cuts are exempt: `stopped` runs stay quiet) |

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
5. **The print dialog cannot be automated**: verify the print view by
   no-op patching `window.print` BEFORE clicking 📄, then inspecting
   `#zjs-print-view-root` (research box gone, sources tail present,
   `zjs-print-sheet` on the root) and — for colors — setting the tokens
   to `initial` on `<html>` with `html.style.transition = "none"` FIRST
   (the palette cross-fade otherwise feeds the probe mid-flight colors,
   which once "proved" the paper tinted).  Fire `afterprint` manually to
   tear the view down; `body.zjs-print-view` must end up removed.

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

AI wire regression (no browser needed — the fastest full-stack check of
both AI endpoints; the event ALPHABET is CLOSED server-side, so a
malformed producer crashes loudly instead of shipping a silent drift).
Extract the per-capability HMAC token from page-data globals, then
replay the NDJSON and CHECK THE EVENT ORDER:

```sh
TOKEN=$(curl -s 'http://127.0.0.1:8888/search?q=audit' | python3 -c "
import sys, re, json
html = sys.stdin.read()
m = re.search(r'<script id=\"page-data\" type=\"application/json\">(.*?)</script>', html, re.DOTALL)
print(json.loads(m.group(1))['globals']['ai_search']['tk'])")
curl -s -X POST 'http://127.0.0.1:8888/zjsearch/ai/search' -H 'Content-Type: application/json' \
  -d "{\"q\":\"<question>\",\"tk\":\"$TOKEN\",\"mode\":\"balanced\",\"lang\":\"zh-CN\"}"
```

- The alphabet (`framework/wire.py`): open / think / say / calls / call /
  close / tasks / sources / answer / ask / gallery / related / memory /
  usage / settle — an unknown event raises server-side (wire.encode).
- Research run shape: `open` (kind research, round N) → `think`/`say`
  deltas carrying THAT entry id → `calls` (the batch) → one `call`
  settlement per tool (`{id, call, status, n/chars/...}`) → `close` →
  next round … → `open` (kind write) → `answer` deltas (the writer's OWN
  buffer; narration never mixes in) → `gallery`? (placeholders inside
  the answer text) → `settle` `{status: done|awaiting|error, finish,
  usage, model, halt}`.  `tasks` snapshots and `sources` (the [n]
  registry) ride along as authoritative state — the client never
  reconstructs anything (there are no heuristics left to audit).
- AFTER `settle` only `related` / `memory` / `usage` may trail (the late
  set — the follow-up box unlocks on settle, not on them).
- `ask` is the clarify gate AND the mid-research ask_user (same schema);
  the ask branch emits the tool's call row BEFORE the ask event.
- A greeting-style run skips research: `open` (kind write) → `answer`
  deltas → `settle`.
- The overview endpoint `/zjsearch/ai/answer` streams the SAME event set
  (its token is `globals.ai.tk`); the `<think>` markers and the tail
  meta sentinel its card renders are synthesized CLIENT-side.
- A stream that dies before its first content event answers plain-text
  502 (the route primes the stream before responding).
- The audit instance variant (:8907 + `zjaudit` queries + the mock
  transport on :8909) replays the SAME checks with zero model variance
  and milliseconds of latency — use it when the failure is in the SERVER
  plumbing rather than the model.

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
8. **AI feature** — live-model test (stream, citations, thinking,
   regenerate, copy) + backend review (timeouts, silence contracts, token
   gate, image SSRF path).  The resilience contracts each get an explicit
   check: the writer's empty-stream retry (one silent second attempt — a
   200-with-zero-events gateway must not end a researched run answerless),
   the fence-last prompt rule (a writer that emits ONLY the ```related
   fence used to settle the run with suggestions but no answer), the
   settled-run-without-answer failed box (see the §4 matrix), the spawn
   recursion guard (a sub-model calling spawn_subtask or task_write must
   no-op, not recurse), the memory pair (the pre-sent `<user_memory>`
   block + the post-run extractor — small models never call the save
   tool unprompted), the MCP bridge (a dead endpoint contributes
   NOTHING; past 8 registered tools the `mcp_search_tools` discovery
   tool replaces the schema dump), and the print view's off-screen
   mermaid render (the live page never re-renders — §5 recipe 5).  The
   audit mock's event sequence (§6 recipe against :8907) exercises the
   plumbing without a live model.
9. **A11y** — icon-only buttons labelled, dialogs named + focus-trapped,
   `alt` on images, keyboard reachability.
10. **Prompts (agentic)** — the shared prompt spine is
   `searx/zjsearch/ai/runtime/spine.py` (identity / citation grammar / the
   full markdown surface / language directive / grounding fallback /
   opening rule / answer contract); the search preset's assembly lives in
   `runtime/prompts.py` (`initial_messages`) — the spine fragments must be
   COMPOSED, never hand-copied (the drift this once caught: the search
   copy was missing task lists / strikethrough / the once-only LaTeX
   rule).  Round policy lives ONLY in the depth branches of
   `runtime/profile.py` (a base-level round cap contradicts quality/goal —
   the four modes are budget/decomposition/output-shape differences on ONE
   loop, `SEARCH_MODES`/`CLARIFY_MODES` are the single facts).  The reply
   language follows the ACTIVE UI locale: the client resolves it to the
   SHIPPED catalog tag (`themeLocaleTag`, zh-Hant → en included) and
   `language_directive` is a DATA TABLE from catalog tag → language name —
   adding an i18n language is one client catalog plus one server table
   row, never a new branch.  The `web_search` tool exposes the parameter
   surface SearXNG actually supports (category, time_range), the precision
   operators the advanced_search_syntax plugin enforces (site: /
   filetype: / quotes / before:after:), the engine-bang escape hatch
   (user-named engines only, e.g. `!baidu`), and the empty-result
   fallback (retry once without the filter).  Verify with composition
   asserts over `spine.build_messages` / `runtime.prompts.initial_messages`
   / the tool spec in `runtime/tools.py`.

## 8. Known environment traps

- `pnpm run audit` needs a Chromium browser (`ChromeNotInstalledError`) —
  the script now FALLS BACK to the Microsoft Edge app bundles on its own
  (macOS/Windows paths built in); `CHROME_PATH` still wins for anything
  exotic.  Headless Edge/Chrome sometimes DIES mid-run ("Failed to fetch
  browser webSocket URL"); the audit script relaunches it and carries on.
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
- `dev-settings.yml` ships PLACEHOLDER keys (the tree is public) — a
  fresh clone has NO working LLM/embedding/MCP endpoint until the real
  keys are pasted in locally; "the AI test failed with 401/403" on a new
  machine is the placeholder, not a regression.  The one REAL key that
  must stay local-only after every pull is the amap MCP url.

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
