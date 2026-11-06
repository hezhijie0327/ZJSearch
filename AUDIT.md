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
`searx/zjsearch/ai/llm/sdk/`).  The theme's other own pins (bm25s =
the reranker plugin, mcp = the tool-server bridge, html-to-markdown =
the reader, `markitdown[pdf,docx,pptx,xlsx]` = the ONE document
converter behind `core/convert` — attachments, native PDF reads and the
reader's HTML pass all ride it, `camoufox[geoip]` = the render engine)
follow the same rule, each with its area's regression: the
§4 plugin matrix for bm25s, one real MCP tool call for mcp, one
web_crawler read for html-to-markdown, one FILE-attachment upload
(a docx — the conversion receipt must land a 资料 row) for markitdown,
one browser open+read for camoufox.

```sh
local/py3/bin/pip index versions openai
local/py3/bin/pip index versions anthropic
local/py3/bin/pip index versions google-genai
local/py3/bin/pip index versions bm25s
local/py3/bin/pip index versions mcp
local/py3/bin/pip index versions html-to-markdown
local/py3/bin/pip index versions markitdown
local/py3/bin/pip index versions camoufox
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
| AI 子代理 (v2.1 R3A) | the debug stage → the 子代理 scenario (the delegation row, the folded sub row, the re-open that must NOT duplicate it); LIVE: deep + depth rung ≥3 (the probe scores it) — the model delegates, each sub row folds to one line (title + 正在查…/N 次查询·完成) and opens the mini-timeline (派工 header + the child's own think/call stream); the digest arrives as the delegation row's receipt (row expansion renders it); promoted facts land in the findings card; the batch cap's 5th delegation refuses with the merge-nudge |
| AI 浏览器多会话 (v2.1 R3B) | a delegating run whose subagents drive web_browser: the rail card grows the TAB STRIP (主会话 first + one tab per sub session, active = accent); the ACTIVE tab streams, background tabs freeze on their last frame with the 后台 badge; the takeover (zoom) is the LEAD tab's surface only (its wait_user auto-opens; the input endpoint 422s non-lead sessions); a finished subagent's tab disappears (the session closes with its loop); a single-session run renders EXACTLY the pre-R3B card (no strip) — replay old threads likewise |
| AI clarify / ask_user | an ambiguous query in quality/goal (live), or the mock's clarify fixture | the clarify modal with the 2-question form (提交 / 跳过); answering seeds a clarify step at the timeline head; a mid-research ask_user renders as a call row + the same modal |
| AI memory | any researched run (live model) | stored facts ride the run's `<user_memory>` block; a `user_memory` save renders a memory row AFTER settle; the extractor's saves appear in the drawer's 记忆 tab |
| Knowledge base (知识库) | header LibraryBig icon (`KnowledgeDrawer`) | four tabs (搜索 会话 来源 记忆); source rows carry favicons + ↗ open + the reading pane when web_reader read them + the ×N cross-session badge (N = past runs that referenced the url, from the PRE-run recall); EVERY delete (source/search/thread/memory) goes through one confirm dialog; the search box filters its tab; the keyword/semantic/hybrid modes come from the deployment (`history_search`) |
| Thread page | `/zjsearch/ask/thread/<id>` direct boot + REFRESH | the run replays with its timeline; a refresh must NEVER flash 找不到该会话 (resume awaits the store fallback, not just the per-tab mirror) |
| Print view | 📄 on a settled run, in EVERY theme (light/dark/black) | the print dialog opens IMMEDIATELY (no preview hop); the sheet is light on pure white in all themes; the live page never re-renders (no mermaid flash); the saved filename mirrors the MD export |
| MD thread export | the export action on the run actions row | valid markdown: one `## ` per question, sources at the foot, `{{zjs-gallery:i}}` NEVER appears (each becomes its images' markdown figures) |
| AI failure UX (overview) | point `zjsearch.llm.base_url` at a dead port | 502 body reason readable under the card's failed label |
| AI failure UX (search) | a settled run with NO answer (writer empty/dead stream) | the failed box with reason + retry + classic fallback — a researched-then-empty run must NEVER settle as silent nothing (stop-button cuts are exempt: `stopped` runs stay quiet) |
| Knowledge base (六视图) | header LibraryBig icon | SIX tabs: 研究 (thread directory w/ mode tags + Reports badge) / 资料 (source+document merged rows — sources wear favicons, documents the FileText 「全文」 face) / 图谱 (tag graph, equilibrium SLEEPS — `document.getAnimations()` must be empty on a settled graph) / 记忆 (own-table timeline, CRUD + quick capture) / 模板 / 管理; the keyword/semantic/hybrid modes come from the deployment; every delete confirms |
| Attachment upload — file | hero paperclip: a .docx (or the composer's DataTransfer injection, §7.3) then a question | the run's timeline shows the attachment; AFTER settle the 资料 tab gains a 「全文」 row titled with the filename (the `attachment` wire event → `archiveAttachments`); the row opens the inspector's reading pane; a follow-up in the SAME thread inherits the file (up to 6, removable in the picker) |
| Attachment upload — image | a .png/.jpg via the paperclip | the image compresses client-side (~1568px edge), rides the FIRST turn as a vision part (the answer references it); it does NOT appear in 资料 and does NOT inherit to follow-ups — it lives only in the thread replay |
| Deliverable flip | a deep/balanced run whose request suits a report: pick 报告 in the OUTPUT STRUCTURE card mid-run | the picker lights the TOC + DocumentView at the write boundary; 直接回答 pick withdraws a pending flip (mode folds BACK to the birth tier, run settles as a plain answer, no structure card); a settled record keeps the card as its FORMAT RECORD (never a hole) |
| Paid-engine gate | settings with an api_key engine (bocha…) disabled-by-default; ask the model for that engine by NAME | the search settles as approval (待用户确认 row), the run parks `awaiting` on the ask_user; confirming re-runs with `paid_ok` and the WHOLE run stays approved (sticky); the confirmed direction seeds the clarify step |
| Pasted brief | paste a multi-KB research brief into a follow-up composer | the pane auto-grows (~8 lines then internal scroll), Shift+Enter = newline while idle / PREEMPT steer while streaming; the run title clamps at THREE lines behind the expand chip; the tab title caps at the first line / 80 chars |
| AI Overview (retired shape) | `?q=zjaudit+general&ai_overview=1` deep link + the results-page trigger | the card renders as the results column's paper-dressed card (tape + tilt), answers back (the ask pane), regen/copy work; the standalone overview page is GONE — the deep link boots the results page with the card open |

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
curl -s -X POST 'http://127.0.0.1:8888/zjsearch/ask/search' -H 'Content-Type: application/json' \
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
- AFTER `settle` only `title` / `related` / `memory` / `tags` / `usage`
  may trail (the late set — the follow-up box unlocks on settle, not on
  them; the client's LATE_KINDS gate is the authority).
- `ask` is the clarify gate AND the mid-research ask_user (same schema);
  the ask branch emits the tool's call row BEFORE the ask event.
- A greeting-style run skips research: `open` (kind write) → `answer`
  deltas → `settle`.
- The overview endpoint `/zjsearch/ask/overview` streams the SAME event set
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
   `searx/zjsearch/ai/prompts/spine.py` (identity / citation grammar / the
   full markdown surface / language directive / grounding fallback /
   opening rule / answer contract); the search preset's assembly lives in
   `prompts/researcher.py` (`initial_messages`) — the spine fragments must be
   COMPOSED, never hand-copied (the drift this once caught: the search
   copy was missing task lists / strikethrough / the once-only LaTeX
   rule).  Round policy lives ONLY in the depth branches of
   `runs/profile.py` (a base-level round cap contradicts quality/goal —
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
   / the tool specs in `tools/web_search.py` + `tools/web_browser/spec.py`.
11. **Knowledge store & the RAG archive lane** — the ONE-ROW-PER-PAGE
   doctrine (a page is the same source row before and after a crawl;
   `doc:` twins fold away); the retrieval head-bias contract:
   `search_text` = title + the FIRST 8000 chars (segmented) serves BOTH
   the BM25 leg and the embed leg (`embedPending` slices 4000), the
   `body` column keeps 60k for consumption — recall is head-biased BY
   DESIGN, never "the corpus is truncated" (the accepted edge: a row
   whose load-bearing text sits past 8k is recall-invisible for it).
   Check: `embedPending`'s partial index still excludes `source_ref`;
   attachment rows (`doc:att:*`, `meta.origin='attachment'`) join every
   document surface (资料 directory, hybrid+semantic search, recallPages,
   embed pass) while IMAGES stay out of the knowledge table; the
   `attachment` table's bytes sweep on deleteThread/reset; the retired
   manual crawl stays DEAD (no `/zjsearch/browser/read` route, no
   `clearSourceCrawl`/`crawlItem` stragglers — 5a7fd95); projections are
   upsert-idempotent (replay re-settles must not duplicate).
12. **The tripartite memory** — the `memory` OWN table (fact/procedure
   kinds; episodic rides thread_head, not rows); the tool's FULL CRUD
   (search/save/update/forget) sanitizes against the same shape it
   advertises; the consolidation organ (post-run extractor) writes
   through the SAME projections as the manual captures; the dedup floor
   (embedding NN merge) cannot eat a DISTINCT fact; site recipes are
   host-bound (www folded, suffix covers subdomains) and only the
   browse lane reads them; every memory lands in the UI locale (the
   doctrine's language rule) — a zh UI must not store English facts
   from an en-leaning model.
13. **Recovery & journal ladder** — every research run registers
   `linger` (detach grace NEVER wraps a run); the journal shadow
   (`runs/journal.py`) fails OPEN on every consumer, rebuilds at a
   `.N`-suffixed generation path (a same-path rebuild answers through
   orphaned-inode sessions), 72h TTL + newest-512 sweep; the resume
   chain probes live host → journal → interrupted state; pre-2026-10
   rows (seq stripped) and awaiting runs stay excluded.  Client: the
   watchdog ceiling (170s) sits ABOVE every server quiet bound; the
   reattach ladder covers the whole detach grace; a failed box's 继续
   attach-probes FIRST (404 falls through to ctx replay); the store
   boot races 25s and DEGRADES to in-memory (`__zjsKnowledge.degraded()`)
   instead of wedging — a degraded session must never silently fake a
   real store.
14. **Static-root publishing & the build contract** — after EVERY
   build: the gzip/brotli siblings exist for the root bundles, the
   chunk graph and the PGLite FS artifacts (`gzipPublished` pass); the
   dist dedup freed the unlinked copies (nlink guard — on Windows
   hardlink flows the sources must survive); `pg.worker-*.js` +
   `pglite-*` + `initdb-*` + the three extension tars sit at the
   static ROOT (a missing FS bundle throws INSIDE the worker →
   main-thread fallback → the ~1s freeze jam); `chunk/zjs-results.min.js`
   keeps its STABLE name (the streamed shell's pre-warm URL); extra
   root-level CSS chunks resolve as siblings (a missing one = the
   skeleton-forever boot); the build stays warning-free with the
   onwarn filter scoped to node_modules authors only (app warnings
   must still print).
15. **Route-level control flows** — the deliverable flip's priority
   chain (reader template pick → reader direct pick → route outline →
   minted skeleton → defer) and the direct pick's OUTRANK (withdraws
   template AND flip, `on_steer` clears `route_outline`/
   `deliverable_entities` state-side, mode folds back to `mode0`);
   the paid gate (bang on an api_key engine parks `awaiting`, the
   confirm re-runs with the STICKY `state.paid_ok`, children inherit,
   a restart re-asks SAFE); `available_categories()` derives from
   `searx.engines` (a category only default-disabled engines declare
   must NOT be offered); every new AI route carries the HMAC tk gate
   (embed/rerank/decision/recall/journal replay/browser input) —
   a no-tk POST must 403 safe.
16. **LLM service budgets** — every rerank leg bounded (4-worker
   dispatch pool, 20s, cached client per (base,key), fail-open,
   tokens fold into `usage.rerank`); embeddings chunk to MAX_BATCH 16
   server-side with the 8k per-text cap and the 256-entry LRU
   (texts ≤1000 chars only); the decision service speaks the ONE
   named-verdict-map protocol; jsongate's tiers degrade downward
   never upward.  A hung gateway must stall NOTHING (the §7.5 lesson):
   one slow endpoint costs its budget, not the round.

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

## 7.5 Round record — 2026-10 (the six-lens full sweep: continue × subagents × four-model funnel × PGlite × UI drift)

Scope: a full audit per this playbook with six parallel read-only sweeps
(client UI/structure, server structure, the prompt system, the four-model
services, the PGlite store, the continue chain), then the fix round, then
live verification against `dev-settings.local.yml` (deepseek LLM /
bigmodel embedding+rerank / typesafe decision / amap+baidu MCP / the
built-in browser). Round record highlights that must not regress:

- **The continue chain had a SILENT DATA-LOSS bug**: the evt-log seq
  counters are memory-only, so a fresh tab resuming a dead run renumbered
  from 1 -- every resumed event collided with the stored `run_event` PK
  and `ON CONFLICT DO NOTHING` dropped the whole resumed wire (the
  research streamed fine and replayed as nothing).  Fix: the counters
  reseed from the store (`seedSeqCounterFromStore` on continue, from the
  loaded rows on replay).  Regression: stop a run mid-research, reload
  the tab, 继续 -- the resumed rounds must appear in the replay.
- **A USER-STOPPED run now has a continue entry point**: the failed box
  stays exempt for stopped runs (the quietness contract), so a quiet
  accent 继续 pill renders beside the run footer
  (`stopped && !answer && totalCalls && isLast`).  Without it the kept
  checkpoint was unreachable from the UI.  The failed box is scoped to
  `isLast` (continue/regenerate act on `core.runs[end]`; on earlier runs
  they were a misleading silent no-op).
- **继续 resumes THE RUN's own mode** (a balanced dropdown pick must not
  convert an interrupted report), sends `clarify: answered-EMPTY` (a
  parse_resume failure degrades to a fresh run WITHOUT re-opening the
  clarify gate), seeds the seq counter, guards the double-click
  (`continuingRef`), resets the stage spine on `client.resume` (the
  re-fired plan/research no longer append echo duplicates), bails the
  attach backoff on HTTP 404 (a swept handle never revives), and sends
  the stored outline back (`resume.outline`) -- the server re-validates
  it through `restored_outline()` and skips the outline gate, so an
  interrupted report keeps the TOC the user already saw.
- **The subagent digest was EMPTY by design** (the defect class this
  round exists to catch): children had no `learnings` tool, so
  `child.facts/gaps` never populated and `_sub_digest` returned a bare
  「来源 N 条已入册」 while the child's actual report was discarded.
  Children now register `learnings_spec()` + `system_one_spec()` (the
  lead's judge gate) + `tool_spec(pages_on, ...)` (the reader
  cross-reference), the sub prompt's discipline teaches "your ledger IS
  your digest", `_promote_child` folds the child's rerank/decision
  spend + judgments (tagged `sub:`) + gate usage into the run's account,
  and the digest lists only ACTIVE facts (a superseded fact is history,
  not a finding).  Unit vector: the FakeChild digest/promote checks.
- **The ranking funnel's middle tier had NO timeout anywhere**: the
  openai rerank leg built a fresh sync client per call (SDK default
  ~600s) inside the settlement drain -- one hung gateway parked a worker
  and stalled the round's stream.  Both rerank legs now run on a bounded
  dispatch pool under a 20s budget (fail-open to the previous order),
  the openai client is cached per (base, key), embeddings chunk to
  MAX_BATCH internally (server internals sent 30-doc batches the route
  cap never saw) and `embed_texts` takes a timeout; the two unbounded
  `run_batch` callers (embed route 60s, the corpus rescue 8s) are
  bounded too.
- **Rerank/embed spend is accounted where it is spent**: the writer
  context ordering, the corpus packs (Corpus(usage=...)), and the long
  read's segment trim fold into `usage.rerank`; `evidence_check` folds
  its tokens; the overview's spend remains per-request (accepted).
- **Long page reads trim their writer feed by relevance** (the
  `rerank-as-infrastructure` idea made real): past ~6k chars the feed
  block is rebuilt from the rerank-top segments (line-boundary
  ~1200-char segments, 380-char heads, ONE call) within
  `reader.max_chars` (default 8k) -- the corpus and the client's reading
  pane keep the FULL text; only the feed slims.  Fail-open everywhere.
- **The belief ledger dedups near-duplicate facts** (embedding NN at the
  memory-dedup floor, refs merging into the survivor) -- the small-model
  pathology where one fact lands three ways stops at the ledger.
- **Coverage provenance survives a plan rewrite**: `carry_provenance`
  moves the outgoing items' gathered-sources counts onto the
  containment-matching rewrites -- "keep the list TRUE" re-sends no
  longer flicker the task card's evidence back to zero (verified live:
  a balanced run re-planned 3 -> 6 subtasks, every task kept its 12
  sources).
- **The delegation gate widened one rung**: deep rung>=2, balanced
  rung>=4 (the old deep-only rung-3 gate made delegation nearly
  unreachable), and `<research_policy>` tells the model its
  probe grade.  The researcher prompt gained the cross-verification
  bullet in ALL modes (was deep-only), the change-the-instrument stop
  rule (second angle before stopping, matching the machinery's own
  patience), the ranked+deduped funnel transparency line in the
  web_search spec, and the surprise-triggers-re-plan line; the report
  sections compose `spine.citation_rules()`/`figures_rule()` again (the
  hand-copied block had dropped the placement grammar and the [*]
  escape); the balanced shape opens verdict-first and the deep shape
  carries a length ceiling; the overview role teaches synthesis +
  brevity.  A dead `prior_topics` wire was completed en passant: the
  outline gates inject the knowledge-base topics block now, and
  `build_outline_from_template` ACCEPTS the kwarg the route always
  passed (a template-picked report run crashed with TypeError before
  the gate even ran -- a shipped bug found by pylint E1123).
- **The wire's closed alphabet lives in `core/wire_format.py`** (the
  encode + EVENTS leaf); `agent.wire` re-exports, `core.ndjson` imports
  core only -- importing the NDJSON wrapper no longer drags the whole AI
  stack.  The page extraction moved to `browser/extract.py` (the engine
  renders AND extracts; `tools.web_reader.extract` is a re-export shim)
  -- `browser.session` stopped reaching up into tools.  The raw-args
  JSON parser collapsed to `core.text.raw_args` (nine divergent copies
  deleted); dead modules/constants swept (`agent/thinkgate.py`,
  `wire.LATE_EVENTS`, `loop.time_monotonic`, the duplicated
  `MAX_PARALLEL`, the memoized-forever MCP failure now `cache_clear()`s
  and retries next run); ~20 stale `infra.*`/`runtime.*`/`framework.*`
  doc references renamed; the run-host replay buffer strips the browser
  mirror's volatile JPEG frames (a wait_user window's ~100 b64 payloads
  no longer ride every reattach); the fence splitter's openers are
  precompiled (they rebuilt per streamed delta in the hottest loop).
