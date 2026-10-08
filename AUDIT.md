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
# ZJSEARCH_EMBEDDING_KEY is optional: the knowledge base's semantic search
# (drawer + the client-side recall that feeds the AI runs).
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
  mermaid / lucide-react), the knowledge-base drawer and the
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
| AI boot skeleton | `/search?q=…&ai=1` (strip scripts on the early chunk for the static leg) | the skeleton renders the TAKEOVER's shape (real-query title, open research box, sources rail) — never classic tabs/filters/card bars; the AI POST fires without waiting for the payload swap |
| POST-mode AI Search | preferences → HTTP 方法 = POST, then a hero AI search | the hidden-form POST navigates (navigation type `navigate`, url `/search` bare), the takeover still boots (payload `globals.ai_mode`, no query string needed), the run streams; a follow-up appends in-place; the classic POST search (`/search`, results render) is the sibling regression |
| SPA search (homepage) | submit from the ask-card | leaves the hero IMMEDIATELY (pending skeleton), results swap in when engines settle; the page must never sit on the homepage or show a ghost of it |
| SPA re-search (results) | new query from the results header | pending skeleton with the NEW query — never the previous query's results/input text |
| Race | submit query B while query A streams | B wins; A's late payload is dropped (seq guard) |
| Back/forward | back from search B to search A | content matches the URL (pending skeleton → A's results), never a foreign page |
| Zero results | `zzxxqq11223344 +notpresentwordxyz` (`+` = `%2B`) | engines panel open, NO pager, Sorry state |
| Themes | `simple_style=light/dark/black` cookie | palette flips, skeleton included |
| Mobile 390×844 — general | `/search?q=...` | brand hidden (<30rem), category tabs wrap to two rows, filter row swipes, NO horizontal pan (scrollWidth == 390), result cards keep the fixed slot anatomy |
| Mobile — grids | images / videos / files URLs | masonry tiles flow 2-up-ish by container query; videos drop to ONE column under `@[24rem]`, files keep two compact columns; no pan |
| Mobile — AI takeover | `?...&ai=1` | timeline + task card + answer + the follow-up composer all fit; no pan |
| Mobile — knowledge drawer | header button | FULL-WIDTH sheet (w==390) with an opaque `bg-bg` ground, four tabs; judge by DOM geometry — the IAB screenshot pipeline serves stale frames here routinely (§5) |
| Mobile — AI Overview | `?...&ai_overview=1` | card auto-opens at the 16px page margins, citations + run footer render |
| Wide | 1920 / centered-mode toggle | container-query grids re-step |
| Preferences | drawer, all 6 tabs (incl. PGlite) | row language uniform, autosave toast |
| About/Stats | header icon buttons | drawer panels, internal links browse in-panel |
| 404 / NoJS / RSS | `/nonexistent`, noscript block, `format=rss` | canonical faces (rss.xsl self-contained) |
| AI Overview | results page → AI Overview trigger | stream, thinking fold, [n] chips, show more, regen, copy |
| AI Overview deep link | `?q=zjaudit+general&ai_overview=1` (mock or live) | card auto-opens WITHOUT interaction — the Lighthouse gate's overview page |
| AI Search takeover | `?q=searxng&ai=1` (live model) / `?q=zjaudit+general&ai=1` (audit mock) | research timeline (think → intent → parallel call rows incl. a web_crawler read: the row's char count, the reading pane, the read-in-full badge), cited synthesis with the inline gallery strip, related, own source rail; follow-ups continue the [n] numbering.  The research box STAYS OPEN through the run's whole life; the follow-up box unlocks on `settle` (never on the trailing related/memory); quality/goal add the task card (0/N → N/N, per-subtask sources).  With a non-empty browser corpus the researcher gains a `past_research` RAG round (full-text heads + source identities as history [n] rows); the audit mock falls back to a plain search when the tool is not registered — the audited timeline must show NO error row either way: every row settles (the reader row with its char count, the TWO task_write rows 0/2 → 2/2) and the web_reader settlement must not kill the stream (a wire-v2 closed-set violation once crashed every successful page read — §7.8) |
| AI browser session | the debug stage (`?aidebug` on a thread url) → the 浏览器登录协作 scenario: ALL rows settle (4 research entries + the write entry — interrupted tails mean a stale chunk, restart the instance); open renders the location line + the interactive-element outline (e1/e2/e3 chips); wait_user AUTO-OPENS the takeover (scrub into the wait frames) and the window-end frame retires the countdown; below lg a fixed bottom bar opens the same takeover; the screenshot row renders its shot (click → the zoom lightbox); replaying a stored thread NEVER shows the live card nor auto-opens (resume nulls `browser`).  Live: a `web_browser open` run mints a [n] source the writer cites (the rail's card carries the dashed cited frame); the settlement's `img` never reaches the evt log |
| AI 引导/干预 (v2.1 R2) | the debug stage → the 引导 scenario (drained/preempt/discarded three states), then LIVE: a streaming run's composer is the AMBER steer box (placeholder 讲明回车/Shift+Enter 语义); Enter queues a steer (pending chip → the next boundary injects it: a user 引述行 renders in the timeline AND the model's next round reacts); Shift+Enter / ⚡ preempts (the in-flight turn cancels, the run CONTINUES steered); a steer typed after the write phase opened flips the chip to 未送达 (never silent); 收尾 settles done/连接中断; a settled run's composer is the follow-up box as before |
| AI 子代理 (v2.1 R3A) | the debug stage → the 子代理 scenario (the delegation row, the folded sub row, the re-open that must NOT duplicate it); LIVE: `subagents: true` + deep + depth rung ≥3 — the model delegates, each sub row folds to one line (title + 正在查…/N 次查询·完成) and opens the mini-timeline (派工 header + the child's own think/call stream); the digest arrives as the delegation row's receipt (row expansion renders it); promoted facts land in the findings card; the batch cap's 5th delegation refuses with the merge-nudge |
| AI 浏览器多会话 (v2.1 R3B) | a delegating run whose subagents drive web_browser: the rail card grows the TAB STRIP (主会话 first + one tab per sub session, active = accent); the ACTIVE tab streams, background tabs freeze on their last frame with the 后台 badge; the takeover (zoom) is the LEAD tab's surface only (its wait_user auto-opens; the input endpoint 422s non-lead sessions); a finished subagent's tab disappears (the session closes with its loop); a single-session run renders EXACTLY the pre-R3B card (no strip) — replay old threads likewise |
| AI clarify / ask_user | an ambiguous query in quality/goal (live), or the mock's clarify fixture | the clarify modal with the 2-question form (提交 / 跳过); answering seeds a clarify step at the timeline head; a mid-research ask_user renders as a call row + the same modal |
| AI memory | any researched run (live model) | stored facts ride the run's `<user_memory>` block; a `user_memory` save renders a memory row AFTER settle; the extractor's saves appear in the drawer's 记忆 tab |
| Knowledge base (知识库) | header LibraryBig icon (`KnowledgeDrawer`) | four tabs (搜索 会话 来源 记忆); source rows carry favicons + ↗ open + the reading pane when web_reader read them + the ×N cross-session badge (N = past runs that referenced the url, from the PRE-run recall); EVERY delete (source/search/thread/memory) goes through one confirm dialog; the search box filters its tab; the keyword/semantic/hybrid modes come from the deployment (`history_search`) |
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

Result-ordering plugin (test via curl, not the browser — ordering has no
answer payload):

| Check | Expect |
|---|---|
| `python tutorial` vs the same + `&disabled_plugins=bm25_reranker` | both 200 with results; the enabled run rewrites `positions` (order may differ; on a zero-signal query the engine order STANDS — do not expect a flip) |

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
  -d "{\"q\":\"<question>\",\"tk\":\"$TOKEN\",\"mode\":\"balanced\",\"lang\":\"zh-CN\",
  \"past_research\":[{\"url\":\"https://example.com/a\",\"title\":\"A past page\",\"text\":\"remembered body\"}]}"

# the RAG tool registers only when that index is non-empty: a past_research
# tool call in the replay then returns the matching heads as history [n]
# sources (an identity-only entry -- no text -- points the model at
# web_reader for a live re-read).  The retired payload key ``web_memory``
# still parses (a deploy-window browser may still send it).
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
   The family doctrine (ZJBlog DESIGN.md §12) governs placement:
   `components/` is CROSS-PAGE only — a single-page piece folds into its
   page file (AiModeSwitch once sat here with one consumer); features own
   real domains; lib modules are lowercase topics; zero default exports.
   Run the orphan-export scan (every `export` grepped against the tree)
   and the legacy-compat sweep each round: stored-legacy unions
   (`spawn_subtask`, the `"plan"` step kind) die with their era instead of
   riding forever.
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
   contrast tiers, skeleton geometry vs real page (boot.css drift audit) in
   BOTH modes: the classic card-list mirror AND the AI-takeover branch
   (`.zjs-boot-ai*` vs `AiSearchRunSection`'s zero-event state vs
   `AiBootGhost` — three renderings of one geometry, kept in sync by hand).
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
   mermaid render (the live page never re-renders — §5 recipe 5).  Newer
   contracts, each with an explicit check: the GOAL LOOP (the mode is the
   unbounded one — the loop ends on the task ledger closing or a stalled
   run, never on a small count; 32 rounds is the runaway guard, the
   budget note fires at the last round); the ask_user SHAPE EQUALITY
   (the tool spec and `gates.sanitize_questions` must advertise the same
   wire — a type the sanitizer downgrades must not be offered to the
   model; the current contract is single/multi + 2-4 options + the
   client's free-text line, no importance field); the HUMAN-IN-THE-LOOP
   posture (the ambiguity_escape block and the clarify gate license
   asking on high-stakes deliverables — forecasts, money/health/legal —
   where a wrong assumption changes the answer); the past_research DUAL
   INDEX (page entries carry ~1500-char heads, source entries identity
   only and point at web_reader; `assign_past_sources` never numbers a
   url the researcher already numbered); the OVERVIEW accuracy path (the
   client's eager PGlite recall trails the context as labeled [n] lines
   whose citation chips open the url; server-side the numbered lines are
   cosine-REORDERED past 12k and the 16k cap cuts at a LINE boundary —
   both silent when the embedding endpoint is off); the spine FIGURES
   rule (a writer/overview has no calculator — it must never present a
   derived number as if a source stated it); and the cross-session
   badge (pastRefs is captured at the PRE-run recall — the run's own
   ref-count increment must never badge itself); and the WIRE PRODUCER
   check: every event tuple the executor yields must be in
   `framework/wire.py`'s closed EVENTS set — the v2 set made a stale
   producer name crash the whole stream LOUDLY (the `("page", ...)`
   reader settlement killed every successful web_reader read for two
   commits), so a replay containing a reader read (§6) is the regression.
   The
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

## 7.1 Round record — 2026-10 (post-multimodal-deferred full sweep)

Scope: the AI-stack additions (ranking cascade, learnings, continue,
schema v4, reader contract) + a real-user UI pass over every AI/knowledge
surface. Highlights that must not regress (the full fix list is in git:
`e4299d9` backend, the frontend polish commit the same day):

- **Reader launch parameters ride the QUERY string** (Browserless v2
  manual): body launch params 400'd EVERY read ("must NOT have
  additional properties" — not a timeout; read the log line, not the
  vibe). Regression: one URL-question AI run — the reader rows must
  settle with char counts, zero 400s.
- **Dedup keys describe the search AS EXECUTED** (`-site:` prefix,
  category + time_range ride): regression — empty `time_range:` search
  then the unfiltered retry must BOTH run (the second must not settle
  duplicate).
- **The client live-fold accepts LATE events after the settle**
  (related/memory/tags/usage) — memory saves were silently lost live.
  Regression: a researched run's 记忆 tab gains the extracted facts
  WITHOUT a reload.
- **THINK vs CONTENT**: reasoning streams render on READ_PANE's boxed
  ground. Regression: visual — the timeline's think block is visibly
  boxed vs the plain answer.
- **The clarify modal carries the full dialog contract** (focus trap +
  Escape = skip + fading scrim). Regression: keyboard-only — Tab stays
  in the card, Escape resumes the run.
- **web_reader rows never fold** (the pane is scroll-capped); failed
  tool rows wear CircleAlert (X = dismiss only); regenerate is
  RefreshCw on BOTH answer surfaces.
- **Model-usage card**: the LLM row, then the 嵌入 and 重排 groups side
  by side in ONE row -- each with its own title and plain 输入/调用
  tiles (the LLM group's language); score endpoints are input-only so
  the tile says 输入, never "Tokens".
- **New AI families (2026-10 round)**: the dashscope family (LLM /
  embedding / rerank) and the SystemOne decision route — all
  LIVE-VERIFIED against a dedicated MaaS workspace (qwen3.8-flash /
  qwen3.7-text-embedding-flash 1024d / qwen3.7-text-rerank /
  decision-model-preview).  Regression vectors: the dashscope factory's
  response payloads are DICT-shaped (attribute access silently misses --
  `_field` reads both shapes); the mm pump auto-routes image turns
  through MultiModalConversation; the rerank `sdk` dispatcher
  (dashscope | cohere-HTTP).  The dedicated-MaaS gateway reality is a
  test fixture of its own: compat chat + native embeddings + native
  rerank proxied, native text-generation NOT.
- Audit-methodology additions: settle-path checks (startRun's
  streaming row + the stale-run sweep), wire-LATE-event coverage, the
  gallery-whitelist-mirrors-feed invariant, and the icon-language sweep
  (same concept = same icon; X = dismiss only; sizes on the 12/14/18/20
  tiers).

Lighthouse outcome (round record): RESOLVED via option (a) -- the
database engine now lives in a WEB WORKER (`src/lib/pg.worker.ts`: the
WASM + the data extensions; `pg.ts` boots the `PGliteWorker` relay with
the live plugin main-side, and a 10s readiness race falls back to the
main-thread engine in webviews where module workers hang).  With the
boot + every query off the main thread the AI surfaces re-earned their
floors outright (ai=1: perf 96 / agentic 100; ai_overview: 91/96 -- the
09-29 levels), the classic pages stay green (the overview recall
prewarms on USER INTENT: pointerenter/focusin/touchstart; the
ai_overview=1 deep link recalls immediately), and no floor was
recalibrated.  Option (b) is moot (the crash window stands).

Known-red (ONE page): the AI THREAD page fails Lighthouse with
"unable to reliably load" -- no scores, the navigation never settles.
Predates the worker (it failed identically in every same-day pre-worker
run); the server answers in 75ms and a real browser renders the page
fine, so the trace hangs client-side.  Needs a dedicated
`--save-assets` trace to name the never-settling request; the gate
stays red on this page until then.  (Also: the audit mock's fixture
coverage grew -- the researcher fixture now drives a `learnings` call
(the findings card + wire snapshot) and the insights gate answers
`user_memory_extract` (the LATE memory/tags events + the memory tab),
so the audited timeline exercises both new surfaces offline.)

## 7.2 Round record — 2026-10 (the browser-use round)

Scope: the `web_browser` interactive session's capability + UI pass
(its first audit since landing), the client's per-action row rendering,
the mirror/takeover UX, and the session lane's integration with the
research machinery. Highlights that must not regress:

- **The session lane mints [n] sources** (open = identity, read /
  post-wait snapshot = full text): the writer can cite browser-gathered
  material, coverage/entries ride along, about:blank mints nothing.
  Regression: one browser run — the rail's source card carries the
  dashed cited frame and the answer's [n] resolves to it.
- **The settlement's `img` is VOLATILE** (stripped before the evt log):
  a replay keeps the record, never the bytes — the screenshot row shows
  the honest placeholder after a reload.
- **The takeover keyboard contract**: interactive targets are EXEMPT
  from direct typing (Tab/Enter/Space on the takeover's own buttons
  stay client-side — a keyboard user can otherwise never close the
  modal); Tab is trapped by useDialogFocus (role=dialog sits on the
  SAME element the hook's ref holds — the trap's owner check compares
  against it); the full dialog contract (fading scrim, fade-up,
  aria-label) rides the AttachmentPreview pattern.
- **The open lane's URL guard**: `open` runs the reader's public-url
  gate (scheme check FIRST — file://localhost would ride the
  allow_hosts exemption) because `context.route` never sees a
  navigation target.
- **Engine self-heal**: a "closed"-flavored failure drops the poisoned
  context (match playwright's vocabulary — `net::ERR_CONNECTION_CLOSED`
  must NOT drop a warm context); a locked-profile launch failure kills
  the stale holder of THIS profile (pkill scoped to the exact path, off
  the shared loop) and retries once; the atexit close is best-effort
  (granian workers skip it).
- **The wait window lifecycle**: frames ARE the heartbeats; 3
  consecutive frame failures end the window early (a dead engine must
  not leave a silent wire); the window-end frame (no `wait_left`)
  retires the countdown + the mobile bar; back-to-back windows re-arm
  the auto-open via that same reset.
- **The debug fixture is display-shaped and entry-per-round**: the
  simulator replays through the REAL fold, so raw `{name, arguments}`
  items or call events missing their entry `id` render as broken
  web_search rows / interrupted tails — a new tool row or wire event
  ships with a fixture event sequence that SETTLES (the simulator
  doctrine: if it can't show it, the UI can't render it).  The row→
  source join reads source.round === step.round, so fixture sources
  must carry their entry's round.
- **Latent bug the round caught**: the session `read` action called
  `browser_config.max_chars()` (never existed) — every read errored;
  the cap lives in `web_reader.reader.max_chars`.

Audit-methodology additions: the WhiteNoise staleness note extends to
the LAZY chunks — iterating on them needs an instance RESTART, not
reloads (the earlier reloads kept serving the old chunk and faked
"the fix didn't work"); the IAB stale-frame recipes (§5) apply double
during palette flips (wait out the 350ms stand-down before capturing).

## 7.3 Round record — 2026-10 (the real-case round: Kelun-Biotech report)

Scope: a REAL production run — the 57KB BP-intelligence framework MD
attached through the composer, 深度调研 mode, a full commercial-
intelligence report (77 calls / 19 rounds / ~18 min / 0 error rows /
92 citation chips / 400+ sources) — plus the fixes and features it
pulled in:

- **Plugin answers reach the model**: `SearchWithPlugins` always
  computed the answerers' output and `_search_one` dropped it at
  `get_ordered_results()`.  Now `gather._finish` extracts
  `container.answers` into the feed block's FIRST lines ("Direct
  answers"), and an answer-only search counts as productive (the stall
  detector punished exactly the `$AAPL`-style queries before).  Test
  vector: `$AAPL 股价` speed run — the model searches `AAPL stock`, the
  quote rides the feed.  NOTE: the answerers only fire on their trigger
  shapes (`$SYM`, `SYM stock`/`quote` suffix) — the web_search spec now
  teaches them.
- **`web_browser` search action**: live SERPs on the session page
  (bing/baidu/google/duckduckgo), relevance-guarded (degraded first
  frames were observed ONCE on bing — trending filler to a fresh
  fingerprint; the guard rescrapes once then admits failure honestly).
  google through a CN-exit proxy serves 0 parseable rows (consent/bot
  wall) — bing/baidu are the reliable pair on this deployment.
- **The writer treats attached frameworks as a contract**
  (`<attached_files_note>`): the big report's body carried ZERO rule-ID
  citations despite the researcher obviously reading the framework —
  the writer had the file but no instruction to honor its OUTPUT
  conventions.  After the note, a speed-mode framework run cites real
  IDs (META-02 / REG-CNPV / RULE-AFFILIATE-07).  Regression: attach the
  framework, ask for a schema-shaped signal, expect framework rule IDs
  in `rules_applied`.
- **AUDIT METHODOLOGY — the double-instance trap**: `pkill -f "granian
  searx.webapp"` NEVER matches (`granian wsgi 127.0.0.1:8888` — the
  pattern string is not contiguous in the command line), so "restarts"
  silently stacked a second granian on the same port and every python
  change "didn't take" while requests round-robinned between old and
  new code.  Kill with `pkill -f granian` and verify ONE instance via
  `ps -eo pid,etime,command | grep granian` before concluding anything
  about server-side changes.
- **Composer file injection for browser QA**: the IAB cannot drive the
  native file chooser; inject through the REAL picker path instead —
  `new File([text], name)` + `DataTransfer` on the mounted
  `input[type='file']` + a change event (the picker's readDocument runs
  for real).  The hero picker only mounts when AI mode is ON.
- Also verified end-to-end: the attachment travels to BOTH prompts
  (researcher 30K cap / writer 30K cap — the 29,976-char framework fits
  by 24 chars; a bigger file truncates with an honest notice).

Known-red (pre-existing, untouched files): pylint R09xx findings in
`ai/tools/rows.py`, `ai/core/guard.py`, `ai/api/search_route.py`,
`ai/runs/report/synth.py` (the branch accumulated them as pylint 4.x
tightened; my areas hold 10.00) — a future cleanup round owns them.
The AI thread page's Lighthouse red (§7.1) stands.

## 7.4 Round record — 2026-10 (the v2.1 round: run host × control plane × subagents)

The multi-agent wave (NEXTGEN-DESIGN §8) landed in four commits: R1 run
host (343ddda — the run/reader decoupling: driver thread, seq-stamped
buffer, attach, detach-grace wrap, stop-as-instruction), R2 control plane
(911d6e1 — the steer wire event, the ControlBox lanes, the dual-mode
composer), R3A subagents (bb86b6a — research_subtask, keyed child
executors over the SHARED registry, kind:"sub" relay + the client's
mini-timeline), R3B multi-session browser (keyed session registry, the
rail card's tab strip, lead-only takeover). Verification ran against the
REAL deployment config from WSL (`~/searxng-py314`); the E2E scripts are
`client/zjsearch/e2e-r3.local.sh` (gitignored) and the local settings
override `client/zjsearch/real-settings.local.yml` (gitignored — real
keys never enter git).

Lessons that must survive this round:

1. **The prime path must be lossless**: a streamed response consumed from
   a subscription loses lines to ANY mid-batch break — the flatten-to-
   pending-list loop (backlog first, one line per step) is the only safe
   shape.  The regression: attach after_seq continuity (first replayed
   seq == last seen + 1) on a run with thousands of events.
2. **Multi-thread publishing moves the merge**: the settle's usage
   buckets are executor LIVE dicts — the merge must happen at the
   settle's GENERATION on the driver, never at stream time.
3. **Interrupt semantics are three-valued**: died (transport) ≠
   interrupted (user) ≠ ok — the interrupted turn cancels the pump and
   the run either ends (stop) or CONTINUES on the steered course
   (preempt); never fold them back into `died`.
4. **Sub-surface events are the LEAD's to drop**: a child loop's
   phase/tasks/decisions never relay; its browser frames DO (agent-
   tagged); its per-round re-open must not duplicate the client's sub row
   (the reducer keys sub steps by entry id).
5. **The steer lane outranks continuation at the boundary** and closes at
   the write phase — leftovers die VISIBLE (discarded), never silent.
6. **Windows-hosted dev**: the WSL venv is the nose2/pylint authority
   (upstream's `pwd` import breaks the webapp chain on Windows); the LAN
   proxy in dev-settings is unreachable from WSL — the local override
   drops it (engines partially degrade; that is fine for the wire-level
   E2E, and the depth probe's decision endpoint needs the direct route).

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
- After killing the dev instance the built-in browser can LINGER and
  hold the persistent profile's lock — the next launch fails until it
  dies. The engine self-heals (kills the stale holder of the exact
  profile path + retries once), and the error hint names the manual
  `pkill -f Camoufox` escape.
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
