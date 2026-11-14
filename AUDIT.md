# AUDIT.md — zjsearch audit playbook

The reusable methodology for a full-theme audit. The next audit is:
bootstrap → gates → test matrix → measurements → fixes → regress → docs.

**The playbook holds METHODOLOGY only.** Per-round findings (what was
broken, what was fixed, which commit) belong in commit history. When an
audit round discovers a NEW durable check, fold it into §7 as a vector
under the matching dimension — and delete the narrative. The playbook
also stays in this repository's scope: the family contract (DESIGN.md)
may be referenced, other repositories' histories may not.

Goal setting: audit in rounds until a round adds no findings. Every fix
re-runs the regression for its area AND the lint gates; every round ends
with durable lessons landed in AGENTS.md / DESIGN.md (§17 governance) so
the same mistake is never audited twice.

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
cd client/zjsearch && pnpm run lint         # biome + tsc --noEmit + audit-cjk
pnpm run audit                              # Lighthouse gate — home + every result
                                            # presentation + the AI surfaces (deterministic
                                            # mock LLM transport; Edge fallback built in)
```

The zjsearch client is a pnpm workspace (`pnpm-lock.yaml` + `packageManager`);
`pnpm install --frozen-lockfile` is the only install path in scripts. The
upstream simple theme stays on npm — never let the two lockfiles mix.

The Lighthouse gate carries a page-level KNOWN-RED mechanism: a documented
standing load failure reports loudly with its AUDIT.md pointer instead of
failing the run — a page leaves that map by being FIXED, never by being
quiet.

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
  unrelated audit (the typescript Go-based rewrite was left unadopted this
  way; read its release notes and adopt deliberately, with the full matrix
  re-run).
- After updating: `pnpm run lint` + `make themes.zjsearch`, RESTART the
  instance (new hashes), then regress the surfaces that exercise the
  moved packages — the AI overview (react-markdown / remark-* / katex /
  mermaid / lucide-react), the knowledge-base drawer and the
  preferences PGlite tab (@electric-sql/pglite*), a grid page (ol), and
  the streamed boot (vite output shape feeds the static-root publishing
  contract).

python — the AI SDK transports live in requirements.txt as exact
pins; bump only when the index is actually ahead, then reinstall, restart,
and re-run the live AI test (their only consumers are the SDK factories in
`searx/zjsearch/ai/llm/sdk/`).  The theme's other own pins (bm25s =
the reranker plugin, mcp = the tool-server bridge,
`markitdown[pdf,docx,pptx,xlsx]` = the ONE document
converter behind `core/convert` — attachments, native PDF reads and the
reader's HTML pass all ride it, `camoufox[geoip]` = the render engine)
follow the same rule, each with its area's regression: the
§4 plugin matrix for bm25s, one real MCP tool call for mcp, one
FILE-attachment upload
(a docx — the conversion receipt must land a 资料 row) for markitdown,
one browser open+read for camoufox.

```sh
local/py3/bin/pip index versions openai
local/py3/bin/pip index versions anthropic
local/py3/bin/pip index versions google-genai
local/py3/bin/pip index versions bm25s
local/py3/bin/pip index versions mcp
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
| Mobile — knowledge drawer | header button | FULL-WIDTH sheet (w==390) with an opaque `bg-bg` ground; judge by DOM geometry — the IAB screenshot pipeline serves stale frames here routinely (§5) |
| Mobile — AI Overview | `?...&ai_overview=1` | card auto-opens at the 16px page margins, citations + run footer render |
| Wide | 1920 / centered-mode toggle | container-query grids re-step |
| Preferences | drawer, all tabs (incl. PGlite) | row language uniform, autosave toast |
| About/Stats | header icon buttons | drawer panels, internal links browse in-panel |
| 404 / NoJS / RSS | `/nonexistent`, noscript block, `format=rss` | canonical faces (rss.xsl self-contained) |
| AI Overview | results page → AI Overview trigger | stream, thinking fold, [n] chips, show more, regen, copy |
| AI Overview deep link | `?q=zjaudit+general&ai_overview=1` (mock or live) | card auto-opens WITHOUT interaction — the Lighthouse gate's overview page |
| AI Search takeover | `?q=searxng&ai=1` (live model) / `?q=zjaudit+general&ai=1` (audit mock) | research timeline (think → intent → parallel call rows incl. a page read: the row's char count, the reading pane, the read-in-full badge), cited synthesis with the inline gallery strip, related, own source rail; follow-ups continue the [n] numbering.  The research box STAYS OPEN through the run's whole life; the follow-up box unlocks on `settle` (never on the trailing related/memory); the audited timeline must show NO error row (§6 tripwire) |
| AI browser session | the debug stage (`?aidebug` on a thread url) → the 浏览器登录协作 scenario: ALL rows settle; open renders the location line + the interactive-element outline (e1/e2/e3 chips); wait_user AUTO-OPENS the takeover and the window-end frame retires the countdown; below lg a fixed bottom bar opens the same takeover; the screenshot row renders its shot; replaying a stored thread NEVER shows the live card nor auto-opens (resume nulls `browser`).  Live: a `browse open` run mints a [n] source the writer cites; the settlement's `img` never reaches the evt log |
| AI 引导/干预 | the debug stage → the 引导 scenario (drained/preempt/discarded three states), then LIVE: Enter queues a steer (pending chip → the next boundary injects it); Shift+Enter / ⚡ preempts (the in-flight turn cancels, the run CONTINUES steered); a steer typed after the write phase opened flips the chip to 未送达 (never silent) |
| AI 子代理 | the debug stage → the 子代理 scenario (the delegation row, the folded sub row, the re-open that must NOT duplicate it); LIVE: deep + depth rung — the model delegates, each sub row folds to one line and opens the mini-timeline; the digest arrives as the delegation row's receipt; promoted facts land in the findings card; the batch cap's last delegation refuses with the merge-nudge.  A run settling with a child batch in flight leaves ZERO spinning rows (the `sub-pending` scenario is the fixture) |
| AI 浏览器多会话 | a delegating run whose subagents drive browse: the rail card grows the TAB STRIP; the ACTIVE tab streams, background tabs freeze on their last frame; the takeover is the LEAD tab's surface only (the input endpoint 422s non-lead sessions); a finished subagent's tab disappears; a single-session run renders the pre-strip card — replay old threads likewise |
| AI clarify / ask_user | an ambiguous query (live), or the mock's clarify fixture | the clarify modal with the question form (提交 / 跳过); answering seeds a clarify step at the timeline head; a mid-research ask_user renders as a call row + the same modal |
| AI memory | any researched run (live model) | stored facts ride the run's `<user_memory>` block; a memory save renders a memory row AFTER settle; the extractor's saves appear in the drawer's 记忆 tab WITHOUT a reload |
| Knowledge base | header drawer icon | the kind tabs (研究 / 资料 / 图谱 / 记忆 / 模板 / 管理): every listing row on the shared row anatomy; every empty state on PaperEmpty; every loading face on BootRowsCard (never a lone spinner/ellipsis); every delete confirms; the search box filters its tab |
| Thread page | `/zjsearch/ask/thread/<id>` direct boot + REFRESH | the run replays with its timeline; a refresh must NEVER flash 找不到该会话 (resume awaits the store fallback, not just the per-tab mirror) |
| Print view | 📄 on a settled run, in EVERY theme (light/dark/black) | the print sheet mounts visible immediately; light on pure white in all themes; the live page never re-renders; the saved filename mirrors the MD export (§5 recipe 5 for automation) |
| MD thread export | the export action on the run actions row | valid markdown: one `## ` per question, sources at the foot, gallery placeholders NEVER appear (each becomes its images' markdown figures) |
| AI failure UX (overview) | point `zjsearch.llm.base_url` at a dead port | 502 body reason readable under the card's failed label |
| AI failure UX (search) | a settled run with NO answer (writer empty/dead stream) | the failed box with reason + retry + classic fallback — a researched-then-empty run must NEVER settle as silent nothing (stop-button cuts are exempt: `stopped` runs stay quiet) |
| Stop → store | stop a run mid-research (real settings), then open the drawer's 研究 tab | the thread_head + run row landed (run meta carries the stopped flag) — the stopped thread IS in the history list.  If a deployment reports it missing: check `__zjsKnowledge.degraded()` FIRST, then the image's source commit |
| Attachment upload — file | hero paperclip: a .docx (or the composer's DataTransfer injection), then a question | the run's timeline shows the attachment; AFTER settle the 资料 tab gains a 「全文」 row titled with the filename; the row opens the inspector's reading pane; a follow-up in the SAME thread inherits the file (up to 6, removable in the picker) |
| Attachment upload — image | a .png/.jpg via the paperclip | the image compresses client-side, rides the FIRST turn as a vision part; it does NOT appear in 资料 and does NOT inherit to follow-ups |
| Deliverable flip | a deep/balanced run whose request suits a report: pick 报告 in the OUTPUT STRUCTURE card mid-run | the picker lights the TOC + DocumentView at the write boundary; 直接回答 pick withdraws a pending flip (mode folds BACK to the birth tier, run settles as a plain answer); a settled record keeps the card as its FORMAT RECORD (never a hole) |
| Paid-engine gate | settings with an api_key engine disabled-by-default; ask the model for that engine by NAME | the search settles as approval (待用户确认 row), the run parks `awaiting` on the ask_user; confirming re-runs with `paid_ok` and the WHOLE run stays approved (sticky); the confirmed direction seeds the clarify step |
| Pasted brief | paste a multi-KB research brief into a follow-up composer | the pane auto-grows (~8 lines then internal scroll), Shift+Enter = newline while idle / PREEMPT steer while streaming; the run title clamps at THREE lines behind the expand chip; the tab title caps at the first line / 80 chars |
| AI Overview (retired shape) | `?q=zjaudit+general&ai_overview=1` deep link + the results-page trigger | the card renders as the results column's paper-dressed card, answers back, regen/copy work; the standalone overview page is GONE — the deep link boots the results page with the card open |
| Debug stage | `/zjsearch/debug/thread` → every scenario | every scenario settles through the REAL fold via the real section renderer; a scenario whose rows do not settle (interrupted tails, error rows) means a stale fixture or a stale chunk |

Plugin answers (server-side; test via curl §6, not the browser):

| Query | Expected answer `kind` |
|---|---|
| `md5 hello` / `sha256 abc` | hash |
| `time tokyo` AND `time in tokyo` | time (filler word regression) |
| `random string` / `random int` | value (+swatch) |
| `min 2 8` / `max 1 5 3` / `avg 4 6` | stats |
| `1 lb to oz`, `usd to cny` | unit_conversion (UPSTREAM's symbol table has no `kg` — mass pairs spell `lb`/`oz`/`g`) |
| `5 usd to eur in gbp` | unit_conversion → **usd→eur**, never usd→gbp |
| `$AAPL` (=`%24AAPL`), `AAPL stock` | stock (mind the URL encoding!) |
| `user-agent`, `ip` | self |
| `python site:docs.python.org` | only that domain survives |
| `test -wikipedia.org` | **zero** wikipedia hits (-domain promotion) |
| `"finite state machine"` | exact phrase |

Result-ordering plugin (test via curl, not the browser — ordering has no
answer payload):

| Check | Expect |
|---|---|
| `python tutorial` vs the same + `&disabled_plugins=bm25_reranker` | both 200 with results; the enabled run rewrites `positions` (order may differ; on a zero-signal query the engine order STANDS — do not expect a flip) |

## 5. Browser measurement recipes (browser-use)

The in-app browser has documented failure modes that fake product
bugs. Probe BEFORE concluding anything:

1. **Jammed compositor** (rAF starvation): transitions snap, rAF-driven
   opens never fire, timers clamp, screenshots serve stale frames.
   Probe: `await Promise.race([new Promise(r => requestAnimationFrame(r)),
   new Promise(r => setTimeout(() => r("JAMMED"), 1500))])`. If jammed →
   close the tab, open a fresh one, re-measure. **Measurements taken in a
   jam are void**.
2. **Stale screenshot frames**: DOM can be correct while the capture lags.
   Verify state via DOM (`aria-expanded`, computed `gridTemplateRows`,
   `getBoundingClientRect().height`), use screenshots only for final
   visual confirmation. Nudge with `scrollBy(0, 1)` + wait before capturing.
   When captures start timing out repeatedly the backend is jammed — close
   and reopen the tab, don't retry into the jam.
3. **Smooth scrolling silently disabled**: this webview drops EVERY native
   smooth scroll — `scrollIntoView({behavior:"smooth"})`,
   `window.scrollTo({behavior:"smooth"})` and CSS `scroll-behavior:smooth`
   all no-op (no animation AND no jump) while instant scrolling, CSS
   transitions and rAF stay healthy. Probe: sample `window.scrollY` per
   frame around a `scrollTo({top: X, behavior:"smooth"})`. The theme's own
   `animateScroll` tween (`src/lib/motion.ts`) exists precisely because of
   it — never call a "broken" animation until this probe is clean.
4. **Dead locators / dead keyboard injection**: if Playwright locator
   clicks time out but `elementsFromPoint` shows the target on top, fall
   back to CUA coordinates; if synthetic keydown never reaches the page,
   CUA `type`/`keypress` carries real input events. Long multi-step
   browser cells also jam the pipeline — split verification into
   one-action cells with fresh-tab recovery.
5. **The print dialog cannot be automated**: verify the print view by
   no-op patching `window.print` BEFORE clicking 📄, then inspecting
   `#zjs-print-view-root` and — for colors — setting the tokens
   to `initial` on `<html>` with `html.style.transition = "none"` FIRST
   (the palette cross-fade otherwise feeds the probe mid-flight colors).
   Fire `afterprint` manually to tear the view down; `body.zjs-print-view`
   must end up removed.  For behavior questions (does the webview open
   the dialog at all), instrument first: wrap `window.print` and listen
   for `afterprint` with timestamps — a mounted-check alone reads as
   "the feature is broken" when the pipeline is actually working.
6. **Phantom "still loading"**: ask the page, not the eye —
   `document.getAnimations().filter(a => a.playState === "running")`
   names the exact animation still running.  A permanently-running CSS
   animation can also stall screenshot pipelines that wait for paint idle.

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

A CSS transition FROZEN at its start value (computed
`grid-template-rows: 0px` while the inline style says `1fr`) is the JAM,
not a theme bug: trust the DOM truth — Collapse's 120 ms timeout fallback
has already committed the end state; only the paint is missing. Close and
reopen the pane and re-measure.

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
  -d "{\"q\":\"<question>\",\"tk\":\"$TOKEN\",\"mode\":\"balanced\",\"lang\":\"zh-CN\"}"
```

- The closed alphabet + EVENTS set live in the CORE leaf
  `core/wire_format.py` (`agent.wire` re-exports) — an unknown event
  raises server-side.
- Research run shape: `open` (kind research, round N) → `think`/`say`
  deltas carrying THAT entry id → `calls` (the batch) → one `call`
  settlement per tool → `close` → next round … → `open` (kind write) →
  `answer` deltas → `settle` `{status: done|awaiting|error, finish,
  usage, model, halt}`.  `tasks`/`findings`/`plan` snapshots and
  `sources` (the [n] registry) ride along as authoritative state — the
  client never reconstructs anything.
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
- **THE MOCK MUST TRACK THE TOOL VOCABULARY** (`scripts/ai-mock.mjs`):
  when the tool surface renames (web_search→search_web,
  web_browser→browse, calculator→calculate, task_write→update_plan,
  learnings→record_findings, past_research→recall_history was the last
  one), a stale mock speaks dead names — every audited AI page folds
  error rows while the Lighthouse gate stays green.  THE REPLAY'S
  ERROR-ROW COUNT IS THE TRIPWIRE: a `zjaudit ai` replay must settle
  with ZERO error rows (the reader row with its char count, the
  update_plan pair, the record_findings row).  The mock is spawned by
  the audit script; for a manual wire replay boot it alone:
  `node -e "import('./scripts/ai-mock.mjs').then(m => m.startAiMock())"`
  from client/zjsearch.
- The audit instance variant (:8907 + `zjaudit` queries + the mock
  transport on :8909) replays the SAME checks with zero model variance
  and milliseconds of latency — use it when the failure is in the SERVER
  plumbing rather than the model.

## 7. Code audit dimensions (the sweep)

Dispatch parallel read-only Explore agents (client / server) with the layer
rules and the shared-token inventory from AGENTS.md, covering:

0. **Structure/naming/reuse** — duplicated JSX blocks, hand-typed tokens
   (CHIP/PILL/SEGMENT_*/BODY_ROW), reinvented hostname/date/number
   formatting, dead exports (grep-verify each claim), layer inversions.
   The placement doctrine (DESIGN.md §12) governs: `components/` is
   CROSS-PAGE only; features own real domains; lib modules are lowercase
   topics; zero default exports.  REUSE-FIRST: new list-shaped tool
   bodies compose the shared furniture (`calls/bodyParts.tsx`:
   BodyRow/CopyValue/DirectoryGrid; `components/CapList.tsx`: the
   cap-and-expand list) instead of re-typing grounds — run the
   orphan-export scan and the legacy-compat sweep each round
   (stored-legacy unions die with their era).
1. **Performance** — bundle sizes, eager graph, lazy boundaries, memo on
   hot trees (results during AI streaming).
2. **Animation completeness** — every conditional render either animates
   in/out or is a sanctioned instant swap (documented as such); every
   disclosure has `aria-expanded` + the rotating chevron through
   Collapse; hover/press transitions on every interactive element;
   dismissals through `useExitPresence`; content swaps (tab panels,
   pagination) covered by the enter animation; a settled page carries
   ZERO looping animations.
3. **Plugin behaviour** — the §4 matrix plus edge cases (CJK terms,
   multi-keyword queries, unknown locations = silence).
4. **Icons** — same concept = same icon everywhere; X = dismiss only;
   failed rows wear the alert family; text-only controls next to
   icon-paired siblings; sizes on the icon tiers.
5. **Design tokens & skeletons** — light/dark/black sweeps,
   widescreen/centered, contrast tiers (the gate's boundary nodes are
   shipped bugs: a 4.2:1 text is wrong even when the last run passed),
   skeleton geometry vs real page in BOTH modes (classic card-list
   mirror AND the AI-takeover branch — three renderings of one
   geometry, kept in sync by hand); every surface's loading state on
   BootRowsCard/doc ghosts, never a lone spinner or ellipsis; the
   KNOWN-RED map honest.
6. **Result cards** — every category layout renders its full
   presentation; field-shape tolerance (filesize string|number,
   timedelta variants); the fixed slot anatomy + margin language.
7. **Interface uniformity & surface words** — every empty state on
   PaperEmpty (icon disc + heading + one line + ONE action); every
   capped list on CapList; panel furniture from SettingParts
   (SectionLabel's actions slot for bands with a control); chip/pill
   ladders (CHIP_OUTLINE 13px clickable pair / CHIP_BTN 28px round
   actions / CHIP_SOLID·CHIP_DANGER solids / SEGMENT_* rows); per-mode
   tool rows speak a VERB PHRASE per mode (row label + pending verb +
   body caption + mode icon — never the bare query nor the tool's
   generic name); listing rows on the shared row anatomy (kind rows on
   the archive tier like their siblings).
8. **AI feature** — live-model test (stream, citations, thinking,
   regenerate, copy) + backend review.  Each resilience contract gets an
   explicit check: the writer's empty-stream retry; the fence-last
   prompt rule; the settled-run-without-answer failed box; the spawn
   recursion guard; the memory pair (pre-sent block + post-run
   extractor); the MCP bridge degradation; the print view's off-screen
   mermaid render (§5 recipe 5); the GOAL LOOP (unbounded — ends on the
   ledger closing or a stalled run); the ask_user SHAPE EQUALITY
   (spec vs sanitizer advertise the same wire); the HUMAN-IN-THE-LOOP
   posture; the recall DUAL INDEX (full-text heads vs identity-only
   rows); the OVERVIEW accuracy path; the spine FIGURES rule; the
   cross-session badge (PRE-run recall — never badges itself); the WIRE
   PRODUCER check (every yielded tuple in the closed EVENTS set — a
   replay containing a reader read is the regression); the client
   live-fold accepts the LATE set; the gallery whitelist mirrors the
   feed; settle-path checks (streaming row + stale-run sweep);
   interrupt semantics THREE-VALUED (died ≠ interrupted ≠ ok); the
   continue chain (attach-probe first, 404 → ctx replay, seq watermark
   seeded from the store, the stopped-run continue pill); resume keeps
   the run's OWN mode and revalidates the stored outline; dedup keys
   describe the search AS EXECUTED (an unfiltered retry must re-run);
   reader launch parameters ride the QUERY string; subagent rows never
   duplicate on re-open and the digest lists ACTIVE facts only.
9. **A11y** — icon-only buttons labelled, dialogs named + focus-trapped
   (`useDialogFocus` with the open flag as `active`), `alt` on images,
   keyboard reachability (ARIA tablists walk with arrows; Escape
   ownership: a nested dialog in its inert exit window owns the next
   Escape); absolute dropdowns render inside a POSITIONED root (an
   unpositioned component root lets `top-full` resolve against the
   panel/viewport — the unreachable-dropdown class); an in-panel
   fallback's escape is a real navigation, never an anchor the
   click-capture can loop.
10. **Prompts & tool instructions (BOTH channels, structure AND
   content)** — STRUCTURE: the spine fragments COMPOSED, never
   hand-copied; round policy lives ONLY in the depth branches of
   `runs/profile.py`; the reply language is a DATA TABLE from catalog
   tag → language name; the search tool exposes the parameters the
   deployment supports + the precision operators + the bang escape
   hatch + the empty-result fallback; per-run material
   (`<research_policy>`'s graded values) rides the USER message's
   `<run_context>` — per-run blocks in the system prompt break the
   cross-run prefix cache; tool-conditional blocks key off the
   registered `toolset` frozenset (composition asserts over
   `spine.build_messages` / `initial_messages` with a minimal AND a
   maximal toolset — the prompt can never promise a tool the model does
   not have).  CONTENT (the drift sweep — the mock-spoke-dead-names
   class hits prompts and INSTRUCTIONS exactly the same way):
   (a) VOCABULARY: every tool name / action / parameter / surface term
   quoted in ANY prompt module (`prompts/*.py`) and in every tool's
   description + INSTRUCTIONS must exist in the CURRENT spec — script
   it: collect the registered tool names + the browse action enum +
   each spec's parameter names, then flag quoted identifiers in prompt
   text that match none (a rename leaves prose stale silently).
   Triage the hits — four benign classes recur: URL paths inside
   example links, the module's own function-name docstring references,
   each tool's OWN parameter names, and historical notes in module
   docstrings (which never ship to the model); everything else is real
   drift;
   (b) TWO-CHANNEL PARITY: description and INSTRUCTIONS must not
   contradict (the same action taught two behaviors), doctrine lives in
   INSTRUCTIONS only, semantics only in the description;
   (c) WEIGHT: flag the heavyweight (spec description + INSTRUCTIONS
   character counts per tool — they ride EVERY run and the overview;
   the top offender once carried ~2.2k tokens of which half was
   doctrine leaked into the description);
   (d) BYTE-STABILITY: two same-day builds with different round budgets
   / depth grades must produce an IDENTICAL system prefix (script the
   diff — a clock or graded value in a cached block breaks the prompt
   cache for every run);
   (e) STALE DOCTRINE: prompts teaching a RETIRED behavior (the pooled
   one-shot read lane, the removed write-audit phase, retired payload
   keys) must read as dead — grep the prompt text against the removed
   feature's vocabulary;
   (f) LANGUAGE RULES: the directive table, the memory locale rule, and
   the honesty notes (`notes.py`) speak the run's UI locale; halt notes
   cover every `halt_reason` value in the closed set (i18n keys too).
11. **Knowledge store & the RAG archive lane** — the ONE-ROW-PER-PAGE
   doctrine; the retrieval head-bias contract (first-8k serves both
   legs, body keeps 60k — recall is head-biased BY DESIGN); the
   embedPending partial index excludes source_ref; attachment rows join
   every document surface while IMAGES stay out; the attachment bytes
   sweep on deleteThread/reset; projections are upsert-idempotent;
   stopped/failed runs land the SAME projections as done runs (the
   thread directory is the history — verify the stopped path explicitly).
12. **The tripartite memory** — the `memory` OWN table; FULL CRUD
   sanitized against the advertised shape; the consolidation organ
   writes through the SAME projections; the dedup floor cannot eat a
   DISTINCT fact; site recipes host-bound and browse-lane-only; every
   memory lands in the UI locale; all written kinds survive the read
   (a kind folded on read starves the researcher's sections).
13. **Recovery & journal ladder** — every run registers `linger`; the
   journal fails OPEN on every consumer, rebuilds at a generation path,
   TTL + rank sweep enforced, the thread-index carries the run ORDINAL
   (the replay labels the run truthfully); the resume chain probes
   live host → journal → interrupted state; excluded classes stay
   excluded.  Client: the watchdog ceiling above every server quiet
   bound AND the idle clock ARMS AT RESPONSE-HEADER TIME (the
   pre-stream gate phase can legally sit silent); the wait_user
   stand-down carries a CAP (a half-open socket never delivers the
   retiring frame); the reattach ladder covers the detach grace; the
   failed box's 继续 attach-probes first; the store boot races its
   budget and DEGRADES loudly (`__zjsKnowledge.degraded()`) — a
   degraded session must never silently fake a real store, and the
   degraded-first triage precedes any "data lost" investigation.
14. **Static-root publishing & the build contract** — after EVERY
   build: the gzip/brotli siblings exist; the dist dedup freed the
   unlinked copies (nlink guard); the PGLite FS artifacts sit at the
   static ROOT; the results chunk keeps its STABLE name; extra
   root-level CSS chunks resolve as siblings; the build stays
   warning-free with the onwarn filter scoped to node_modules authors.
15. **Route-level control flows** — the deliverable flip's priority
   chain and the direct pick's OUTRANK; the paid gate (hold → ask →
   sticky `paid_ok`, children inherit, restart re-asks SAFE);
   `available_categories()` derives from `searx.engines`; every new AI
   route carries the HMAC tk gate — a no-tk POST must 403 safe.
16. **LLM service budgets & caches** — every side-model leg bounded and
   fail-open (rerank pool 4-worker/20s, embeds chunked + LRU + 8s,
   decision images fetched concurrently); the ranking cascade and the
   MCP calls ride the ROUND POOL (no inline network work on the driver
   thread — the settlement drain only serializes feed blocks); the
   run-spend account takes a lock (workers fold concurrently); the
   writer-build bridge is bounded (a timed-out bridge degrades to the
   chronological order); SDK clients cached per (family, base,
   api_key); an anthropic thinking-retry re-stamps the cache tail;
   jsongate's tiers degrade downward never upward.  A hung gateway
   costs its budget, not the round.
17. **Browser-use session** — spec/parser parity per action ONE BY ONE
   (the advertised-parameter-dropped class ships silently: cross-check
   every advertised arg against a parser branch); the download ledger's
   lock/sweep/drain (a REJECTED line must never vanish; the wait window
   drains its own); uploads source from the LEDGER ONLY (the
   readable-documents gate holds in reverse); a multi rejects wait_user
   up front; a multi-index read attributes its LAST section explicitly
   (feed-splitting archives the wrong body); the popup net + idempotent
   tab registration; snapshot/annotation pierce open shadow roots (the
   frame-scan cap documented); `window.stop()` settles every navigation
   lane; the takeover's wheel forwards both axes; wait frames ride the
   lean quality.
18. **Tool design & progressive disclosure** — the TWO-CHANNEL doctrine
   (description = call semantics on the tools array; INSTRUCTIONS =
   doctrine via `<tool_notes>`; no doctrine in a description, no
   semantics missing from one); MCP tools inline at ≤4, the discovery
   tool past it; matched schemas capped IN THE FEED (the structured row
   keeps the full shape); discovery handshakes concurrent with a
   PER-SERVER budget (one dead endpoint must not erase the healthy
   servers nor re-pay the aggregate every run); settlement payload keys
   all consumed (dead bytes are drift) and every settlement carries the
   debug contract (`raw`).
19. **i18n catalogs** — the scripted sweep (extract both catalogs):
   key parity EXACT, placeholder parity EXACT, dead keys deleted,
   hardcoded literals outside the catalogs flagged, zh punctuation
   full-width (，。：；？！), ellipsis `…` never `...`, the interpunct
   `·` everywhere; the CASING LADDER by role (controls Capitalized /
   meta vocabulary lowercase / title lines sentences — judge each hit,
   do not bulk-rewrite).
20. **Client rendering contract** — the mirror contract (the prompt
   teaches exactly the grammar the chain renders — DESIGN.md §5.1);
   the separator seam (single-dollar inline math OFF — unaudited model
   output would feed currency pairs to KaTeX); forbidden raw HTML
   degrades VISIBLY (inline tags to text, blocks to code — never
   silently dropped); `holdBackTail` applied at the render sites,
   never in the event fold; the writer's single-oversized-block split
   (head-first at a line boundary, corpus/pane keep the full text).

## 8. Known environment traps

- `pnpm run audit` needs a Chromium browser — the script FALLS BACK to
  the Microsoft Edge app bundles on its own; `CHROME_PATH` still wins
  for anything exotic.  Headless Edge/Chrome sometimes DIES mid-run;
  the audit script relaunches it and carries on.
- `manage`-anything re-runs pip; a mirror serving 0-byte wheels fails
  the hash check → start granian directly (§1) and/or pin `-i` to a
  working index.
- Template edits need an instance restart (Jinja caches compiled
  templates); python edits too (no reload in this start mode).  After
  killing the dev instance the built-in browser can LINGER and hold the
  persistent profile's lock — the engine self-heals (kills the stale
  holder of the exact profile path + retries once), and the error hint
  names the manual `pkill -f Camoufox` escape.
- **THE DOUBLE-INSTANCE TRAP**: `pkill -f "granian searx.webapp"` NEVER
  matches (the pattern string is not contiguous in granian's own
  command line) — "restarts" silently stack a second granian on the
  same port and every python change "didn't take" while requests
  round-robinned between old and new code.  Kill with `pkill -f
  granian` and verify ONE instance (parent + worker) via
  `ps -eo pid,etime,command | grep granian` before concluding anything
  about server-side changes.
- `$AAPL` is `%24AAPL` — a mis-encoded test vector once sent the audit
  chasing a non-existent stock-plugin bug. Double-check encodings before
  suspecting the code.
- A rebuild while an instance is RUNNING can serve the new chunk
  TRUNCATED at the old file's byte length — `curl` the chunk and `cmp`
  it against disk; if they differ, RESTART the instance (the
  restart-after-rebuild rule is not platform-specific).
- dev-settings.yml ships PLACEHOLDER keys (the tree is public) — a
  fresh clone has NO working LLM/embedding/MCP endpoint until the real
  keys are pasted in locally; "the AI test failed with 401/403" on a
  new machine is the placeholder, not a regression.  The real keys and
  the real MCP url stay local-only after every pull.
- Windows/WSL specifics (the `pwd` stub, `--interface wsgi`, the WSL
  venv trap, the silent-403 recipe) live in AGENTS.md's debugging notes.

## 9. Closing the loop

1. Fix → rebuild (`make themes.zjsearch`) → restart instance (WhiteNoise +
   Jinja caches) → regress the touched area in the browser AND the plugin
   matrix via curl.
2. Lint gates (§2) until clean; pylint must hold 10.00/10 (or a
   documented pre-existing baseline for files not touched this round).
3. Land every durable lesson in AGENTS.md / DESIGN.md (§17 governance)
   — the playbook itself gains nothing: new CHECKS fold into §7 as
   vectors, findings stay in commit history.
4. Commit in the house style — Conventional Commits (`feat(zjsearch): …`
   not the upstream bracket style); docs separate from code; never
   commit build output; batch and push ONCE per unit of work.