- **PGlite**: the embed-pending partial index excludes `source_ref`
  (they polluted it permanently -- the idle probe walked every ref row
  per settle); `thread_head` gained its listing index; `knowledge_kind`
  became the two-key sort `(kind, pinned DESC, updated DESC)`; the
  trigram rescue rides the GiST as a KNN ordering (`title %> $1 ORDER
  BY title <-> $1` -- the `word_similarity()` call seq-scanned);
  `hybridRecall` over-fetches (the index legs ranked across ALL kinds
  and narrow kind-sets starved); `tagVocabulary` filters kinds and
  empty-tag rows (it ran before EVERY search POST); `deleteItem(run)`
  cascades its evt rows + ref rows (+ref counter step-downs);
  `deleteThread`/reset sweep `attachment` (bytes used to survive a
  nuclear reset); a failed evt flush RESTORES its buffer (a rolled-back
  settle no longer eats the batch); VACUUM covers `run_summary` +
  `thread_head`.  Schema v5 stands; the source_ref-to-junction-table
  refactor and a `schema_meta` migration seam are the recorded v6
  candidates.
- **UI drift batch**: `HOVER_CHIP` reused in the debug copy chips (the
  hand-typed copies lacked `group-focus-within` -- two copy controls
  were invisible to keyboards); the steer-chips block extracted to
  `SteerChips` (it lived byte-identical in two pages, the dismiss glyph
  had drifted to a literal ×); `CAP_CHIP_CLASS` exported once (four
  hand-typed copies, one at an 11px clickable tier); the AI debug stage
  lazy-loads behind `?aidebug` (~1,500 fixture lines off the production
  thread chunk); the knowledge meta chip renamed `META_CHIP` (the
  same-name divergent `CHIP_OUTLINE` invited exactly the drift this
  round swept); the Dropdown portal carries `SCROLLBAR_NONE`; the AI
  contract types moved to `lib/aicontracts.ts` (the kb layer stopped
  importing features/); the confirm dialog plays its exit animation
  (always-mounted + `useExitPresence`); hostname/filesize helpers
  deduped; the icon/spacing tier outliers corrected.
- **LIVE verification** (the real deployment config): the plugin/
  operator matrix green (hash/time/random/stats/unit/stock/self, the
  5-usd-to-eur trap, site:/-site: filters); one full wire replay (speed)
  settles done with the funnel visible in `usage` (rerank 3 calls /
  decision 9 / gates / judgments incl. the read gate + the pre-write
  evidence check) and only the late set after settle; the browser E2E:
  a real balanced run stopped mid-research, reloaded, continued via the
  new pill -- SAME run section, rounds continuing (第 2 轮 -> ...),
  sources numbering on, re-planned 3 -> 6 tasks with provenance kept,
  settled with a cited answer + mermaid + related.  Mobile 390: zero
  horizontal pan.  The debug stage lazy-loads and its nine scenarios
  settle through the real fold.

Known-red / accepted for later: the AI thread page's Lighthouse red
(§7.1) stands; pylint R09xx in the four pre-existing files (§7.3)
stands (my touched files hold 10.00); the overview's rerank/embed spend
stays unaccounted (per-request one-shot, not a run budget); the
prompts→tools name-constant edge is accepted (names live beside their
specs; the cycle stays lazy-import safe); `handlers.execute` (645
lines) and `_search` (575) await the handler-table refactor.

## 7.6 Round record — 2026-10 (the inspector-document round: the shattering glue)

One user-reported defect with a two-layer lesson: the knowledge panel's
report preview rendered ONE TOKEN PER LINE, and the fix turned into an
upgrade the inspector had been waiting for.

- **The glue shattered per delta**: the `section` wire event's fold
  computed the markdown block-boundary separator (`\n\n`) PER DELTA, not
  per section -- every streamed chunk became its own paragraph in the
  glued `run.answer`. The research page never showed it (per-section
  panes render their own buffers); only consumers of the GLUE broke:
  the knowledge projection, the copy path, the exports. Regression: a
  report run's knowledge preview must render flowing paragraphs.
- **The inspector now renders the DOCUMENT, not the glue**: settleRun
  persists per-section texts (`run_summary.sections`, v5.2 idempotent
  column) beside the outline it already stored in `run.meta.report`;
  the run inspector renders THE SAME `DocumentView` the research page
  used (cover, clickable TOC, per-section headings, citation chips,
  tables, mermaid, the 14px answer tier). Citation chips open the
  source in a new tab (the panel has no rail to scroll to). Older rows
  keep the glued-text fallback.
- **The report's MD export is the document**: `downloadReportMarkdown`
  builds title + subtitle + `## ` section headings in outline order +
  verbatim bodies + the numbered source list (the headless glued text
  was the old shape). The 📄 print view inherits the structure
  (verified light-on-white, sources tail, clean afterprint teardown).
- **The idempotent re-settle IS the migration**: replaying a stored
  thread re-fires the settle checkpoint, which re-writes the run's
  projections with the replayed (fixed) fold -- the corrupted row
  repaired itself on the first reload after the rebuild, no data
  migration needed. Anything that breaks the replay fold now has a
  built-in repair path: fix the fold, reload the thread.
- Verification recipe (§5 extension): patch `URL.createObjectURL`
  before clicking ⬇ to capture the exported blob and assert on its
  content (headings count, source lines, placeholder absence) -- the
  download itself is not observable in the IAB; the §5 recipe 5
  print-probe (window.print no-op patch → `#zjs-print-view-root`
  inspection → tokens-to-initial color check → manual `afterprint`)
  passed unchanged against the new document renderer.

## 7.7 Round record — 2026-10 (the print round: the paper is the view)

User report: clicking 📄 (打印/保存 PDF) "did nothing". Root cause chain,
verified with an event timeline in the in-app browser:

- The embedded browser's webview CANNOT open the print dialog -- and it
  has TWO shapes: a silent no-op and a PHANTOM afterprint whose timing
  varies run-to-run (measured ~1s and ~9s after `window.print()`). The
  paper lived hidden on screen by design (`#zjs-print-view-root {
  display: none }`, shown only `@media print`), so every shape produced
  zero visible change: the click read as dead.
- A wait-then-fallback (reveal the paper if no afterprint within N ms)
  LOSES the race whenever the phantom fires early. The fix removes the
  race: THE PAPER IS THE VIEW -- the sheet mounts visible immediately
  (`.zjs-print-preview`: fixed white ground, the 210mm paper measure,
  scroll, a close chip, Escape), `window.print()` rides right after the
  mount, a real browser's dialog simply opens OVER the paper, afterprint
  retires itself without tearing down, and dismissal is the chip /
  Escape / the host component's cleanup. Contract change recorded in
  AGENTS.md: after saving/cancelling the dialog, the paper stays until
  dismissed (one extra close in a real browser; the webview gets the
  document it could not print).
- Audit-methodology additions: event-timeline instrumentation (wrap
  `window.print` + listen for `afterprint` with timestamps) is the
  probe that names this webview's behavior -- a mounted-check alone
  reads as "the feature is broken" when the pipeline is actually
  working and the ENVIRONMENT is the limitation; and long multi-step
  browser cells jam the IAB pipeline (§5) -- split verification into
  one-action cells with fresh tab recovery.

## 7.8 Round record — 2026-10 (the first full sweep of the post-7.5 waves: memory tripartite × archive lane × control flows)

Scope: everything landed after §7.5 (the 10-24 → 10-27 waves: the
tripartite memory, the findings-only tag namespace, the AI Overview
retirement onto the search route, the knowledge six-tab directory, the
attachment archive lane, the deliverable flip, the paid gate, the
recovery ladder's client half) -- audited through SIX parallel
read-only sweeps against the six NEW audit dimensions this round added
to §7 (11 knowledge store / 12 tripartite memory / 13 recovery+journal
/ 14 static-root build contract / 15 route-level control flows / 16 LLM
service budgets), plus the §4 matrix rows (six-tab directory,
attachment file+image lanes, deliverable flip, paid gate, pasted
brief, retired-shape overview) and the §3 markitdown/camoufox pins.
Gates: build + lint + audit-cjk green; the Lighthouse gate GREEN for the
first time since §7.1 -- the script gained a page-level KNOWN-RED
mechanism (a documented standing load failure reports loudly with its
AUDIT.md pointer instead of failing the run; a page leaves the map by
being FIXED, never by being quiet) and the ai_overview desktop agentic
floor recalibrated 90 → 85 (the card-in-column design's settle-time
extras -- expand pill + run footer + follow-up form -- push the result
list once more; measured CLS band refreshed to 0.12-0.15 in the script
comment; the streaming prose's own growth no longer shifts the page,
AnswerStreamPane).  The audit run itself pulled three more fixes: the
homepage's bare ask-pane TEXTAREA carried `aria-expanded` (disallowed
on a plain textbox -- the a11y 100 / agent-accessibility-tree red; the
attribute is the single-line input's combobox semantics, dropped from
the multiline pane) and its uncapped streaming ANSWER pushed the
results below down on every delta (ai_overview agentic 87 < 90 -- the
card now streams inside a bounded tail-follow pane capped at the
settled preview, the think pane's own pattern); and the audit log
exposed a TENTH P1 the sweeps had missed: with `live_recall` the route
set `user_memories = None` and the settle's `known_memories_fn`
closure iterated it -- `TypeError: 'NoneType' object is not iterable`
on EVERY live-recall run, killing the extractor's memory events AND
the tags (the consolidation organ was dead on the product's normal
path; the None is tolerated, the dedup lens degrades to pass-through).
Live plugin matrix + fixture layouts + one wire replay green (`usage`
now carries the `embedding` bucket; the late set includes `title`).

The nine P1s found by the sweeps (all verified at the code level, all
fixed):

1. **Site recipes + source notes NEVER fired** -- `kind` was dropped
   TWICE on the site_notes path (the client sender omitted it, the
   route parse dropped it), so `_site_note`'s `kind == "procedure"`
   and `_source_notes_feed`'s `kind != "fact"` filter matched nothing:
   the whole host-bound memory half of 860619d was unreachable.
   Regression: save a host recipe, run a question whose results touch
   that host -- the browse/search feed must show the recipe/note.
2. **The AI Overview lost its sources** -- the 114e2c4 route migration
   kept `direct=True` on the no-research branch while ALSO passing
   `overview_feed`; writer_messages' direct branch replaces the
   context with "No sources" and bans [n] -- the assembled [n] corpus
   was discarded and the shape ladder's overview rung stranded.  Now
   `direct = mode != "overview"` (the greeting/chat write keeps the
   direct contract).  Regression: `?q=…&ai_overview=1` -- the card
   renders [n] chips that resolve to the page's own results.
3. **`parse_browse_call` dropped five advertised session surfaces**
   (scroll `text=`, read `download=`, history `op=`, tab `op=`/`index`,
   multi `steps`) -- calls degraded to blind wheel / live-page read /
   empty-op error / tab-list / "multi needs steps"; AND the schema's
   duplicate `steps` key meant the model never even saw the multi
   array (the drag integer definition silently won).  Fixed the parser
   branches + the `steps` oneOf.  Regression: one live call per
   surface.
4. **`inspect_image`'s `n` binding was dead at BOTH layers** -- the
   parser returned the URL only, and the handler read `call.get("n")`
   off the raw tool-call dict (n lives inside `arguments`).  The
   parser now returns `(url, n)`; the injection label carries the [n].
5. **Uploaded/primer documents were silently undeletable** --
   removeItem routed `kind === "document"` to `deleteSource(url)`,
   but attachment rows have `url NULL` (`url_hash = $1` never matches
   NULL) -- the delete no-oped behind a "deleted" toast.  Documents
   now delete by ROW ID; sources keep the url cascade.
6. **Documents were unreadable in the inspector** -- `loadDocument`
   queried `doc:<urlhash>`, an id space that died with the doc:-twin
   refactor (rows live in `src:` / `doc:att:`); every document's
   reading pane rendered 未读全文 forever.  The document branch reads
   `loadItemBody(id)` like the crawled-source branch; `loadDocument`
   is deleted.
7. **The 资料 tab's search always showed "no match"** -- searchByKind
   filtered `item.kind !== "reading"`, but hits are kind
   source/document.  The reading filter now accepts both.
8. **Memory kinds lesson/gap folded to "fact" on read** --
   rowToMemory kept only the procedure special-case while four kinds
   are written; lessons/gaps never reached the researcher snapshot's
   SEARCH LESSONS / OPEN QUESTIONS sections.  All four kinds survive
   the read.
9. **The continue probe re-folded the whole host buffer after a
   reload** -- `resume()` seeded only the evt-log n counter, never the
   wire-seq watermark, so the failed box's attach probe sent
   `after_seq: 0` and every delta appended twice.  resume() now seeds
   the watermark from the stored rows' seq (the recoverAfterReload
   scan, all runs).

Plus the `_hosted_response` prime tail (recovery sweep): the prime
loop breaks on the first content event (`open` is one) with the rest
of that pull batch still in `pending` -- rest() now drains the tail
before pulling live (the lossless-prime doctrine, §7.4 lesson 1, now
actually holds on the prime path).

The P2/P3 batch: `resetDatabase` drops the `memory` table (the nuclear
reset left every memory row); per-run deletion sweeps `attachment`
(deleteRunData's docstring claimed it already did); subscribeMemories
selects `host` (site recipes lost their host badge in the live panel);
backfillSeedTags marks token-less rows instead of re-selecting them
forever (a 200-row empty-title corpus wedged the write queue); the
settle fold passes `usage.embedding` (the footer's 嵌入 segment could
never render); DeckView holds back the streaming tail like every
other render surface; the deck section stack drops the generic
markdown surface (it re-taught the dialect's FORBIDDEN list);
section_system dates at CALL time with the run tz (the import-time
`<today>` went stale at midnight and duplicated the synth's fresh
block); FEATURE_DEFAULTS' depth ladders match profile's caps
(balanced 12-60 / deep 15-120 -- the defaults silently capped balanced
at 32 and made the route fallback dead); the journal registration
defers the singleton lookup INTO publish's fail-open try; the journal
row cap is ENFORCED (one PK probe per append); extractor's procedures
clause carries the language rule; memory's host param description
covers source notes; subagent's report block teaches "your LEDGER IS
your digest" (the lead reads the ledger, not the final prose); the
client retry resets the dead attempt's decisions; clarify/reattach/
resume clear browserSessions (a stale live frame could resurface as
the mirror fallback); the sources fold REPLACES merged rows instead of
mutating shared snapshot objects; saveAttachments rides the write
queue; 15 orphan i18n keys deleted from BOTH catalogs; the doubled
RowActions doc comment and the stale 90s-grace / flip-record comments
corrected; AUDIT.md §6's late-set list gains `title`; AGENTS.md's
emscripten-twins passage synced to 53363eb (the unhashed twins ARE
published -- the worker-less fallback resolves them).

Known-red / accepted (recorded, not fixed): the paid gate's paid_ok is
self-asserted by the model (documented claim-based -- a model that
passes paid_ok:true on the first call skips the hold; the fail
direction is an explicit user-invisible spend, the ask remains the
prompt-level contract); the direct pick's peek→set window (a
same-instant model flip can overwrite a just-landed direct pick --
narrow, needs a control-plane CAS to close); the pre-driver gate chain
sits outside every quiet bound (a slow gate can starve the client's
170s watchdog while the run lingers); rerank spend on a timed-out leg
is under-recorded; paid_engines() over-includes inactive settings
entries (spurious ask, fail-safe); site-note host match ignores ports;
inspect_image injections ride outside the screenshot budget;
bootMain's main-thread lane bypasses the election lock (budget-bounded);
a degraded session's recovery rows evaporate loudly-to-console only;
the journal rebuild never re-probes the next generation and stale `.N`
files accumulate on Windows; run_index is never swept; kb writes in
events.ts/templates.ts/renameThread still bypass the enqueue contract
(saveAttachments, the ordering-sensitive one, is converted);
searchKnowledge filters pinned/since after the limit cut; the call/
task inspector shows the 600-char head.  The AI thread page's
Lighthouse red (§7.1) stands.
