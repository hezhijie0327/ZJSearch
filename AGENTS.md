# AGENTS.md

Guidance for AI agents working in this repository.

## Repository

Fork of [SearXNG](https://github.com/searxng/searxng) (metasearch engine, Python/Flask + Jinja2).
Current working branch: `zjsearch`. The purpose of this fork is the custom theme
**zjsearch** — a from-scratch React + TypeScript UI — alongside the upstream
`simple` theme. The theme follows the family design contract **DESIGN.md**
(ZJBlog repository): palette tokens and shared fragments are family-wide,
so token retunes and new fragments update DESIGN.md first and both
implementations together. Python changes are the exception, not the rule: only make them
when the user explicitly asks (e.g. the structured `data` payloads that
special-query answers carry for the theme — see
`searx/result_types/answer.py` and the hash/self-info/time-zone plugins plus
the random/statistics answerers).

**`searx/settings.yml` is upstream-frozen — NEVER edit it on this branch**
(no zjsearch defaults block, no engine tweaks, not even comments): the
theme ships zero settings defaults — configuration lives in the
deployment's own settings file (`client/zjsearch/dev-settings.yml` for the
dev instance) and code-side fallbacks. After a merge/rebase or a stray
edit, force-restore it:
`git checkout origin/master -- searx/settings.yml`.

Licensing: every theme-authored file — client sources and tools,
`searx/templates/zjsearch/`, and our python additions
(`searx/plugins/stock_quote.py`, the `searx/zjsearch/` package, including all
future additions) — carries
`SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0`, matching
`client/zjsearch/package.json`. Upstream files keep their original licenses;
never copy an upstream SPDX header into a theme-authored file.

Key directories:

- `searx/` — SearXNG core (webapp.py, search, engines). Avoid editing unless
  the user directs it; templates under `searx/templates/zjsearch/` are fair game.
- `searx/templates/zjsearch/` — zjsearch theme templates ("data shells").
- `searx/templates/zjsearch/data/macros.html` — the server → client data contract.
- `client/zjsearch/` — React 19 + TS + Vite 8 + Tailwind v4 workspace for zjsearch.
- `client/simple/`, `searx/templates/simple/` — upstream theme, do not refactor.
- `searx/static/themes/simple/` — built assets of the upstream theme (committed
  to git, like upstream). `searx/static/themes/zjsearch/` is **git-ignored**
  (`.gitignore`) — never commit zjsearch build output.
- `utils/lib_sxng_themes.sh`, `utils/lib_sxng_vite.sh` — make targets for themes.

## Commands

```sh
make themes.zjsearch        # pnpm install + vite build -> searx/static/themes/zjsearch
make themes.zjsearch.lint   # biome check + tsc --noEmit (run inside client/zjsearch)
make themes.zjsearch.dev    # vite dev server (HMR), proxies API calls to :8888
make run                    # dev instance on http://127.0.0.1:8888 (granian, reloads ./searx)
pnpm run audit              # Lighthouse gate (inside client/zjsearch): boots its own instance
                            # on :8907 with audit-settings.yml and thresholds per category/page

Package manager: the zjsearch client is a PNPM workspace (`pnpm-lock.yaml`,
`packageManager` field in package.json) — use pnpm for every install/run
inside client/zjsearch; the upstream simple theme stays on npm (its own
lockfile, untouched).
```

- Local instance for theme work (default_theme: zjsearch, all search formats on):
  `SEARXNG_SETTINGS_PATH=$PWD/client/zjsearch/dev-settings.yml ./manage webapp.run`
- First setup: `./manage pyenv.install` (Python venv in `./local/py3`).
- PyPI access goes through the CERNET mirror in this environment —
  append `-i https://mirrors.cernet.edu.cn/pypi/web/simple` to every
  pip install (direct PyPI stalls/times out); the owner's standing
  instruction, keep it in mind for dependency updates too.
- One-time browser install for the built-in page reader (or a system
  Chrome suffices, no download):
  `./local/py3/bin/python -m searx.zjsearch.ai.browser.install`
- No test infrastructure by design: `client/zjsearch` has no vitest/jest setup
  and must not gain `*.test.*` files or test dependencies (user decision).
  Quality gates are `make themes.zjsearch.lint` (biome + tsc) and a successful
  `make themes.zjsearch` build.
- Theme changes require `make themes.zjsearch`; the browser caches assets for 30 s
  (WhiteNoise), reload twice or wait after rebuilding. On Windows also RESTART the
  dev server after every rebuild: the running instance answers the browser's
  conditional requests with 304 against the pre-rebuild ETag (fresh
  non-conditional requests do return the new bytes), so the page keeps executing
  the stale bundle until the server restarts. Template edits need a restart too:
  Jinja caches compiled templates (`debug: false` in `dev-settings.yml`), so
  `searx/templates/zjsearch/**` changes only show after the instance restarts.
- Deployment to another host: `client/zjsearch/make-patch.sh` (PowerShell twin
  `make-patch.ps1`, keep both in sync) exports the whole theme delta vs master —
  client sources, zjsearch templates AND every `searx/` python change except
  `searx/static` — as an ignored `zjsearch-theme.patch` for `git apply` + `pnpm run
  build` on the target. Templates and python must ship together: new templates
  reading `answer.data` against old python only log jinja2 Undefined warnings and
  render raw-text answers.  The reader's render engine needs its browser on the
  target too: run `python -m searx.zjsearch.ai.browser.install` once on the
  host (Docker: the build recipe in the render-contract section below).

## zjsearch architecture (Page-Data pattern)

The server renders **no UI**. Every zjsearch Jinja template is a thin shell that
serializes the render context into `<script id="page-data" type="application/json">`
and boots `zjsearch.min.js`; React renders 100% of the interface.

- Search HTML responses **stream** (`searx/zjsearch/stream.py`, registered by a
  single `install(app)` + before_request hook appended at the end of
  `webapp.py` — the upstream file is otherwise untouched so rebases stay
  conflict-free; the hook chains the whole `searx/zjsearch/` package,
  whose AI endpoints live in `searx/zjsearch/ai/` on the shared agent
  framework (`searx/zjsearch/ai/llm.py` transport + `searx/zjsearch/ai/agent.py`
  loop/ThinkGate): the head + static boot skeleton (`zjsearch/skeleton.html`,
  inside `#app` via base.html's `app_skeleton` block) flush immediately and
  the app **boots right away** into a pending payload (`#boot-data`,
  `page_boot` macro, `pending: true` — `import()` from a classic inline
  script evaluates before the document finishes parsing), so the header and
  search box are interactive while the engines run. The late chunk emits the
  real payload through `#page-data` (`results.html` reads search data only
  through the lazy `streamed` runner — first property access triggers the
  search) plus a notify script; `RouterProvider` consumes the pushed payload
  (`window.__zjsPageData` / `zjs:page-data` event) and never re-fetches.
  SPA navigations stream too: the router's `load()` consumes the response
  body incrementally — the moment the early chunk's boot-data parses it
  applies the pending payload, pushes history and paints the skeleton
  (`extractBootPageData`; the classic search boots exactly like the AI
  takeover instead of waiting for the engines), then the completed
  `#page-data` settles the real data.
  ResultsPage shows skeletons while `data.pending`. Redirects (external
  bangs, instant-redirect) and mid-stream search errors arrive as late
  payloads (`page_redirect` / `page_error` macros → `globals.page:
  "redirect"` / `"error"`, handled at boot in `main.tsx` or by the pending
  consumer in the router; no-JS gets a `<meta http-equiv="refresh">` / error
  text in the noscript block). Keep the `<!--zjs-shell-->` end marker in
  results.html (end of the early chunk) — the server coalesces the shell
  into one chunk at that marker. RSS/JSON/CSV, other themes, and parse
  errors fall through to the upstream view unchanged. `_render_context` in
  the module mirrors `webapp.render`'s context building — re-sync it if
  upstream changes `render`.
- The AI stack (`searx/zjsearch/ai/`) is an EIGHT-package architecture --
  core / browser / llm / agent / prompts / tools / runs / api; the dependency
  direction is strictly downwards (api -> runs -> tools -> agent -> llm ->
  core, with browser beside llm: tools -> browser -> core; prompts is
  material consumed by runs and tools):

  - **core/** — cross-cutting foundations with zero AI semantics: the
    settings-block readers (`config`), the HMAC token gate (`security`),
    the shared text guards (`text`), the ONE SSRF gate (`guard`) and the
    shared NDJSON stream wrapper (`ndjson`) and the ONE document
    converter (`convert` — markitdown behind a single
    `to_markdown(data, extension)` call: the reader's HTML pass,
    `web_reader`'s native PDF reads, and the uploaded attachments
    PDF/Word/PPT/Excel all ride it; RAISE contract, the caller owns the
    degradation).
  - **browser/** — the built-in render engine: ONE Camoufox
    (anti-detect Firefox) in a PERSISTENT context (the cookie store
    survives runs — the login stages build on it), behind the reader's
    rendered-HTML seam; `extract.py` is the RENDERED-PAGE EXTRACTION
    (markitdown over the whole markup + the bs4 title/links pass — the
    engine renders AND extracts; `tools.web_reader.extract` re-exports
    it, tools→browser is the legal edge and `browser.session` must
    never reach up into tools for it).  `config` reads the opt-in `zjsearch.browser`
    block (enabled/mode/profile/adblock/proxy/allow_hosts/budgets +
    `params` -- a 1:1 passthrough into camoufox's launch_options whose
    identity/security keys (os/block_webrtc/humanize/persistent_context/
    user_data_dir/headless/proxy/geoip/args/exclude_addons) are
    code-owned and warn-drop) and
    owns the availability gate (`ready()` — enabled AND the `camoufox`
    package importable, warn-once otherwise); `gate` is the
    REQUEST-level SSRF fence (`context.route("**/*")`: string checks
    via the shared `core.guard` + resolve-and-demand-global-address per
    host + the `allow_hosts` exemption both gates honor; resource-type
    rejection of image/media/font/stylesheet); `engine` lazy-launches
    the persistent context (Camoufox: C++-level fingerprint coherence,
    no CDP — the strongest open position against the login-walled,
    JS-heavy pages the reader exists for; `block_webrtc` closes the one
    un-routable leak; uBlock Origin rides along as a default addon =
    the adblock, `adblock: false` excludes it) and bridges every call
    onto the shared network loop via `run_coroutine_threadsafe` (the
    mcp tool's pattern); `install` is the build-time browser
    downloader (`python -m searx.zjsearch.ai.browser.install` →
    `camoufox fetch`).  The engine RENDERS AND EXTRACTS, nothing more:
    a sign-in wall is the model's judgment on the returned content (the
    web_reader spec says so), not an engine heuristic.  Display tiers
    (`zjsearch.browser.mode`): `headless` default everywhere,
    `virtual` (camoufox Xvfb) for display-less Linux servers,
    `headed` (real window) on desktops — the strongest tier and the
    login stage's interaction carrier.  `session` is the ONE interactive page the
    ``web_browser`` tool drives (a serialized lane beside the reader's
    parallel reads, same cookie store): snapshot refs via injected
    `data-zjs-ref` attributes, click/type/press that return the FRESH
    outline automatically when the action navigated (refs die on
    navigation — the re-snapshot doctrine is automatic; a ref dead to a
    plain re-render fails FAST with the recovery recipe), native text
    extraction over the live DOM (`read` — the reader's pipeline, the
    reader's `max_chars` cap), and the raw input primitives the user's
    Lightbox takeover forwards.  The open lane runs the reader's
    public-url gate itself (`file://` never reaches `context.route`).
    The engine self-heals: a "closed"-flavored failure drops the
    poisoned context and the next action relaunches; a launch failure
    with a locked profile kills the stale holder of THIS profile and
    retries once; an atexit hook closes the browser on clean exits
    (granian workers skip it — the launch retry is the real net).
    Tool packages importing this layer: `tools/web_reader` (one
    backend, no provider) and `tools/web_browser` (the session).
  - **llm/** — the providers. `sdk/` holds ONE factory per SDK family
    (openai with both chat wire shapes + embeddings, anthropic,
    gemini), centrally registered in `sdk.resolve()`; the stream
    queue-bridge (`streaming.LlmStream`), the canonical finish/usage
    contract (`usage`), the prompt-cache shaping (`caching`), the
    tiered structured-output gate (`jsongate`), the embedding SERVICE
    (`embed` — config + server-side call; the browser proxy is a thin
    runtime route; `run_batch` carries a thread-safe cache-aside LRU,
    (model, text) → vector, 256 entries, texts ≤1000 chars — the funnel
    re-embeds the same snippet heads round after round and the repeats
    cost dict lookups, a fully-cached batch reporting `usage: None`),
    the rerank SERVICE (`rerank` — the `zjsearch.rerank` wires: `openai`
    default over the `/rerank` industry convention — Cohere/Jina/
    bigmodel/SiliconFlow; `dashscope` native TextReRank, with the
    compatible-api's `/reranks` reachable via `path: /reranks`; the
    browser's recall proxy is `POST /zjsearch/ai/rerank`, HMAC-gated
    like the embed one), the decision SERVICE (`decision` — SystemOne
    named questions in one forward pass, `POST /zjsearch/ai/decision`
    the browser proxy; the client's helper is `lib/decision.ts`,
    helper-only by design until a consumer lands), the HMAC gate
    (`security`) and the shared route prologue (`http`).  Adding a
    provider = one module under `sdk/`
    with a `factory()` + one line in `resolve()`.
  - **agent/** — the provider-agnostic agent ENGINE. `loop.py` is
    the phase machine (RESEARCH tool turns → WRITE turn; ask_user is a
    first-class turn outcome) that YIELDS WIRE EVENTS; `wire.py` is the
    CLOSED event set (open/think/say/calls/call/close/tasks/sources/
    answer/ask/gallery/related/memory/ctx/tags/usage/settle — a
    misspelled event raises; `ctx` is the storage-only resume
    checkpoint, the CONTINUE contract below); the encode + EVENTS
    alphabet lives in the CORE leaf `core/wire_format.py` (agent.wire
    re-exports — core.ndjson must not import the agent engine to get
    the validation); `executor.py` is the
    tool-executor contract (generator →
    position-aligned `tool_results`); `echo/fences` carry the
    cross-dialect reasoning echo payloads and the
    stream fence splitter (openers precompiled — they matched per
    streamed delta in the hottest loop).  Every delta carries its entry id and
    channel — the client appends, it never reconstructs.
  - **runs/** — the concrete tasks ON the engine. AI Search
    (`runs/search/`: profile/prompts/gates/tools/executor/route;
    four depth modes = budget/decomposition/output-shape differences on
    ONE loop; the executor splits into `registry` ([n]/dedup/gallery
    whitelist), `coverage` (the task card's bidirectional-containment
    tracker), `feed` (the writer's compact [n] block builder), `rank`
    (the web_search RANKING CASCADE: engine order → BM25 via the classic
    page's bm25_reranker tokenizer/RRF → the `zjsearch.rerank` endpoint
    re-scoring the head-20 → embedding diversity pruning the
    near-duplicate syndications — Bocha's cascade MINUS the decision
    stage: the per-candidate 4-noul gate was removed with the
    `sources_gate` feature, ranking stays mechanical and the decision
    model's judgments live where the model invokes them; every stage
    fails open, rerank rides searx's curl_cffi network layer with a
    `zjsearch-rerank` network escape hatch, and its prompt tokens
    accumulate into the settle's `usage.rerank` bucket.  EVERY rerank
    leg is BOUNDED (the hung-gateway lesson: the openai leg built a
    fresh sync client per call with the SDK's ~600s default INSIDE the
    settlement drain — one slow rerank gateway stalled the round's
    whole stream): both legs run on a 4-worker dispatch pool under a
    20s budget, the client is cached per (base, key), and the OTHER
    rerank spenders (the writer's context ordering, the corpus packs,
    the long-read segment trim) fold their tokens into the same bucket.
    THE LONG-READ FEED TRIM: a page read past ~6k chars rebuilds its
    WRITER-FEED block from the rerank-top segments (line-boundary
    ~1200-char segments, 380-char heads, ONE call) within
    `zjsearch.reader.max_chars` (default 8k when unset) — the page's
    relevant middle survives instead of its head; the corpus and the
    client's reading pane keep the FULL text; fail-open to the whole
    text.  The cascade has
    a CROSS-SEARCH MEMORY: diverse_order's embeds ride out of `_ranked`
    keyed by returned position and `build_search_feed`'s dup_gate spends
    them at the mint point — a fresh url whose vector clears
    `features.diversity.cosine` (0.92) against any ALREADY-FED source
    (`reg.fed_vectors`, LRU 64) is the same story syndicated elsewhere:
    no line, no [n], the existing number joins the row's `dupes` — zero
    extra embed calls per search, inert without embeddings) and the
    Searches facade) and the AI OVERVIEW (`runs/overview.py` — the
    FIXED QUICK TASK: one write turn over the client-assembled context,
    zero separate design), plus `embed_route` and the thread page.  The
    shared prompt spine (identity/citations/markdown/voice/answer
    contract) is `prompts/spine.py`; the reader/calculator/past_research/user_memory/mcp
    tool implementations are self-contained packages under `ai/tools/`
  (one package per tool: spec + sanitizer + service; `core/`, `prompts/`,
  `runs/`, `api/` complete the layout — see NEXTGEN-DESIGN.md).

- The wire protocol v2 (NDJSON, one JSON object per line, NEVER ends
  silently): events are TIMELINE OPERATIONS — `{"e":"open","id","kind":
  research|write,"round"}` opens an entry; `think`/`say` deltas carry
  that entry's id; `calls` announces the entry's batch; `call` settles
  ONE call (`{id, call, status, n/chars/result/text/preview/label/
  action/dupes}` — the web_reader settlement rides it too: `chars` +
  `text` carry the reading pane and the reader-cache archive; `dupes`
  rides a RE-search whose hits were all already-numbered (no new
  `sources` emission): the known [n]s let the row still expand to what
  it found; a reader read NEVER emits its own event kind, the closed
  set has no `page` and a stale producer crashes the stream by design).
  The `web_browser` settlement rides the same event: `page`
  {url,title} (where the action left the session), `img` (a VOLATILE
  frame jpeg — the screenshot's shot or the action's mirror frame;
  the client strips it before persisting, a replay keeps the record
  not the bytes), `snapshot`+`n` (the fresh outline + element count
  for open/snapshot/a click-through navigation) and `text`/`chars`
  for the read action (the clean content, archived under `url`).  The
  session's pages JOIN the [n] registry (open mints the identity,
  read/wait_user register the full text — the writer cites what the
  model drove; coverage + entries ride along; about:blank mints
  nothing).  The `browser` mirror event ends the wait window with one
  frame WITHOUT `wait_left`: the countdown and the mobile wait bar
  retire at the window's end, not at the next model action); `tasks` is the task card's AUTHORITATIVE snapshot;
  `learnings` is the FINDINGS LEDGER's authoritative snapshot (the researcher's
  own distillation of what the sources established — same
  snapshot-replace semantics as `tasks`); `sources` the global [n] registry; `answer` deltas are the writer's
  OWN buffer (narration never mixes in); `ask` is the clarify gate AND
  the mid-research ask_user (same schema); `settle` declares the
  terminal state (`status: done|awaiting|error` + finish/usage/model/
  halt).  `decisions` batches the run's DECISION RESULTS (framework gates
  + the model's own judge) once per round — the rail's 决策结果 card
  renders them click-through; every decision speaks the ONE
  NAMED-VERDICT-MAP protocol (`answers: {name: choice|score|noul}` +
  `record_questions: [{name, instructions}]` — the judge tool's entry
  included; bare numbers normalize to noul), so the client's one generic
  renderer covers every present and future purpose with zero
  per-purpose branches, and the in-card question line only appears when
  a row's label fell back to its raw key; `phase` moves the
  规划→检索→撰写 spine (the closed stage set has no `audit` — the
  post-write citation audit was REMOVED: the pre-write evidence check
  already gates what the writer leans on, and a verdict that arrives
  after the answer can only badge, never fix).  After the settle only
  `related`/`memory`/`tags`/`usage` may follow (the late set — the
  follow-up box unlocks on settle, not on them).  A stream that dies
  before its first content event answers 502 (the route PRIMES the
  stream before responding).

- The client mirror is `features/results/aiSearch/useAiSearch.ts`: a
  dumb renderer over the timeline ops — steps mirror entries one-to-one
  (a research entry = its think segment + intent line + call rows), the
  answer buffer is its own field, and `settle` IS the terminal state
  (the old answerFrom/pending/thinkOpen reconstruction heuristics died
  with the old protocol).  The clarify round-trip seeds a `clarify`
  step (the confirmed direction) at the answered run's timeline head;
  the task card is STATUS-ONLY (pending dot / active ping / done check
  / `missed` warning — a subtask that never gathered a source is NOT
  flipped to done), and the research box is OPEN through the research
  phase and FOLDS the moment the writer takes over (`phase: write` —
  the answer/report becomes the focus, the record is one click away;
  an explicit user toggle always wins; the write-turn spinner lines /
  the report document carry the silence).

- The AI run's RIGHT RAIL is one uniform surface (five sections plus
  the browser session's TRANSIENT card pinned FIRST while it lives,
  one section language — icon+title+count header, 13px body rows, cap-
  and-expand): 浏览器实况 (the web_browser mirror — live frames, the
  takeover entry, the mobile wait bar; unmounts at the settle) →
  已确认方向 (the clarify archive) → 调研计划 (task card,
  plan order, never capped) → 研究发现 (findings + 未决缺口: open gaps
  read as colored DOTS, closed ones as checks; facts render inline [n]
  marks as accent chip BUTTONS) → 来源 (source cards) → 决策结果
  (decisions, diagnostics sink last).  Every list reads NEWEST-FIRST and
  caps at 4 rows (`useCapExpand` state owned by the run section so a
  citation click can force it open).  The aside is a FIXED-HEIGHT
  internal scroller on lg (`lg:h-[calc(100vh-3.5rem)] overflow-y-auto`)
  — NOT max-h: flex children never shrink below content, a capped box
  just clips its paint and the bottom sat unreachable under the floating
  composer; the composer itself is confined to the answer column at lg
  (`lg:me-[22rem] xl:me-[26rem]`) so it never covers the rail.  The
  citation-locate chain ([n] chip → expand caps → scroll the rail's own
  scrollTop → `data-ai-flash`) runs on `setTimeout`, NEVER on
  requestAnimationFrame — a starved/jammed compositor (occluded tab, the
  in-app webview, where rAF verifiably never fires) must not break the
  jump (same doctrine as Collapse's 120ms fallback).

- The AI Overview client (`features/results/AiSummary.tsx`) consumes the
  SAME NDJSON timeline (the hook adapts it into the card's raw-text
  rendering contract: `<think>` markers + the tail meta sentinel are
  synthesized client-side from the `think`/`answer`/`settle` events).

- The boot skeleton (`zjsearch/skeleton.html` + the `.zjs-boot` block in
  `src/styles/boot.css`) is a **geometry mirror of the real results page**, not an
  invented loading screen — it only covers the JS-boot window (server flush →
  module executes) and must share every layout decision with `ResultsPage`:
  brand hidden <30rem, container `px-4 sm:px-6`, query pill with `shadow-card`
  and max-widths 42/48/56rem (base/xl/2xl), ghost HeaderActions circles, ghost
  category-tab (first tab amber-underlined) + filter rows, card bars in the
  exact `ResultSkeleton` rhythm (url / mt-1 title / mt-1.5 snippet ×2 / mt-2
  engines pill), right rail reserved width-only (20rem at lg, 24rem at xl).
  The skeleton has TWO modes, keyed on the render context's `ai_mode`:
  the CLASSIC shape above, and the AI-takeover shape (`ai=1`) — the run
  title in real query text at text-3xl, the OPEN research box (process-row
  ghosts + bordered box, `.zjs-boot-ai-*`), and the sources rail
  (`lg:w-72 xl:w-80`, two grid columns below lg) — the takeover never
  renders tabs/filters/card lists, so its skeleton never does either, and
  the React pending leg (`AiBootGhost` in ResultsPage, page-private)
  mirrors the same shape.  The AI run starts from the BOOT payload (the
  start gate ignores `pending` — the server skipped the classic fan-out),
  so the research begins during the boot round-trip.  The three-way swap
  static skeleton → React pending → real results must never shift layout:
  change `skeleton.html`, the `.zjs-boot` CSS and the mirroring client
  pieces together in one change, and re-verify at mobile / lg / xl
  widths (a no-JS preview of the streamed early chunk up to
  `<!--zjs-shell-->` with the scripts stripped — stylesheet relinked to a
  live instance — keeps the skeleton on screen).
- SKELETON COVERAGE IS UNIVERSAL: every surface a user can reach renders
  its OWN real shape while it loads — never a blank pane, a lone spinner,
  or (worst) a dishonest empty state.  The inventory: classic results
  (static skeleton + `ResultSkeleton`), AI takeover (the ai_mode skeleton
  branch + `AiBootGhost`), lazy page chunks (`PageFallback` in app.tsx —
  the family page scaffold, since Shell itself is inside the chunk),
  overlay panels (the panel-chrome `PanelSkeleton`), the knowledge page's
  graph/list skeletons (features/knowledge), and the AI thread page's
  async resume (`ThreadGhost`).  A new surface ships
  with its ghost in the same change; a load state that renders an empty
  message while data is still in flight is a bug.

- The data contract lives in `searx/templates/zjsearch/data/macros.html` and is
  mirrored by TS types in `client/zjsearch/src/lib/types.ts`. **Keep both in sync.**
- Macros apply server filters during serialization: `image_proxify`, `favicon_url`,
  `get_pretty_url`, query highlighting (`title_html`/`content_html` are escaped
  HTML — render with `dangerouslySetInnerHTML`).
- Client-side navigation (`src/lib/router.tsx`) fetches the same URLs and extracts
  the embedded page-data JSON from the HTML response; on network failure it falls
  back to a full page load. Search parameter encode/decode + the shared page
  fetch live in `src/lib/searchParams.ts` (GET URL, POST form body and the
  infinite-scroll pager all derive from one entry list).
- Client settings come from the base64 `client_settings` attribute on the module
  script tag (`get_client_settings()` in webapp.py). Note: its `theme_static_path`
  is hardcoded to the simple theme; zjsearch resolves its own assets from the
  theme root and does not use that field.
- i18n is theme-owned: `client/zjsearch/src/lib/i18n.ts` is the runtime (context,
  `useT()`, locale fallback) and `src/lib/i18n/` holds one catalog file per
  locale — `en.ts` is the source and defines the `StringKey` union, `zh-CN.ts`
  must implement it fully; every other locale falls back to English.  The
  AI reply language follows the SAME two-language rule server-side
  (`language_directive` in `searx/zjsearch/ai/prompts.py` mirrors
  `themeLocaleTag`): zh* → Simplified Chinese, everything else (incl.
  zh-Hant) → English.  Add new
  keys to `en.ts` first (then the other catalogs), render via `useT()` /
  `t("key")` — unknown keys are compile errors. `t(key, params)` interpolates
  `{name}` placeholders (the DESIGN.md §10 family API). Adding a language = one new
  catalog file + one entry in `CATALOGS` / `themeLocaleTag()`.
- Knowledge/About/Stats/Preferences open as slide-in drawers
  (`src/features/overlay/OverlayProvider.tsx`); the panel fetches page-data and
  renders the same page components with `embedded`/`hideTopNav` props. Which
  payload opens as which page is injected by `app.tsx` (`renderPage`) — the
  overlay module never imports pages (keeps lib→page cycles impossible).
  Internal links inside a panel are browsed within the panel (click-capture in
  OverlayProvider.tsx). `features/overlay` is the one sanctioned cross-cutting
  capability: its `useOverlay()` context may be consumed from `components/`
  (Shell header actions, footer) and other features (DebugPanels) — a context
  provider consumed via hooks is the accepted decoupling; do not thread
  `openOverlay` callbacks through props instead.

## Client code organization (keep it this way)

Four layers, dependencies point strictly downwards; imports use the `@/`
alias (`tsconfig.paths` + vite `resolve.alias`), never deep relative paths:

- `src/lib/` — foundations: `types.ts` (server contract), `pageData.ts`,
  `searchParams.ts`, `router.tsx`, `i18n/`, `categories.ts`, `cookies.ts`,
  `settings.ts`, `theme.ts`, `format.ts`, `link.ts`, `motion.ts`.
  Never imports from `components/` / `features/` / `pages/`.
- `src/components/` — UI shared across pages (Shell, Link, SearchBox,
  SearchControls, Dropdown, CopyButton, HelpModal, BackToTop, Brand,
  CategoryIcon).
- `src/features/<domain>/` — cohesive feature modules with colocated views,
  pure logic and hooks: `overlay/` (drawer, panels injected by app.tsx),
  `results/` (layout.ts detection, ResultsView, CategoryBlocks, CardList,
  ResultRow, cards/, answers/, image/, grids, infobox/debug/suggestions,
  aiOverview.ts — the AI Overview contract: context assembly, stream
  splitting, citation meta), `hotkeys.ts`, `calculator.ts`.
  PLACEMENT DOCTRINE (ZJBlog DESIGN.md §12): `components/` is cross-page
  ONLY — a component with a single page consumer folds into that page's
  file (AiModeSwitch lives in IndexPage.tsx); `features/<domain>/` owns
  real domains; lib modules are lowercase topics; named exports only,
  zero `export default`; no barrel files.  Legacy-compat shapes are
  deleted with their era, not carried: the stored-thread `spawn_subtask`
  tool name and the `"plan"` step kind are gone (old threads degrade to
  web_search rows / silently drop those steps).
- `src/pages/` — thin route composition roots (state + event handlers +
  layout wiring); page-private pieces sit next to the page
  (`preferences/` → PreferencesPage + `usePreferencesForm` + `tabs/`).

Naming: components PascalCase (one primary export per file), hooks
`useXxx.ts`, pure logic camelCase `.ts`, locale catalogs named by their
BCP-47 tag. Export only what other modules need. Full rationale and the
"add a language" recipe: `client/zjsearch/README.rst`.

## Conventions & gotchas

- Jinja macros need `with context` imports to see render variables; Jinja macro
  output is Markup (never escaped), and `|tojson` is the only safe way to embed
  dynamic values — hand-built JSON must place `, ` separators **between** items,
  never before a closing brace.
- **Static-root publishing contract**: the served bundle URLs live at the
  static root (`/static/zjsearch.min.js`) because `webapp.custom_url_for`
  only maps filenames that exist in `searx/static/`. `tools/assets.ts`
  closeBundle therefore publishes EVERY root-level `zjsearch*.min.{js,css}`
  artifact plus `assets/` (KaTeX fonts) there. Vite emits extra root-level
  CSS chunks (zjsearch2/3.min.css) whose preload helpers resolve them as
  SIBLINGS of the JS bundles — a missing one 404s and main.tsx's
  `await import(ResultsPage)` never settles, so the streamed search page
  boots into the skeleton FOREVER (homepage SPA navigation still works,
  which misdirects the debugging; see Debugging notes for the recipe).
- The streamed search page fails SAFE: a late-chunk serialization error
  (a malformed result field reaching a macro) makes `searx.zjsearch.stream`
  emit a recovery `page_error` payload (a leading `</script>` closes a
  script the failure may have left open; the client prefers the LAST
  parseable `#page-data`, see `parseEmbeddedPageData`). Never let a
  streamed response end silently after the shell — the client would hang
  pending forever.
- **`#page-data` payloads are SINGLE-USE** and this is load-bearing for
  SPA searches: `main.tsx` removes the document's `#page-data` when the
  boot payload was consumed directly (not pending), and the router's
  pending-consumer removes every element it has read.  Why: the element
  lives in the ORIGINAL document forever during SPA navigation — when a
  new search's pending boot payload applies, the consumer's "late chunk
  may already sit in the DOM" check would find the STALE element and
  re-apply the OLD page over the fresh navigation.  The symptom (before
  this contract existed) was exactly "SPA search looks broken": a search
  from the homepage flipped the view back to the homepage for the whole
  engine round (results popped in late with no skeleton), a re-search
  from the results page kept showing the previous query's results, and
  back/forward restored mismatched content.  The same router path also
  routes fetched `page_redirect` / `page_error` payloads like the boot
  path does (the boot path always did; `load()` gained it in the same
  fix).
- Theme style light/dark uses the `simple_style` cookie; `black` is OLED black
  (html gets both `dark` and `black` classes). Auto = no cookie + system setting.
  The `dark`/`black` classes are rendered SERVER-SIDE into the `<html>` tag
  (`base.html` reads the preference), so the streamed boot skeleton paints in
  the user's palette with zero JavaScript — optimizers that defer inline
  scripts (e.g. Cloudflare Rocket Loader) must not flash a light skeleton;
  all zjsearch inline scripts carry `data-cfasync="false"` for the same
  reason. The inline head script in `base.html` (also exempted) syncs auto
  mode and live toggles and is mirrored by `applyThemeStyle()` in
  `client/zjsearch/src/lib/theme.ts` — keep both in sync.
- `POST /preferences` form semantics (upstream `Preferences.parse_form`):
  absent booleans are false; absent `category_*` clears the category
  selection; **`engine_<name>__<category>` and `plugin_<id>` are REVERSED —
  a posted key marks that engine/plugin as *disabled***, and every omitted
  key is re-enabled (a save must always post the complete disabled set);
  other absent key/value settings are left unchanged. The preferences UI
  auto-saves (debounced) with these semantics — no save button, and the
  initial mount must NOT post (it would flip engines/plugins).  Saves go
  through `fetchText` (`lib/http.ts`), so a failed POST shows the red
  "save failed" toast instead of a false 「已保存」, and the next change
  re-fires the debounced save.
- Results hotkeys (default / vim, see `src/features/hotkeys.ts`) must not fire
  while focus is in text inputs; hash-only changes (`#image-viewer`) are ignored
  by the router's popstate handler.
- The search box autocomplete follows the Google interaction contract
  (SearchBox): ArrowDown/Up walk the suggestions PLUS one extra slot — the
  typed query itself — so navigating past the ends restores what the user
  typed; a selected suggestion is written INTO the input with its untyped
  suffix selected (continued typing replaces it), Enter submits the
  displayed text, Escape restores the typed query and closes. The
  debounced fetch keys on the typed baseline, so navigation never
  re-fetches, and `event.nativeEvent.isComposing` short-circuits the whole
  handler — IME composition (pinyin candidates) owns Enter and the arrows.
  While a suggestion is selected, a ghost mirror layer renders the typed
  prefix in solid ink and the completion in ink-3 (the input's own text
  goes transparent while it shows; the caret stays via caret-ink) — native
  inputs cannot colour text spans, hence the overlay; the selection range
  is still set with a transparent selection background so continued typing
  replaces the suffix.  The prefix check is CASE-INSENSITIVE (the ghost's
  solid span takes the suggestion's own casing) and `selection:bg-transparent`
  sits on the input UNCONDITIONALLY — the site's global accent ::selection
  would otherwise paint the fallback path (a suggestion that does not extend
  the typed prefix) with a tan block.
- Bangs: category bangs (`!movies`), engine bangs (`!imdb`, one per engine
  `shortcut`) and external DDG bangs (`!!w`, redirect off-site — the SPA
  fetch fails cross-origin and falls back to a full page load, which is the
  desired behaviour).  Engine bangs run with selected category `"none"`, so
  `detectResultsLayout()` (features/results/layout.ts) derives the
  presentation category from the results' common category (bangCategory) —
  that is how `!imdb` lands on the movies PosterGrid.  Movies =
  tmdb/imdb/moviepilot/rottentomatoes/senscritique; tmdb is disabled
  upstream, dev-settings.yml enables it.  Dictionary bangs (`!dictionaries`
  / `!define`) render DictionaryCard word entries; wordnik definitions
  additionally arrive as a translations answer.
- POST method preference (`globals.method === "POST"`): the app drops SPA
  navigation entirely and mirrors the upstream form flow — searches are real
  hidden-form POST submissions (`router.search()`), other links become
  native `location.assign`, and infinite-scroll page fetches POST the
  params in the body (via `fetchSearchPage` in `src/lib/searchParams.ts`).
  Reason: the POST results URL is
  a query-less `/search`, so no SPA popstate could ever restore a search
  page from it; the browser's own history + bfcache takes over.  The
  sidebar Search-URL box (POST only) shows the shareable URL rebuilt from
  the page payload via `buildSearchUrl`.
- Respect `prefers-reduced-motion`: the `styles/behaviors.css` guard covers CSS
  transitions/animations, but it cannot reach JS-initiated scrolling — and
  native `behavior: "smooth"` is NOT a safe primitive anyway: webviews built
  with smooth scrolling disabled (embedded browsers, some in-app engines)
  SILENTLY DROP every smooth scroll (`scrollTo`, `scrollIntoView`, CSS
  `scroll-behavior` alike no-op — the scroll never happens at all; this
  broke citation jumps, hotkeys and BackToTop in the ZCode in-app browser).
  Every programmatic scroll goes through `animateScroll` /
  `scrollIntoViewAnimated` (`src/lib/motion.ts`), which tween instant
  scrolls per frame (works everywhere, one easing/duration across browsers,
  cancels on user wheel/touch/key input, instant under reduced motion).
  Never call `scrollIntoView`/`scrollTo` with `behavior: "smooth"` in theme
  code (the module also exports `reducedMotion()` for durations).
  RTL uses Tailwind logical properties (`ps-`, `me-`, `start-`, `end-`)
  against a single stylesheet; `translate-x` is NOT logical — pair it with
  the `rtl:` variant when direction matters (see the Switch knob).
- Text/ink tiers are contrast-audited: every ink token must keep ≥4.5:1
  against every surface it sits on in its palette (worst case is usually
  `surface-2`); do not lighten `ink-3` or use `accent-strong` as text on
  light surfaces (it is a fill/border accent, light-mode text accent is
  `accent` — `#8c6800`, AA for the 12-13px chips it colours). Text on an
  `accent-strong` fill is ALWAYS `accent-contrast`, including the
  hover states of dark media chips (`hover:bg-accent-strong
  hover:text-accent-contrast`) — `hover:text-ink` breaks in dark/black.
- Modal dialogs (overlay drawer, image lightbox, help modal) mount through
  `useDialogFocus` (`src/lib/dialogFocus.ts`): focus moves to the element
  marked `data-dialog-close` on open, Tab is trapped inside, focus returns
  to the trigger on close. A dialog rendered by an always-mounted provider
  (the overlay drawer) must pass its open flag as the hook's `active`
  argument — the ref alone never re-runs the effect. Escape stays with each
  dialog's own handler.
- All HTTP calls go through `lib/http.ts` (`fetchText`/`fetchJson` with the
  uniform `HTTP <status>` error); don't hand-roll `resp.ok` guards.
  Recurring Tailwind mega-strings live as constants in `lib/styles.ts`
  (`SCROLLBAR_NONE`, `SWIPE_ROW`, `META_ROW`, `CHIP`, `ICON_BTN`) — import,
  don't re-type. One-shot floating feedback (copy/save confirmations) goes
  through `flashToast()` in `lib/toast.ts` (tone: accent/ok/danger) — never
  render such confirmations in flow (layout shift); from React use
  `useCopyToast()` (`lib/clipboard.ts`) which pairs the clipboard write with
  the green 「已复制」 toast.
- Jinja inline-`if` output is AUTOESCAPED: `{{ ' class="centered"' if cond }}`
  emitted `class=&#34;centered&#34;` (a broken literal-quote class token that
  silently disabled centered alignment). Conditional HTML fragments in
  templates must use `{% if %}` blocks, never inline-`if` string literals.
- Plain-str python functions interpolated inside the data macros are AUTOESCAPED (macros.html is a .html template) — `image_proxify(url)` emitted `&amp;h=` into the JSON page-data, nothing decodes that back, and EVERY proxied image 400'd (`amp;h` is not the signature param). Macro calls themselves are immune (their output is Markup) and `X|tojson` filters the raw value before any escaping — the dangerous shape is a bare `{{ plain_str_fn() }}` inside a macro. Anything URL-shaped or structured that enters the JSON payload from a plain-str function needs `|safe` (tojson handles the script-tag escaping; `noscript.html`/`rss.xsl` are genuine HTML/XML contexts where autoescaping stays correct).
- Text result cards keep fixed height slots so every card in a list is the
  same height: pretty URL 1 line, title `line-clamp-1`, snippet capped at
  `line-clamp-2` (never reserve empty lines below short snippets — the gap
  reads as broken spacing on pages with 1-line content, e.g. IT), engines
  row capped at 3 pills + "+N". Cards grow only for real content extras
  (publishedDate meta row, thumbnails, embedded media) — do not reserve
  empty slots for those. The snippet is the one sanctioned user-driven
  growth: `Snippet` (cardParts) renders the 2-line clamp with the ellipsis,
  gates a 12px expand toggle on ACTUAL overflow (measured, re-checked on
  reflow), and animates the height (max-height pin -> ease -> cap lifted /
  re-clamped at the end, ClampReveal mechanics) — so the full text the AI
  overview sees is reachable in the UI too. Grid tiles keep their plain
  clamps (fixed tile anatomy). All text cards share the margin language
  `mt-1` (title, meta) / `mt-1.5` (snippet, tags) / `mt-2` (engines row);
  PackageCard follows it too — version/license live in the meta row, no
  redundant package_name, secondary links fold into the engines row as
  muted chips (`EnginesLine`'s `leading` slot).
- The empty `searx/templates/<name>/` directory alone registers a theme in the
  UI — never leave a half-created theme dir behind.
- Stacking contexts: entrance animations (`animate-fade-up`, fill-mode `both`)
  leave a residual `transform` on their wrapper, which makes every animated
  sibling a stacking context — a `z-30` dropdown inside one of them loses
  against DOM-later siblings (this once let the category tabs and the hotkeys
  hint paint over the homepage autocomplete). Wrappers that contain an overlay
  (autocomplete dropdown, menus) need an explicit raised level such as
  `relative z-10`.
- Async results must not outlive their query: every fetch that outlives a
  render cycle captures `href` at start and bails in `.then`/`.catch` when
  the router moved on (the infinite-scroll pager once pasted query-A page 2
  into query B's cleared list). Map boot-up checks a `cancelled` flag after
  every `await` (a close during `import("ol/…")` leaked an undisposed map).
- Lists whose entries swap wholesale between queries (answers, infoboxes)
  key by CONTENT identity (`answerKey` in Answers.tsx, `infobox.title`) —
  index keys let stateful children inherit a previous query's state (a
  weather card kept its expanded-sources state across a new search).
- Empty/final states share one composition language — icon in an
  `accent-soft` disc (`size-14` + `size-7` glyph), heading, one muted
  line, ONE pill action (`NoResults`, the 404 screen). No bare-text
  bullet lists, no dead instructions (a 「use the previous-page button」
  sentence became a real pill).
- The image lightbox zoom is keyboard-reachable: `+`/`-` step the wheel
  zoom (same 0.5×–5× window), `0` resets; the percentage readout joins the
  top-bar meta row while zoomed. The top bar hosts the image details
  (resolution / type / filesize / source / format links) as a permanent
  inline row that wraps on narrow viewports — same data at every width, no
  toggle, no breakpoint; keep that symmetry.
- Stock charts share one projection (`makeScale` in Stock.tsx): overlays
  (prev-close dashed line, crosshair, hover dot, price tag) and the SVG
  polylines must agree on the vertical mapping — extra values (previous
  close) join the domain so reference lines never disagree with the line
  they reference.

## Debugging notes (theme QA)

- After `make themes.zjsearch` the browser answers conditional requests
  with a cached asset for up to 30 s (WhiteNoise) and may keep executing
  the stale bundle — wait the 30 s out or reload twice before concluding a
  change "didn't work". Template edits additionally need an instance
  restart (Jinja caches compiled templates).
- A CSS transition FROZEN at its start value (computed
  `grid-template-rows: 0px` while the inline style says `1fr`, a
  `CSSTransition` stuck `playState: "running"`) is the JAM, not a theme
  bug: the occluded/jammed pane never renders the transition's first
  frame.  Trust the DOM truth (`aria-expanded`, the inline style, the
  content being present) — Collapse's 120 ms timeout fallback has
  already committed the end state; only the paint is missing.  Close and
  reopen the pane and re-measure (a jammed probe validates this before
  any "broken animation" conclusion).
- In-app-browser screenshots can serve a STALE compositor frame: a page
  whose DOM says "visible, opacity 1" may still capture blank right after
  load/animation. Nudge the compositor (`scrollBy(0, 1)`) and wait before
  capturing, and when captures start timing out repeatedly the backend is
  jammed — close and reopen the tab, don't retry into the jam.
- To find a phantom "still loading" state, ask the page, not the eye:
  `document.getAnimations().filter(a => a.playState === "running")` names
  the exact spinner still running (this caught the infinite-scroll
  sentinel spinning while idle). Conversely, a permanently-running CSS
  animation can also stall screenshot pipelines that wait for paint idle.
- The in-app browser can FREEZE its rendering pipeline while the page's JS
  keeps running: `requestAnimationFrame` never fires, transitions don't
  run (they snap), timers clamp to ~1s, screenshots serve stale frames.
  Symptoms look exactly like product bugs — rAF-driven animations "missing"
  (the user-reported 「0 结果消息无动画」 was this), Collapse panels stuck at
  0fr, mid-transition screenshots. Probe before concluding:
  `await new Promise(r => requestAnimationFrame(r))` with a 1.5s timeout —
  if rAF loses, recover with a fresh tab and re-measure; measurements taken
  inside a jam are void (this audit's first transition test "proved" a
  healthy animation broken).
- A search page stuck on the static boot skeleton (React never mounted,
  no reload loop) means the results chunk's dynamic import never settled —
  check `performance.getEntriesByType("resource")` for a 404 on a
  `zjsearch*.min.css` / chunk asset (see the static-root publishing
  contract above) BEFORE touching animation code. A visible-but-stuck
  toggle/panel after mount is a different bug class.

## zjsearch UI design system

A consistent control/typography language is enforced across all pages —
reuse these tokens instead of inventing sizes. The string catalog lives in
`client/zjsearch/src/lib/i18n/`; strings are looked up by key with
`t("key")`.

Type scale — one size per text role:

- 12px `text-xs`: meta/captions — engine chips, pretty URLs, answers meta,
  mono chrome (URL preview, license `<pre>`, document overlays), footer.
- 13px `text-[13px]`: interactive controls & compact descriptions — category
  tabs, dropdown triggers AND option rows, pills, suggestions (autocomplete
  and results-strip alike), help dialog copy, preference section tabs,
  pagination. If it clicks, it is 13px.
- 14px `text-sm`: body text (card snippets — capped so widescreen list lines
  stay readable: side-thumbnail cards cap the whole text block at `max-w-2xl`
  and pin the thumbnail to the row end with `ms-auto`; text-only cards cap the
  snippet itself at `max-w-prose`), infobox abstract, settings row
  titles.
- 16px `text-base`: result titles (list/news/product/video grids all share
  the `Title`/h3 token) and ALL search inputs (hero included).
- 20px `text-xl`: infobox title (serif — the family editorial track applied to
  the one knowledge heading); 24px `text-2xl`: page headings; section
  headings in between are `text-base`/`text-lg` `font-semibold`.
- Brand marks: hero `text-6xl/7xl font-black`, header/results wordmark
  `text-2xl font-semibold`, both `font-serif` (registered DESIGN.md §4
  variant: result titles and UI section headings stay sans for scan
  density). The wordmark period is a geometric gold dot (`bg-accent-strong`
  fill, aria-hidden — echoes the favicon's brand period, §2.2) — INERT on
  every surface including the hero (the hover-reveal "Powered by SearXNG"
  flourish was removed as noise; About lives in the header actions).
- Thumbnail corner badges / floating overlay chips: 11px `font-medium`
  (badge tier, the sanctioned sub-12px exception along with the mini
  player's tabular clock and the weather SVG chart labels).
- Answer values are tiered: `text-4xl` calculator/stat heroes, `text-xl`
  time/translation heroes, `text-sm font-mono` copyable values (hash/ip) —
  always with `break-all` on unbreakable payloads.

Weights: `font-extrabold` brand only, `font-semibold` headings,
`font-medium` emphasis/selected states; body stays regular.

THINK vs CONTENT (the AI timeline's one visual rule): machine-produced
material — reasoning streams, web_reader reading panes, MCP payloads,
raw-args debug — sits on the boxed machine-voice ground (`READ_PANE` /
`HOVER_CHIP` in `lib/styles.ts`: surface-2/50 rounded, 12px ink-3/ink-2);
the ANSWER sits on the plain ground at 14px `text-ink`.  A web_reader row
folds to ONE LINE like a search row — the reading pane (scroll-capped in
`CallContent`) opens on click beside the debug panes; an always-open pane
shoved the whole timeline around (reversed doctrine: the fold came back).
EVERY tool row splits RENDERED result from DEBUG material: the chevron
reveals the rendered result (result cards / reading pane / plan items /
ask spec / recorded facts), the BUG chip beside it reveals the debug
panes (raw arguments + the model's receipt — the timing lives ON the row
in a fixed-width column so all rows align); every fold plays through
`Collapse`, and the rail's cap-and-expand lists reveal their older tail
inside one too (the +N/收起 is a height animation, not a swap).
In-card action ghosts are the 28px/14px `CHIP_BTN` tier (`ICON_BTN`'s
36px stays chrome-level); hover-revealed corner chips must ALSO reveal
on `focus-within` (keyboard users tab to invisible controls otherwise).
Every modal carries the full dialog contract (`useDialogFocus` +
`aria-modal` + Escape semantics + a fading scrim) — the clarify card
blocks the run and learned this the hard way.

Motion & disclosure:

- JS-toggled collapse/expand goes through `components/Collapse.tsx`
  (grid-template-rows 0fr→1fr transition, smooth in both directions,
  reduced-motion handled by the global guard). Folded content is
  `inert` + `aria-hidden`. Pass `unmountAfterHide` when folded children
  must not stay alive (iframes keep playing, hotkey targets poll the DOM —
  media embeds and category blocks unmount; the cheap meta strips stay
  mounted). An AUTO-OPENED disclosure (the zero-results engines panel)
  passes `animateOnMount` so the reveal PLAYS — without it an initially-
  open Collapse paints at 1fr and pops in fully expanded (the user reads
  this as "no animation"). Apply the spacing margin CONDITIONALLY on the
  Collapse wrapper
  (`open ? "mt-2" : ""`) — a static margin under a folded panel reads as a
  stray gap. Triggers keep `aria-expanded` + the rotating chevron. The
  open path mounts at 0fr and expands on the next frames with a 120 ms
  timeout FALLBACK — a starved rAF (occluded tab, jammed compositor)
  must never leave a panel at 0fr forever. Native
  `<details>` disclosures get the same height animation via the
  `::details-content` progressive enhancement in `styles/behaviors.css` (unsupported
  browsers keep the chevron rotation alone).
- Every interactive element has a complete hover/press transition — when
  adding a chip/pill, take the shared constants (below) instead of
  hand-rolling, or the transition language drifts (this exact drift was
  audited and fixed once across Weather/MapCard/PaperCard).
- Global state flips must not snap: the center_alignment toggle morphs
  `--results-max` (max-width transition on `.zjs-results-main` /
  `.zjs-results-header-row`), and the theme color tokens are registered
  `@property <color>` custom properties with one transition on `<html>` —
  a `.dark`/`.black` flip cross-fades the whole palette through the
  variables themselves. Do NOT add per-element / universal-selector
  transitions for global toggles: the per-frame full-document recalc
  stutters in patches on heavy pages (tried, removed). During a real
  palette flip `applyThemeStyle` also opens the ~350ms
  `html.zjs-palette-anim` stand-down window — elements with their own
  `transition-colors` (chips, pills, switches) would otherwise chase the
  interpolating tokens on their private 150ms timer and visibly lag the
  page, so their transitions stand down while it runs. Browsers without
  `@property` snap instantly; the reduced-motion guard collapses both.
  Keep new global toggles in this language.
- Content appears with a fade, never pops: lazy thumbnails/images fade in
  on load (`TileThumb` / `Thumb` carry the opacity toggle internally, the
  image masonry does the same) while `eager` first-four images paint
  immediately (LCP); list rows beyond the first 12 (infinite-scroll
  appends) run `animate-fade-in`, and the preferences tab panel fades on
  every tab switch (`key={tab}` remount). Dismissals play an exit animation
  through `useExitPresence` (`src/lib/useExitPresence.ts`): the surface
  stays mounted for its `-out` animation with `closing` → `inert` +
  short-circuited handlers (the lightbox must not take a second
  `history.back()` mid-fade); the unmount timer is the doc-mandated timeout
  fallback; reduced motion unmounts instantly; dialogs pass `active={!closing}`
  to `useDialogFocus` so focus returns at close-initiation, not at unmount.
  Content swaps (tab panels, pagination) are covered by the enter animation.

Shared style & logic tokens (import, never re-type):

- `components/SettingParts.tsx` is the PANEL FURNITURE shared by every
  slide-in panel (preferences, knowledge, stats): `Card` (rounded-2xl
  divide-y sectioned card), `SectionLabel` (the gray band header inside a
  Card) and `SettingRow`/`IconTile` (icon-square + title/description +
  right control) -- tune panel styling THERE, never per page.
- `lib/styles.ts`: `CHIP` (transition-colors baked in), `MONO_CHIP`,
  `CHIP_HOVER` (`hover:text-ink`), `CODE_CHIP` (square code token),
  `SEGMENT` / `SEGMENT_ACTIVE` / `SEGMENT_IDLE` (segmented-control rows:
  preference tabs, info tabs, theme-style picker), plus the existing
  `ICON_BTN`, `META_ROW`, `SWIPE_ROW`, `TILE_BADGE`, `DISABLED`.
- `lib/format.ts`: `round1` (one-decimal display tier for times/scores),
  `cap` (first-letter capitalisation), `formatScore`, `formatDate`,
  `formatClock`. `lib/i18n.ts`: `languageOptions(locales, t, suffix?)` —
  the one builder for every language picker (results filter row +
  preferences general tab).
- `components/Meter.tsx` is the only proportion bar (stats page, engine
  timing strips, engine tables); `components/CopyButton.tsx` +
  `ClickToCopy` + `useCopyToast` remain the only copy paths.
- Cap-and-expand chip rows ("show 3 + N") pair `lib/useCapExpand.ts` (owns
  the visibility state machine) with `components/CapChip.tsx` (renders the
  one "+N ⇄ ‹ show less" chip, `aria-expanded` included) — EnginesLine,
  paper/package tags and weather sources all consume both; never hand-type
  the toggle again (the four hand-rolled copies had already drifted, one
  losing its `aria-expanded`).
- Clamp-and-reveal (long content shown as a fixed preview + gradient +
  full-width expand pill: infobox abstract, AI overview) goes through
  `components/ClampReveal.tsx` — it owns the ResizeObserver measurement
  (+1 sub-pixel guard), the max-height dance (expand animates to the
  measured height then lifts the cap so late growth never sits under a
  stale one; collapse re-applies the cap before easing down), the gradient
  scrim and the toggle. Pass `active={false}` while content streams.
- Thumbnail load state is `useGraceThumb` (tileParts.tsx): 12s hung-request
  grace, shared by grid tiles and the image masonry; the first four cells
  of a page are `eager` + fetchPriority high (page-global index via
  `indexOffset`).
- Tile anatomy extras live in `features/results/tileParts.tsx`:
  `TileCloseAction` (the 28px dark close chip over playing media — every
  grid/card uses it, never re-type the button), `TileMeta` +
  `TileMetaAuthor/Views/Date` (the fixed-height meta footer row). The
  compact `EnginesLine` in tiles never overflows the tile: the lead engine
  chip truncates, and the cached chip renders icon-only there.

Controls:

- Circular ghost icon buttons: 36px (`size-9`) with 18px icons
  (`size-4.5` — the canonical 18px token; don't use `size-[18px]`) —
  header actions, drawer/help closes, search clear. The search submit is
  the accent-filled circle, also 36px. BackToTop is the one floating
  exception (40px), icon-chip closes over media sit at 28px with 14px
  icons.
- Tab-style buttons (category tabs, filter triggers, preference section
  tabs): `px-4 py-2 text-[13px]`, leading icon 14px.
- Pills/chips (choices, enable/disable, suggestions): `px-3 py-1.5
  text-[13px]` rounded-full; tiny meta chips use the `CHIP` constant
  (`px-2 py-0.5 min-h-6` — the 24px floor keeps Lighthouse's target-size
  audit green), mono tokens (IPs, digests, language pairs) the
  `MONO_CHIP` variant; category chips carry `CategoryIcon`; selection =
  `border-accent-strong bg-accent-soft font-medium text-accent`.  Two
  sanctioned 12px-interactive exceptions stay: the results meta line
  toggles and the `EnginesLine` `+N` / `cached` chips — they live inside
  12px meta rows and would break the row rhythm at 13px (both still carry
  the 24px `min-h-6` box).
- Boxed form selects (preferences): `h-9 text-[13px]`.
- Category selection uses the tab language (icon + label, selected =
  accent text + amber underline) everywhere — results-page tabs, hero
  grid, preferences default-categories and engine tabs all render the
  shared `components/CategoryTab.tsx` (results rows wrap it in
  `CategoryTabs`).  Other choices (options, toggles) keep the bordered
  chip language.
- Icon size tiers: 18px `size-4.5` round-button icons, 14px `size-3.5`
  tab/pill leading icons and disclosure chevrons, 12px `size-3` meta-row
  icons, 20px `size-5` large round buttons; same concept = same icon
  (Search submits, X dismisses, Check confirms copy, ExternalLink for
  outbound links, ChevronDown discloses — `<details>` summaries use the
  `group-open:rotate-180` chevron, never the browser marker).

Instant answers (`features/results/answers/`, one file per kind) are tiered
(the split lives in `Answers.tsx` — `isCarded()`):

- Answers without a source url (calculator, time, ip, hash, random, stats,
  tor) render uncarded in the results column — gray lead-in expression,
  value at 4xl, `border-b` divider (Google-style).  The client-side
  calculator (`CalculatorAnswer`) follows the same language.
- Rich widgets keep the accent card: weather, translations AND the
  interactive unit/currency converter — `UnitConverterAnswer` renders its
  own single accent card (never nest it inside another), with borderless
  `bg-surface` panels and bare (unboxed) unit dropdowns inside.
- The sidebar hosts knowledge (infobox) and diagnostics only — never
  answers.

Category-specific result presentations (single-category intent pages, see
`detectResultsLayout` in `features/results/layout.ts`, rendered by
`features/results/ResultsView.tsx`) — each category gets the layout that fits
its content, all sharing one visual language:

- images → masonry `ImageGrid`; videos → `VideoGrid`; music → `MusicGrid`;
  files (torrents) → `FilesGrid`; science → scholarly `PaperCard` list;
  products → `ProductGrid`. Bang-limited searches route the same way via
  `only_template` (`paper`, `torrent`).
- Media grids share one tile anatomy, enforced by the shared scaffold in
  `features/results/tileParts.tsx` — every grid cell renders through `TileCell`
  (hotkey contract: `data-hotkey-index` + `selected` ring), titles through
  `TileTitle`, tile-centered actions (play / magnet / download) through
  `TileCenterAction`, corner badges through `TileBadge` (`TILE_BADGE` in
  `lib/styles.ts`): square/16:9 rounded tile, badges bottom (duration /
  filesize bottom-right, favicon bottom-left), title + one compact meta row
  below, so results hotkeys walk grids like lists.  ProductGrid and
  AppsGrid are part of this contract.  Engine
  attribution is unified in EVERY view as `EnginesLine` — `[score pill]
  [first engine] [+N]`, expanding inline on demand (score: tabular pill,
  one decimal, from the page-data `score` field; `TileEngines` in the
  grids is a thin delegate, pinned to the tile bottom via flex-column +
  mt-auto; the image lightbox renders the same row as dark chips).
- Playable media uses a centered play button on the tile (hover-revealed
  emphasis); while playing, a close button sits top-right. Music tiles with
  a raw `audio_src` swap to a custom mini player (dimmed cover, big
  play/pause, seek bar) and fall back to the `iframe_src` embed on stream
  error; videos play their embed inside the tile.
- FilesGrid has no cover art: the tile shows a type icon + detected file
  extension, the filesize takes the badge slot, seed/leech health reads as
  colored ↑↓ counts, and the magnet link is an accent circle button.
- Mixed searches render one **collapsible block per original search
  category** (`collectBlocks` / `blockKeyOf` in `features/results/blocks.ts`,
  rendered by `features/results/CategoryBlocks.tsx`): general,
  images, videos, news, map, music, it, science, files, social media,
  other — pure relevance order inside each block, in tab order by
  default; apps and products blocks render their grids too.  Blocks are
  titled with the bare category name (综合 / 图片 / ... via
  `category_labels`), never with a 结果 suffix.  Each block
  header (category icon + label + count + chevron) toggles collapse —
  folding is the quick-locate mechanism and it works on mobile.  Blocks
  default to expanded; do not reintroduce compact strip previews or
  drag-reorder handles for them (both were tried and removed).  Every block renders the same full presentation as its
  single-category page (`ImageGrid` masonry, `VideoGrid`/`MusicGrid`/
  `FilesGrid`/`PackageGrid` full grids) — never a stripped-down preview.
  Grid cells take `indexOffset` so hotkey indices stay page-global.
  Single-category intent pages (it, ...) keep a plain
  relevance-ordered list instead — extracting a type into a block there
  would break the relevance order (see the `singleCategory` gate in
  `features/results/layout.ts`).  Infinite scroll appends results into their matching
  block; loading pauses while the general block is collapsed.

Results right rail (desktop): the infobox scrolls inside its own area
(`min-h-0 flex-1 overflow-y-auto`); the rail wrapper renders only while it
can ever get content — always during the streamed boot (width reservation
matches the static skeleton so the swap never shifts) and afterwards only
with content (infoboxes present or POST mode), at which point an absent
rail frees the column and the container-query grids widen into it. A
rail-free **card-list** page (`list`/`dictionary`/`science`) is the one
exception: borderless rows capped at the reading measure cannot use the
freed width, so the column takes
`lg:max-w-[calc(100%-22rem)] xl:max-w-[calc(100%-26rem)]` — exactly the
width the reserved rail would leave, keeping the boot swap gapless and
the page shaped (no formless right void). The
sidebar itself grows on wide screens (`lg:w-80
xl:w-96`) instead of giving everything to the text column. Grid density
is container-query driven: the results column is an `@container` and
every grid steps its columns by container width (`@[24rem]`/`@[40rem]`/
`@[46rem]`/`@[54rem]`/`@5xl` per grid, tuned so tiles stay ~180–320px) —
widescreen (90rem cap) gains a column, centered (72rem) drops one, and an
empty rail automatically widens the grids. Never convert these back to
`sm:`/`xl:` viewport breakpoints (that is what broke centered mode's
density). Diagnostics (`DebugPanels`) live in the
results meta line on both desktop and mobile: the line reads 「找到 N 条
相关结果 · 耗时 X.X 秒 ▾」 and clicking it expands a single engine-timing
table (`table-fixed` so the `w-24` name truncation works) through the
shared `Collapse` (both strips animate) — unresponsive
engines share the same grid (AlertTriangle + red error label + empty
bar, seconds column aligned).  With ZERO results the page is
empty-state-FIRST: the NoResults hero leads the column and the meta line
+ engine-messages panel follow as supporting detail; the engines toggle
reads 「来自搜索引擎的消息」 (never 「耗时 0 秒」 when nothing was
found) and starts expanded with `animateOnMount`.  Infinite scroll never engages on a zero-result page (the
empty state is final — no phantom loader hunting page 2), and the
sentinel renders its spinner only while a page is actually loading
(idle = quiet spacer, error = red message).  The export chips in the results strip (RSS/JSON/CSV) download
the results currently on screen client-side (`downloadResults` in
`lib/exporters.ts`): with infinite scroll the merged list (payload page +
appended pages) only exists in the browser, so a plain click must never
re-run the search — the chips keep their `GET /search?format=…` hrefs for
modified clicks / feed readers, and formats without a client-side builder
fall through to the server URL.  The exported structures mirror the upstream
serializers so a download and a curl of the same query are interchangeable:
JSON emits the `get_json_response` keys with results in the upstream
result-dict shape (base keys always present, `parsed_url` as the 6-element
ParseResult array, singular `engine`, ISO `publishedDate`, compact encoding;
theme-only fields like title_html are dropped) and answers in the msgspec
`to_builtins` shape — which is why the legacy/stock answer payload carries
`engine` (see `_answer_data` in macros.html).  RSS mirrors
`zjsearch/opensearch_response_rss.xml` line by line.  CSV keeps the upstream
columns but fills the answer rows gracefully (the server CSV crashes on
answers: `parsed_url` is null there).  MARKDOWN is the one client-only
export (no server format endpoint): an MD chip after the server formats.
DOWNLOADS LIVE IN THE KNOWLEDGE BASE ONLY: the AI Overview card and the
AI Search thread/actions rows carry regenerate + copy and NOTHING else —
⬇ (Markdown) and 📄 (PDF) live on the knowledge page's records (the
inspector's header, `exporters.downloadAnswerMarkdown` /
`downloadThreadMarkdown`).  PDF is the browser's own dialog, not a jsPDF
dependency (CJK font embedding would torpedo the no-webfont budget): the
📄 action mounts `PrintView`, a thin wrapper over `lib/print.ts`'s
`printDocument({title, fileTag, heading, source, sources})` -- the shared
pipeline (wordmark, injected heading, cloned rendered content with chrome
stripped, numbered sources at the tail, dark-mermaid light re-renders,
filename via `document.title`).  THE PAPER IS THE VIEW: the sheet mounts
visible immediately (`.zjs-print-preview` -- white ground, 210mm measure,
close chip, Escape), `window.print()` rides right after the mount, a real
browser's dialog opens OVER the paper, and `afterprint` never tears it
down -- the user dismisses the paper themselves (embedded webviews cannot
open the dialog at all, and theirs fires a PHANTOM afterprint at
unpredictable times; measured ~1s and ~9s -- never race it).  `styles/print.css` is print-only by
construction (`@media print` + selectors that match nothing on screen) and
PAPER IS ALWAYS LIGHT ON A PURE-WHITE GROUND: the color tokens are
`@property`-registered, so `initial` restores the light palette from
tokens.css (one source of truth), `--bg` is pinned `#ffffff` in the dark
force AND the print-view root paints pure `#ffffff` — never the light
theme's warm off-white (against the white @page margins it reads as a
yellow sheet); `.zjs-print-hide` marks the chrome that must never print,
clamps expand, Collapse panels print open, reading measures widen.  The
one component with colors BAKED into the DOM is mermaid: blocks carry
`data-zjs-mermaid` and PrintView renders its own NEUTRAL copies
off-screen (global mermaid config restored after) — the live page never
re-renders, so nothing flashes.  Suggestions render as a single-row
chip strip
under the results meta line (`SuggestionsBox`, all breakpoints): chips
are single-line truncated, the row pages via ‹ › ghost arrows that stay
persistent (disabled at the ends and when the row fits, so flipping state
never shifts the chips; uncapped — paging handles any count, honors
`prefers-reduced-motion`); the right rail never hosts suggestions.

Query-term highlighting (`.highlight` in `styles/base.css`) is a tinted
background only — color marks the term, no bold.

## PWA layer (standalone adaptation)

The installable-app layer: `.zjs-appbar` (Shell TopNav + the results
page's two header variants) pins the top bar (`sticky top-0 z-50
h-14`, the ZJBlog Navigation's frosted recipe -- `bg-bg/80
backdrop-blur-md`, `border-line/80`; z-50 matches the overlay drawer,
DOM-later wins).  `viewport-fit=cover` + the `zjs-appbar` top inset and
the body bottom inset keep standalone clear of the notch / home
indicator; jump targets carry `scroll-margin-top` (base.css, read by
`scrollIntoViewAnimated`); the bar hides on paper.  `theme-color` is
rendered per `simple_style` server-side and follows the live palette
flip in `applyThemeStyle`.  The manifest override lives at
`searx/templates/zjsearch/manifest.json` (upstream `/manifest.json`
resolves per theme -- no python change); icons reuse the theme's
favicon.svg (any + maskable) and apple-touch-icon.png.  The service
worker (`searx/zjsearch/pwa.py`, served at the scope root `/sw.js`) is
DELIBERATELY cache-free: a pass-through with an offline fallback for
navigations -- static caching through a SW would outlive WhiteNoise's
30-second staleness window and revive stale bundles; caching policy is
a later, explicit opt-in.  Touch devices hold every editable control at
16px (the iOS focus-zoom floor; desktop keeps the designed sizes).

## NoJS / RSS surface (same brand, own tokens)

`noscript.html` + the `.zjs-noscript` block in `styles/noscript.css` and `rss.xsl`
are the JavaScript-free faces of the theme (basic search, results,
pagination; the RSS feed renders through the XSL stylesheet, whose CSS is
an embedded `<style>` block — the XSL is the only fetch a feed viewer
makes, so it is self-contained by design and NOT part of the client
build; upstream `simple` instead links a dedicated built rss.css).  Rules:

- Their palettes mirror the app tokens exactly (light `--accent #8c6800`,
  `--ink-3 #716c61`; dark tokens match `.dark`) — the earlier lighter
  amber/grey variants are gone; keep them in sync when retuning tokens.
  Dark mode there is `prefers-color-scheme` plus the server-rendered
  `html.light/.dark/.black` classes (base.html) — explicit preference beats
  the system, no JS involved.
- Radii follow the app scale (cards 16px = rounded-2xl), the wordmark is
  1.25rem/600 serif like the header brand, and the brand dot is `.dot`
  (accent), not an ad-hoc class.
- Strings are English-only by design: the no-JS templates have no i18n
  mechanism (adding per-server-locale template variants doesn't scale);
  the React surface owns localisation for every JS locale.  Never wire
  searxng's gettext catalogs into zjsearch chrome, on the server side
  either.

## MCP tool servers (streamable HTTP)

`zjsearch.mcp` bridges external MCP servers into the agent's tool surface —
a LIST of single-key mappings, the server name mapping to its connection
(`url` required; `header` carries whatever auth the server wants, merged
verbatim onto the request).  Streamable HTTP ONLY (stdio/SSE are out of
scope).  The official `mcp` SDK (MIT, theme requirements section) drives
the wire; each operation runs inside ONE self-contained connection (open →
initialize → act → close, a single loop task — the SDK's anyio task groups
cannot survive the next `run_coroutine_threadsafe` task, so sessions are
deliberately NOT cached).  Tools are namespaced `mcp_<server>_<tool>`,
their descriptions and JSON schemas ride the model's tools array verbatim,
and the researcher prompt gains nothing extra (the descriptions carry it).
Executor dispatch is the `mcp_` prefix branch: blocking on the shared
loop's result with a 90s budget, the timeline row renders the server-scoped
tool name with a Plug icon.  Unconfigured = silence (no specs, no
sessions); a dead endpoint contributes nothing (one server failing must
not take the run down).  PROGRESSIVE DISCLOSURE (the Agent Skills
injection pattern) governs the tool surface: past 8 tools total
(`PROGRESSIVE_THRESHOLD`) the run registers ONE `mcp_search_tools`
discovery tool instead of every schema — the model keyword-searches it,
receives the matched tools' COMPLETE parameter schemas, and calls them
by name next turn (a miss returns the inventory for re-querying).
Below the threshold the tools inject directly.  This is the same
three-layer idea as LobeHub's skills (`activateSkill`: name+summary
first, full instructions on activation, references on demand) — any
future skills system must follow it too.  The amap E2E: 15 tools listed, real geo/weather
calls answered.  KEYS live in the config file (never env) and NEVER enter
git — dev-settings.yml carries them locally only.

## Task decomposition (quality/goal) and the GOAL LOOP

quality/goal decompose: the model writes a LIVING task list
(`task_write` — 2-4 subtasks with pending/active/done statuses; the
client renders it as the TASK CARD above the timeline: three-state rows
+ a done/total counter; `Coverage` marks a subtask done only when real
source titles matched — a subtask that never gathered a source is NOT
flipped to done).  The old `spawn_subtask` subagent nest and the
one-shot plan tool are REMOVED — the task list is the only decomposition
surface; the client's `spawn_subtask` tool name survives solely as a
stored-legacy thread renderer.

SUBAGENTS (`research_subtask`): the delegation gate is the DEPTH PROBE's
rung — deep from rung 2, balanced from rung 4 (the four-field brief +
batch cap + the shared registry make delegation safe; the old deep-only
rung-3 gate made it nearly unreachable), and `<research_policy>` tells
the model its grade.  THE CHILD IS A WHOLE RESEARCHER: its toolset
carries `learnings_spec()` (THE LEDGER IS ITS DIGEST — the delegation
contract promises facts + gaps, and `_sub_digest` builds exactly those
from `child.facts`/`child.gaps`; a child without the tool returned a
bare 「来源 N 条已入册」 and its report was discarded) and `judge` under
the lead's decision gate; its SPEND joins the run's account
(`_promote_child` folds the child's rerank/decision buckets, its
judgments tagged `sub:`, and its gate usage — un-promoted, four
subagents were dark matter on the model-stats card).  The digest lists
only ACTIVE facts (superseded ones are history).

GOAL is the LOOP mode: the four depths are budget/decomposition/
output-shape differences on ONE loop, and goal's contract is "researches
until the goal is met" — the loop ends on the task ledger closing (the
model stops calling tools) or a stalled run (3 unproductive rounds),
never on a small count.  `max_rounds: 32` is the runaway guard, not the
plan (the ceiling is INTERNAL: mode budgets 6/60/120, the depth probe's ladder personalizes it per question — deliberately not a deployment knob); the prompt
tells the researcher to keep working open ledger items and to switch
tools freely (searches, page reads, the calculator).

## Failure becomes information (the stall policy + the findings ledger)

FAILURE IS RETRYABLE: the dedup registry marks queries/pages at
COMPLETION, never at plan time — a query whose engines errored and a
page whose read failed stay re-runnable (an executed query — empty or
not — is honestly remembered; only an errored one is not).  The search
dedup key describes the search AS EXECUTED: excludes wear their
`-site:` operator (a role swap is a different search) and
category/time_range ride along — the prompt's own recovery recipe
("a filtered search came back empty: retry without the filter") must
never settle as a duplicate.  An unproductive round (gathered work,
zero new sources) appends a change-the-angle note to the round's tool
results BEFORE the stall detector fires — Jina's diary discipline:
`stall_rounds: 2` modes get one warning then the halt, goal's 3 get
two.  Pure bookkeeping rounds (plan writes, learnings, memory saves)
are NEITHER progress NOR stall.  The researcher never sees the stall
halt itself — that note (`STALL_NOTE`) stays the writer's honesty
context.  A settlement generator guards everything after its future
resolves: one malformed result degrades THAT call to an error row, the
round's remaining calls still settle.

PLUGIN ANSWERS ARE MODEL-VISIBLE: the AI search runs the real
`SearchWithPlugins` path, and a query that triggers an answerer
(`$AAPL` / `AAPL stock` -> stock_quote) now carries the answer as the
FIRST line of that search's feed block ("Direct answers") --
SearchWithPlugins computed answers all along and the old code dropped
them at `get_ordered_results()`; an answer-only search also counts as
productive for the stall detector, and the web_search spec teaches the
trigger syntax.  The `web_browser` tool's `search` action runs a LIVE
SERP (bing/baidu/google/duckduckgo) on the session page through the
anti-detect fingerprint -- the escape hatch when the engines are
bot-walled/captcha'd/empty (the web_search description
cross-references it); the scrape carries a relevance guard (rows
sharing no query token = one settle-and-rescrape, then an honest "no
results parsed" that points at snapshot); `engine`/`query` params, the
timeline row shows `ENGINE · query…` with a live-results metric, and a
SERP needs no refs so no outline rides along.

THE SESSION'S PLATFORM DOCTRINE: the web_browser spec explicitly
licenses driving the session at ANY public platform (xiaohongshu /
zhihu / bilibili / weibo / e-commerce / forums) -- open the site's
on-site search URL (`xiaohongshu.com/search_result?keyword=...`) or
drive its search box via snapshot+click+type, then read/click/
screenshot like a user.  The model constructs the URL itself (verified
live: it went straight to XHS's search_result page); a login wall is
reported honestly and the wait_user mirror is the user's way through.

THE BROWSER-USE DIVISION OF LABOR: `web_reader` and `web_browser` are
deliberately TWO tools over ONE engine, not merged — `web_reader` is
the PARALLEL one-shot read (worker pool, TTL cache, read dedup; many
pages per round), `web_browser` is the SERIALIZED session (ONE page
the model drives and the user can take over; clicks, typing,
screenshots, the human's login window).  The spec's doctrine says
"web_reader first": the session is for pages a read cannot see through
(sign-in walls, verification) or when interaction is the only way
through.  A session page becomes a FIRST-CLASS source: `open` mints
its [n] (citable identity), `read`/the post-`wait_user` snapshot
register the full text under it (corpus + writer feed + coverage, the
reader settlement's exact pattern) — the answer can cite what the user
logged into.  The takeover UX contract (the rail's live mirror card
pins FIRST; a `wait_user` window AUTO-OPENS the takeover ONCE per
window — the run blocks on the user, a prompt hidden behind a rail
card would stall the run silently; the window-end frame retires the
countdown; below lg a FIXED bottom bar keeps the window reachable from
anywhere on the page; the timeline's web_browser rows render the
ACTION's result — the screenshot shows its shot (click zooms), open/
snapshot render the session's interactive-element outline, click/type/
press/scroll render the location line, read/wait_user render the
reading pane; the images are volatile, replays keep the record).

THE READER'S RENDER CONTRACT (the built-in browser): the reader has
exactly ONE render backend — the local Camoufox anti-detect Firefox
(`searx/zjsearch/ai/browser/`, opt-in via `zjsearch.browser.enabled`;
the Browserless provider code was REMOVED, and with it the whole
`zjsearch.reader` provider surface — `base_url`/`api_key`/`query`/
`params` are dead keys, only `enabled`/`max_chars` remain).  Reads
dispatch onto the shared loop, one page per read under a `max_pages`
semaphore, `load` + network-quiet + settle, then the WHOLE rendered
page goes to ONE markdown engine — the shared markitdown service
(`core/convert.py`; `html-to-markdown` is GONE).  NO readability
extraction, NO drop-tree: silent content loss is the one unacceptable
failure in the reader, and page chrome (nav, footer, banners) is
visible noise the model navigates past on its own.  Title and the
capped links appendix ride a read-only bs4 parse.  DOCUMENT urls
(`.pdf` / `.docx` / `.pptx` / `.xlsx` / `.xls` -- the
`core/convert.py` document-extension set) skip the browser entirely: a
direct fetch (the attachments image network's shape, same `guard_url`
gate) + markitdown's converter for the kind — the browser renders
PDFs as viewer chrome and Office files as download prompts, never
content.  Conversion failures are `PageReadError`s (the model moves
on).
uBlock Origin (camoufox's default addon) is the adblock — default ON,
`adblock: false` excludes it (the offline audit sets that; a first
launch without network would otherwise try an addons.mozilla.org
download, which fails open with a log line and retries next launch).
Firefox does NOT inherit the shell's proxy env — a proxied deployment
names it in `zjsearch.browser.proxy` (the `{server, bypass, username,
password}` shape).
Deployments: install the browser once with
`python -m searx.zjsearch.ai.browser.install` (= `camoufox fetch`,
lands in the user cache).  Docker bakes it in at build WITHOUT any
Dockerfile change in this repo being required — the recipe, if/when
you build the image:

    # builder stage, after the searx/ COPY:
    ARG ZJSEARCH_BROWSER="true"
    RUN set -eux; mkdir -p /usr/local/searxng/cache; \
        if [ "$ZJSEARCH_BROWSER" = "true" ]; then \
            XDG_CACHE_HOME=/usr/local/searxng/cache \
                ./.venv/bin/python -m searx.zjsearch.ai.browser.install; \
        fi
    # dist stage, after the .venv COPY:
    ARG ZJSEARCH_BROWSER="true"
    ENV XDG_CACHE_HOME="/usr/local/searxng/cache"
    COPY --chown=977:977 --from=builder /usr/local/searxng/cache/ ./cache/
    # the ONE playwright command that remains: camoufox fetch ships the
    # browser BINARY only, and camoufox has no system-deps installer of
    # its own -- playwright's CLI (a transitive dep) carries the
    # maintained Firefox package list.  Desktop dev never needs this.
    RUN set -eux; if [ "$ZJSEARCH_BROWSER" = "true" ]; then \
            apt-get update -qq; \
            ./.venv/bin/python -m playwright install-deps firefox; \
            apt-get clean; rm -rf /var/lib/apt/lists/*; \
        fi

(Point `zjsearch.browser.profile` into the
container's data volume so the cookie store survives recreation.)
`zjsearch.browser.allow_hosts` is the sanctioned intranet escape
hatch: exact hosts both SSRF gates (the reader's string-level
`guard_url` AND the browser's request gate) let through — it is how
the audit reads its loopback fixture offline.

THE FINDINGS LEDGER (`learnings` tool, dzhng's learnings as a
first-class surface): the researcher records what the sources
ESTABLISHED (1-6 self-contained [n]-cited facts per call, deduped into
the run's ledger); the wire `learnings` event is the authoritative
snapshot, the writer receives the same list as a `<findings>` block
beside the raw sources (support, never substitute — the citation
contract still binds), and the client renders a findings card under the
research-plan card (plan above, evidence below; each fact expands
through the source cards' measured 查看更多 clamp).  Plans/next steps
belong to `task_write`, narration to the step notes — the prompt says
so.  Ranking (rank.py) is deliberately NOT a tool: ranking fixes the
order of things about to be SHOWN (before the reveal, mechanical,
Bocha/Jina-style); tools give access to things the model cannot see.

CONTINUE (断点继续): an interrupted research is a STORAGE question, not
a server session — `startRun` persists the run row from run start, the
1.5s evt flush keeps the log current, and the failed box's 继续 button
(`useAiSearch.continue`) RESUMES THE SAME RUN in place: the loop emits a
storage-only `ctx` wire event at every round boundary (`{round,
messages}` — the researcher's EXACT message list, a JSON-frozen copy;
the client upserts it into ONE knowledge row of kind `runctx`,
out-of-log because the full list is redundant across rounds), and the
continue POST carries it back as `resume` — the route's
`parse_resume` validates it (malformed/oversized ⇒ silent
fresh-conversation fallback), strips assistant `thinking` blocks (their
signatures never survive a process border), reseeds the [n] registry
from the stored sources (a repeat url reuses ITS number; `sources_base`'
s clamp is 2000 — a heavy deep run gathers hundreds), and replaces
`initial_messages()` with the replayed conversation + a
`<resume_note>` continuation instruction.  The engine seeds
`entry_base`/`round_base` so the resumed stream's timeline ids continue
the stored ones (the client's `client.resume` fold resets only the
failure state AND the stage spine — steps, sources, ledger and cards
all survive; the re-fired plan/research phases must not append echo
duplicates; a death mid-WRITE restarts the document, noted limit).
CONTINUE HYGIENE (the 2026-10 round's data-loss lesson): the evt-log
seq counters are MEMORY-ONLY — a fresh tab MUST reseed them from the
store before appending (`seedSeqCounterFromStore` on continue, from the
loaded rows on thread replay), or every resumed event collides with the
stored `run_event` PK and `ON CONFLICT DO NOTHING` silently drops the
whole resumed wire.  Continue locks the run's OWN mode (the dropdown's
pick must not convert an interrupted report), sends
`clarify: answered-EMPTY` (a parse_resume failure then degrades to a
fresh run WITHOUT re-opening the clarify gate), guards the double-click
(`continuingRef`), stops a still-alive hosted run first, and bails the
attach backoff on HTTP 404 (a swept handle never revives).  A REPORT
continue sends the stored outline back as `resume.outline` — the server
re-validates it through `restored_outline()` and skips the outline gate
(the TOC the user already saw stays; key_questions regenerate empty,
accepted).  The ENTRY POINTS: the failed box's 继续 (scoped to the LAST
run — continue/regenerate act on `core.runs[end]`), and for a
USER-STOPPED run the quiet accent pill beside the run footer (the
failed box stays exempt for stopped runs; without the pill the kept
checkpoint was unreachable).  A checkpoint-less run
(predating the feature) falls back to the legacy contract: a NEW run
whose findings travel as the confirmed `<clarified>` direction.  A
still-alive hosted run is stopped via run/control BEFORE the resume
starts (two researchers on one question is pure waste).  The server
stays stateless.  A stale-run sweep (2h silent + "streaming", once per
session at the first directory read) corrects rows whose tab died
mid-research; the client live-fold accepts the wire's LATE events
(related/memory/tags/

THE RUN HOST (`runs/host.py`, v2.1 R1): a research run's life is
DECOUPLED from its client connection — the loop executes on a driver
thread and every wire event publishes into a per-run handle (seq-stamped
buffer + subscribers); the HTTP response is just the FIRST SUBSCRIBER.
A dropped connection is a DETACH, not a death: the run finishes its
current round, holds at the round boundary, and `POST
/zjsearch/ai/run/attach` (body: run_key from the `X-Zjs-Run-Id` response
header + after_seq) replays the SAME run — the client's `useAiSearch`
tracks the last seen `seq` (stripped before the evt log) and retries the
attach with backoff before falling back to the local error settle.  A
run detached longer than the grace window (`detach_grace`, default 90s)
wraps gracefully at its next boundary — halt note to the writer AND the
settle — so every run ends with a real terminal state (the 2h stale
sweep stops firing for this class); a finished handle stays fetchable
for a TTL (1h) then the sweep drops it.  Stopping is an INSTRUCTION:
`POST /zjsearch/ai/run/control {action:"stop"}` (the client's stop
button fires it before aborting) — the loop sees the flag mid-turn
(1s-sliced event waits; an interrupted turn is an `interrupted` outcome,
never `died`) or at the boundary, skips the writer, settles
`error/halt=研究已按用户要求停止`.  The research run's settle usage
merges AT GENERATION on the driver (`_SettleTail`, shared with the
request-thread `_Ndjson` the clarify/no-research paths still use), and
the late work (related fallback / memory extraction) runs there too —
a detached client costs neither.  `flask.copy_current_request_context`
is captured in `SearchesCore.__init__` (the driver thread has no request
context).  R2 landed the FULL control plane on that ControlBox: the
wire's `steer` event (`{text, delivery: guide|preempt, status:
drained|discarded}`) records every user steering — Enter queues a guide
(ONE drain per round boundary, FIFO, cap 3; a steer outranks the
continuation note and injects as `<user_steering>` — the researcher
prompt's block teaches: latest steer wins, act don't re-ask), ⚡/Shift+
Enter PREEMPTS (the in-flight turn cancels via the same interrupted
outcome and the run CONTINUES on the steered course), and the write
phase closes the lane with VISIBLE discards.  The composer is dual-mode
(`useAiSteer`: streaming = amber steer box + pending chips; settled =
follow-up as before); the 收尾 button (`handle.wrap()`) ends the
research gracefully into the writer.  Per-subagent flags land on the
same box in R3.
usage) AFTER the settle — memory saves persist live, tags park before
settleRun; everything else post-settle stays dropped.

## The human-in-the-loop doctrine (ask_user / clarify)

The agent must NOT plow ahead on a guess: the `<ambiguity_escape>`
researcher block and the `ask_user` tool spec license asking the moment
the run could miss what the user wants — a genuinely ambiguous subject,
a scope/success criterion only the user can state, and ALWAYS on
high-stakes deliverables (forecasts, investment/purchase/health/legal)
whose assumptions change the answer.  The clarify gate carries the same
high-stakes posture in BOTH gated modes (quality keeps its narrower
"only when direction depends on intent" rule on top).  The DECISION
PRE-GATE guards the expensive clarify completion with TWO nouls in one
forward pass — `ambiguous` and `high_stakes`
(floors `features.clarify_gate.ambiguous_min` 0.65 / `high_stakes_min`
0.60, either opens) — two questions ON PURPOSE: a clear-but-risky
"which index fund should I buy" must not read as unambiguous; the
pre-screen's verdict + spend join the 决策结果 card (named-verdict-map)
so the ask/no-ask is explainable.  Guardrails stay:
one ask per turn, max 3 questions, never for what a quick search
settles.  SHAPE EQUALITY is a contract: the tool spec advertises exactly
what `gates.sanitize_questions` passes (single/multi + 2-4 options; the
client's free-text line covers yes/no and open answers — a type the
sanitizer would downgrade must not be offered to the model).

## Knowledge base (知识库 -- the event-sourced browser-local research memory)

The PGlite store IS the theme's research memory; schema v5 (v4's
split plus `run_summary`/`stats`/`attachment` + the bytes/head triggers,
marked by the `run_summary` table) splits the
wire log into its OWN table (`run_event`, PK (run_id, n), DDL in
`src/lib/pg.ts`) and keeps the queryable surfaces as PROJECTIONS in ONE
`knowledge` table -- every scan, aggregate and work queue costs
O(projections), never O(projections + events).  Projections written at
settle: `run` (its meta carries a 600-char answer head --
  the thread rows' inline preview) / `source` (canonical url identity
+ ref/cited counters) / `source_ref` (the (run, source) join AS a kind)
/ `document` (web_reader full texts) / `memory` / `call` (the agent's
search words -- the exploration trail) / `task` / `clarify`.
`answer` is the AI OVERVIEW archive: the classic search page's overview
saves itself at settle (`saveOverview` from ResultsPage's settle effect
-- the knowledge base's bridge to the classic page; id = query hash,
re-asking refreshes) and the 答案 tab reads it.  The sources the
overview actually CITES join the 来源 corpus (`ref:ovw:*` source_ref per
(query, source) + the canonical source row, the settleRun identity
pattern -- only cited [n], never the whole context).  Run answers are
deliberately NOT projected -- they only duplicated the thread's 研究
row; they replay from the event log like every other wire event.
Answer-kind rows open the inspector (there is no thread page behind an
overview).  Replay
and retrieval are separate executions of ONE reducer:
`applyEvent` (useAiSearch, exported) folds a live stream in the hook
and folds `loadThreadEvents` rows in `resume` -- a stored run and a
live run hit the same renderers.  Client events (`client.start` /
`client.clarify` / `client.retry` / `client.stop`) are recorded into
the same log so a replay is self-contained.  PGlite hands jsonb
columns back ALREADY-PARSED: decoding must type-dispatch, not
`JSON.parse` blindly (parsing an object yields "[object Object]" and
loses the event -- shipped bug).

- STORE: `src/lib/knowledgeStore.ts` is the facade -- `appendRunEvents`
  (buffered ~1.5s; the flush is ONE multi-row INSERT into run_event --
  atomic, a crashed tab has the batch or not), `startRun` (the run row +
  the thread's directory entry land AT RUN START, status "streaming" --
  a killed run stays visible and replayable; the continue path's
  storage), `settleRun` (ONE transaction: flush + projections +
  `thread_head`; then the embed pass + tag normalization trail outside
  it), the live subscriptions (PGlite `live` plugin), and the read APIs.
  There is deliberately NO in-memory mirror anymore: every surface
  reads the same table the writes land in.  The ordered write queue
  warns on failure (fire-and-forget callers would swallow a broken
  write into "the feature is broken").
- THREAD_HEAD: the thread directory is a settle-maintained projection
  (`thread_head`: title = the FIRST run's question, preview = the
  latest run's answer head, runs/sources counters, updated, pinned).
  The v3 GROUP BY + correlated-subqueries aggregate re-fired on EVERY
  evt flush; the projection is a 40-row indexed listing whose live
  subscription re-fires at settles/pins/deletes only.  Counters advance
  only on the run row's FIRST insert (`RETURNING (xmax = 0)` -- a
  re-settle stays idempotent and only refreshes preview/recency).
- RECALL: `recallCorpus` (writer-phase corpus) and `recallPages`
  (past_research index) fuse TWO dimensions -- hybrid BM25+vector RRF
  (trigram rescue on zero signal) and the TAG GRAPH (query matched
  against the tag vocabulary, shared-tag rows ranked, one-hop
  expansion) -- then the RERANK TIER re-scores the fused head (16, ≥4
  candidates) through `POST /zjsearch/ai/rerank`: the RRF narrows, the
  cross-encoder orders, any skip/failure keeps the fused order; the
  classic page's eager `recallPages(q, 2)` passes `{rerank: false}`
  (the hover prewarm spends nothing beyond the fusion).  The recall
  rerank's input tokens land in the knowledge table's `usage:rerank`
  row; the model-stats card's 重排 tile sums BOTH pools (the runs'
  cascade spend from run meta + this row).  THE RED LINE stands: recall
  reaches the writer phase or the UI only, never the researcher's
  feed.  `answer` rows are corpus too ("you researched this before").
- TAGS, three layers: the mechanical derive (query tokens + hosts +
  mode + task titles) at settle; the post-run extractor
  (`extract_insights` in ai/tools/memory.py -- ONE completion
  returns {facts, tags}); and `POST /zjsearch/ai/tags`
  (api/tag_route.py, the AI Search token, embed-route shape) which
  folds batches of raw tags into 2-6 concept tags per row (language
  merge, host/noise drop).  Rows carry `meta.tnormed`; a failed
  normalization keeps raw tags.  Tags are a jsonb column + segmented
  into search_text; the GRAPH is a query, not a table --
  `graphSnapshot` aggregates nodes (tag uses) and co-occurrence edges
  on demand.
- PANEL: the header LibraryBig button opens `/zjsearch/knowledge` as a
  slide-in panel, the same way as about / stats / preferences
  (`renderOverlayPanel` in app.tsx renders `KnowledgePage embedded`; the
  standalone page URL stays for deep links).  The panel NAVIGATES, it
  never stacks: admin (manage/stats/reset) and the inspector reading
  pane are IN-PANEL VIEWS swapped through one `view` state (each with a
  back row that takes the focus on swap) -- a second drawer inside the
  drawer was tried and removed as off-design.  The one real nested
  dialog is the ConfirmDialog (centered modal): the drawer's Escape
  (OverlayProvider) and Tab trap (useDialogFocus) stand down while the
  focus sits in the deeper `[role=dialog]` -- Escape closes it first, a
  second Escape closes the drawer.  Opening a thread CLOSES the panel
  and SPA-navigates the main view (a thread is a work surface, not a
  panel page).  Vane's Library shape (hero stats, thread rows; the
  detail lives on the AI thread page), morphic's interactions (flat
  row actions -- star/trash icons on every row kind and in the
  inspector, confirm-backed deletes, inspector reading pane for
  document hits), LobeHub's memory surface (timeline/cards + tag
  chips, per-card edit), the cross-kind
  hybrid search, the `TagGraphView` (hand-rolled force layout on canvas
  -- no graph dependency), and the AdminPanel's duties (per-kind stats,
  clear studies, the database reset -- the old preferences PgliteTab's
  duties; that tab is gone).  The old KnowledgeDrawer is deleted.
- CLASSIC SEARCH HISTORY IS GONE: the `searches` table, the
  ResultsPage recording effect and every read path were removed (the
  knowledge base is AI-runs-only).  `recordClassicResults`' corpus
  feed died with it -- the sources corpus grows from AI runs only.
- BOOT: schema v4's upgrade is IN PLACE and v5 rides the `run_summary`
  marker (a database without it dies WHOLESALE -- v5 now holds real user
  data, so a future v6 needs a real `schema_meta` migration seam, not
  another drop); the v3 evt rows copy into
  run_event with one idempotent INSERT..SELECT -- crash-resumable --
  then leave `knowledge`; the dead `parent_id` column drops).  Legacy
  v2 tables still die wholesale (CASCADE -- the old live-query
  views/bm25 internals can hold dependencies a plain drop trips over; a
  wedged legacy drop once silently failed EVERY store write for the
  session).  Relational furniture v4 puts to work: a GIN index on tags
  (`graphRecall`/`itemsByTag` ride `?`/`?|`), partial indexes for the
  two work queues (the idle probes were full scans that found nothing,
  twice per settle), and a GiST trgm index serving the rescue as a KNN
  `title <-> query` ordering (gist_trgm_ops missing in a pglite build
  degrades the rescue to its rare seq scan).  The 2026-10 round's index
  discipline: a partial index whose PREDICATE changes needs DROP-first
  (`CREATE IF NOT EXISTS` keeps the stale definition); the embed-pending
  predicate EXCLUDES `source_ref` (they carry search_text but are never
  embedded -- the polluted index made the idle probe walk every ref row
  per settle); `knowledge_kind` is the TWO-key sort `(kind, pinned
  DESC, updated DESC)`; `thread_head` carries its listing index;
  `hybridRecall` OVER-FETCHES (`limit*8`, min 64 -- the index legs rank
  across ALL kinds and a narrow kind-set starves); the trigram rescue
  is the index-served `title %> $1 ORDER BY title <-> $1` (a
  `word_similarity()` call could never use the index).  DELETES CASCADE:
  `deleteItem(run)` sweeps the run's evt rows + (run, source) ref rows
  (stepping the sources' counters down); `deleteThread`/reset sweep
  `attachment` (the data-URL bytes survived a nuclear reset once).  A
  FAILED evt flush RESTORES its buffer -- a rolled-back settle
  transaction must not eat the batch (a crashed TAB loses at most one
  batch; a broken DB loses none).
  RESET drops the three tables CASCADE and re-runs the schema DDL ON THE
  SAME LIVE CONNECTION (`createSchema`) — the old close-and-reopen dance
  raced PGlite's IndexedDB flush (a reopened database served the
  pre-drop state back: "the reset did nothing") and wedged the live
  subscriptions; the reset also clears the localStorage embedding-usage
  totals (`zjs-embed-usage` — a reset that leaves them reads broken).
  `createSchema` runs on EVERY page load, so its DDL must be IDEMPOTENT
  end to end: `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS`
  before each `CREATE TRIGGER` — a bare `CREATE FUNCTION`/`CREATE
  TRIGGER` fails the SECOND boot with "already exists", the rejected
  pgPromise takes every store read AND write down for the session, and
  the knowledge base reads as EMPTY (shipped bug, caught by the 2026-10
  browser audit).
- ENV keys: `ZJSEARCH_AI_KEY` / `ZJSEARCH_EMBEDDING_KEY` /
  `ZJSEARCH_RERANK_KEY` (api_key stays "" in
  dev-settings.yml -- the rerank key NEVER lives in the file).
- USAGE STATS: the admin panel sums the runs' + overviews'
  `meta.usage` (input/output/thoughts/cached) from the knowledge table;
  the inspector shows the same per card.  `usage.rerank` (the ranking
  cascade's endpoint spend: calls + prompt tokens — score endpoints are
  input-only, so prompt_tokens IS the total; shown as 重排输入/重排调用)
  shares ONE row with the embedding totals (嵌入 first) on the 模型统计
  card and rides AiRunFooter per run.  The EMBEDDING calls never land
  in the table -- the route passes the SDK's usage through (openai:
  `prompt_tokens`; gemini has NO token usage for embed_content, only the
  enterprise `billable_character_count`, passed when present) and the
  client accumulates it in localStorage (`zjs-embed-usage`), shown under
  the AI usage card.
- WhiteNoise serves the bundle bytes captured at INSTANCE START: after
  every build, RESTART the dev instance or the browser keeps executing
  the stale bundle (this masked three real bugs during the knowledge
  work; the debugging note below the fold repeats it).

How runs consume the corpus (the client recalls BEFORE every AI-search
POST; the server stays stateless):

- `history_sources` — corpus hits (sources + past answers): WRITER-phase
  only (numbered after the live feed; a url the researcher already
  numbered keeps ITS number).  THE RED LINE: recalled material never
  seeds the researcher's feed — ready-made answers kill the
  live-search incentive.
- `past_research` — the RAG TOOL index: document entries carry
  ~1500-char heads, source entries identity only (the tool's feed then
  points at web_reader for a live re-read); registered only when
  non-empty.
- `user_memories` — the full snapshot (see the next section).
- The `pastRefs` cross-session badge reads the PRE-run recall's
  ref counts — the run's own increment must never badge itself.

AI OVERVIEW accuracy levers: the classic page recalls up to 2
document rows EAGERLY (a click-time recall would stall the first
paint on an embedding round trip) via `recallPages` and trails them as
labeled [n] context lines; server-side, `overview._ordered_context`
cosine-reorders the numbered lines past 12k chars (the 16k cap cuts at
a LINE boundary) — both silent when `zjsearch.embedding` is off.

## User memory (browser-local durable facts)

The `memory` kind (rows in the knowledge table) stores durable facts
about the user — one flat layer of self-contained sentences, deliberately
NOT LobeHub's five-layer taxonomy.  Two write paths, deliberately
redundant, both fused into ONE post-run extractor:

- READ: the run pre-sends every stored fact (`user_memories`, the
  content list) and the researcher prompt injects them in a
  `<user_memory>` block — ALWAYS rendered (the empty state carries the
  save guidance; small models never call the tool unprompted).
- WRITE: the `user_memory` tool (action=save yields a `memory` wire
  event), AND `extract_insights` (ai/tools/memory.py): one
  json_completion after the settle returns BOTH durable facts and
  concept tags -- the belt-and-braces for small models that never call
  the save tool.  The `memory` / `tags` wire events trail `end` and
  pass the client's late-event gate (like `related`).  json_gate note:
  models answer "return a list" prompts with a BARE array -- `_parsed`
  wraps it into the schema's single array property.
- THE NEAR-DUP GATE (`features.memory_dedup`, cosine 0.92 shared):
  both write paths check against the stored snapshot PLUS this run's
  accepted saves (`state.saved_memories` -- a within-run repeat reads
  as duplicate too).  A save that rephrases a stored fact settles a
  `duplicate` row teaching the model to correct wording instead of
  re-saving; the extractor's facts filter in ONE batch embed (the
  small model rephrasing one fact three ways is the failure it stops).
  Fail-open everywhere: embedding unconfigured means saves behave
  exactly as before.

## vNext batch 1 (2026-10-09): deliverable entities, living plan, markdown v2

- **THE DELIVERABLE-ENTITY HEURISTIC** (the Cytiva fix): a request like
  "recommend opportunities for Cytiva on RCX's pipelines" decomposes into
  RCX facets and never researches Cytiva itself -- the answer recommends
  for an actor it never studied.  The report OUTLINE gate now sees the
  ATTACHMENT HEADS (they may bind the deliverable) and returns
  `entities: [{name, why}]` (entities the final deliverable depends on
  but no section researches); `uncovered_entities()` screens them against
  the sections with the task card's own term matcher (zero model cost).
  Uncovered entities become the researcher's `<deliverable_entities>`
  run_context block AND plan_review's `plan_complete` noul (state
  `deliverable_entities` / `entity_gap`); single-write runs get the same
  via `runs/search/entity_gate.py` (ONE jsongate extraction + term
  screen on the FIRST task_write, judgment purpose `entity_coverage`).
  The harness shows the blind spot; the MODEL closes it (add subtasks or
  delegate research_subtask) -- never auto-dispatch.
- **THE LIVING PLAN**: task_write is a full-snapshot replace (2-8 items
  after the harmonization), and the researcher prompt teaches the plan
  as a LIVING HYPOTHESIS -- revise (add/split/merge/reword/drop) by
  resending the complete list whenever cross-checking proves an earlier
  assumption wrong, and a SURPRISE (an unexpected player, a
  contradicting number, an unconsidered facet) is a plan edit, not a
  footnote; the old "system marks done automatically" coverage
  lie is gone from every prompt (statuses are the model's; the referee
  only advises).  A rewrite CARRIES PROVENANCE (`Coverage.carry_provenance`
  moves the outgoing items' gathered-sources counts onto the
  containment-matching rewrites) -- without it every re-plan flickered
  the task card's evidence back to zero.
- **MARKDOWN VOCABULARY IS A MIRROR CONTRACT** (DESIGN.md §5.1): the
  prompts teach exactly what the shared remark chain
  (`client/zjsearch/src/lib/markdownParts.ts`: GFM + ==mark== + emoji +
  callouts + deflist, math lazy) renders -- update DESIGN.md §5.1, then
  the chain, then `spine.markdown_surface()`, in that order.  Report
  sections get the same vocabulary (`SECTION_SYSTEM` composes
  `markdown_surface()`; REPORT_SHAPE carries the form doctrine: matrices
  → tables, numeric series → mermaid `xychart`, verdicts/risks →
  `[!IMPORTANT]`/`[!WARNING]` callouts).  The knowledge inspector renders
  the SAME chain (InspectorMarkdown).  Mermaid-12's chart diagram is
  registered as `xychart` -- the old `xychart-beta` name is GONE and
  falls back to a code block.  Callout styles + themed `mark` live in
  styles/base.css (token-driven, palette-flip and print safe).  Still
  deliberately NOT taught/rendered: raw HTML (untrusted model output),
  markdown images, PlantUML, Shiki.
- **SETTLE HALTS ARE MACHINE KEYS**: the server emits
  `stopped_by_user` / `wrap_grace_ended` (loop `_STOP_HALT`/`_WRAP_HALT`)
  and the client's `aiSearch/halts.ts` renders them through i18n
  (unknown halt strings stay verbatim -- legacy stored threads keep
  reading).  The writer-facing half of the wrap halt is the English
  `_WRAP_NOTE` (the model never sees a key).  Report-synthesized text
  follows the run language (the summary section title, the section-gap
  note) -- no hardcoded Chinese reaches en users.

## vNext batch 2/3 (2026-10-09): transparency, templates, fusion

- **WRITE-PHASE VISIBILITY**: the writer's reasoning surfaces as a live
  ThinkScroll strip in the answer column (single-write streaming; the
  last think step while `stage === "write"`) -- the folded research box
  no longer swallows it; after the settle it lives on in the research
  record.  PRE-FLIGHT TRANSPARENCY: clarify pre-screen + depth probe +
  outline gate ride `_drive`'s preamble as one `decisions` event -- the
  决策结果 card opens before the loop's first event (purposes
  `outline`/`clarify_gate` labeled client-side).
- **REPORT TEMPLATES**: presets live CLIENT-side
  (`aiSearch/reportTemplates.ts` -- 商业情报/尽调/竞品对比/行业综述);
  the server stays STATELESS (`parse_template` validates,
  `build_outline_from_template` adapts: the structure is binding, titles
  re-written with the question's real entities in the report language,
  `optional` sections droppable).  THE PICK IS RUN-TIME ONLY: the start
  request carries no template and the hero carries NO picker (the old
  `?template=` URL param is gone) -- the choice lives in the run rail's
  输出结构 card after the research starts (see the vNext finishers
  below).
- **PGlite**: `RunSnapshot.outline` settles into `run.meta.report`
  (title/subtitle/section statuses) -- the knowledge base knows the
  document's shape without replaying the event log.
- **OVERVIEW → DEEP REPORT**: the AI Overview card's done-state cluster
  carries a 生成深度报告 action (SPA navigate to `ai=1&mode=report` with
  the page query).  DocumentView's TOC scroll-spies (IntersectionObserver,
  upper-third band).
- **CROSS-SECTION DEDUP**: `corpus.pack(avoid=...)` demotes chunks whose
  vectors clear the shared 0.92 repeat floor against already-written
  section heads (one batch embed per section, fail-open).  The citation
  gate samples 3..6 claims by section length; the pre-write evidence
  check's face scales `max(8, min(24, sources // 5))`.
- **SEARCH QUALITY LOOP**: the ranking cascade reports `no_signal` /
  head duplicate ratio; a search that matched nothing textually or came
  back >60% near-duplicates appends a REPHRASE-ADVICE note to its own
  feed.  `RERANK_HEAD` is 30 (the whole engine fan-out rides the
  cross-encoder); searx's `result.score` joins the BM25 fusion as a
  third RRF leg (0.4 -- authority prior, tie-break only, fail-open).

## vNext finishers (2026-10-09): user templates, live structure control, report face

- **USER-DEFINED TEMPLATES** live as PGlite `kind='template'` rows
  (lib/kb/templates.ts -- the same store as the research memory, the
  owner's call over a localStorage sketch).  MANAGEMENT lives in the
  knowledge drawer's 模板 tab (`TemplateManagerPanel` -- a STRUCTURED
  editor: name + section rows: title / brief / key-questions / optional,
  add+remove, 2-10; new, edit and delete) -- library work stays in the
  library, NOT a hero dialog.  A user template and a preset reach the
  identical server adaptation gate through the same rail pick.
- **THE RAIL'S 输出结构 CONTROL**: a report run's right rail carries an
  output-structure picker while the research phase streams (deep mode,
  before `run.outline` exists) -- THE only template surface (the hero
  has none).  The card is the rail's row language: the PICKED template's
  own section list as numbered rows (可选 markers on droppable sections,
  the section count in the header; free outline = one muted state line
  `ai_output_structure_free`).  Picking POSTs `run/control
  {action:"template"}`; ControlBox holds ONE pending template and the
  SYNTHESIZER consumes it at the write boundary -- `make_synthesizer`'s
  `take_template` re-mints the outline via `build_outline_from_template`
  before the first outline snapshot streams (the client TOC follows).
  Research keeps its own ledger either way; only the document's shape
  changes.  The lane is naturally writer-safe: the consume is one-shot,
  and once the write phase owns the loop nothing reads it.
- **THE KNOWLEDGE BASE'S REPORT FACE**: `thread_head.reports` (idempotent
  ALTER + recompute from `meta->'report'` at both upserts) drives the
  directory's 报告 ×N badge, a 报告 filter chip, and the run inspector's
  reading TOC (the settled outline above the glued answer).
- **METADATA RECALL** (batch 3.3): the client's pre-run recall distills
  to `history_topics` (titles only, ≤8) and BOTH outline gates receive a
  `<prior_research_topics>` block -- build on, refresh, or differentiate
  from adjacent past work; metadata only, the researcher-feed red line
  untouched.

## Thread titles (2026-10-09): writer-generated, decision-gated, manually final

- **THE WRITER TITLES THE RESEARCH**: the related fence's contract is now
  `{"title": ..., "questions": [...]}` -- one short subject noun phrase
  (8-20 chars, answer language) written by the same completion that wrote
  the answer; report runs' title candidate is the outline editor's own
  title.  The fence parse splits `parse_related_title`; `_fence` emits a
  new wire event `title` (closed set + LATE set).
- **THE DECISION GATE** (`_SettleTail._title_pass`): ONE noul judges the
  candidate (short, specific, subject noun phrase, question's language)
  -- GOOD keeps it (no extra call), BAD/MISSING falls to one small
  generation completion (`gates.generate_title`, outline-title hint,
  fail-open).  Decision off = the candidate stands ungated; transport
  dead = the client's mechanical derive (first question clause, 24 chars)
  stands.  The judgment's tokens join `decision_usage` (deliberately NOT
  the decisions ledger -- card noise).
- **PRIORITY CHAIN** at the thread_head projection, behind the NEW
  `title_manual` lock (idempotent ALTER): manual rename > writer fence
  title > outline title > mechanical derive.  `renameThread()` sets both;
  the knowledge directory's thread rows carry an inline rename (pencil,
  Enter saves / Escape cancels) and a renamed title survives every settle.

## Custom plugin behaviour (server side, keep with the theme)

- `unit_converter` / `currency_convert`: value-less queries ("kg to lb",
  "usd to cny") convert **1** by default.  The keyword split takes the FIRST
  keyword word and answers that ONE pair, cutting the to-side at the next
  keyword: "5 usd to eur in gbp" answers usd→eur — never a later keyword's
  re-pairing (usd→gbp), and never duplicate answers.  Both ship the
  sibling-unit table so the client converter can re-pair without new
  requests.
- `advanced_search_syntax` is a query-operator POST-FILTER engine, not a
  pass-through: it parses `site:`/`-site:` (subdomain-aware), `filetype:`
  (URL path extension), `before:`/`after:` (vs `publishedDate`),
  `intitle:`/`inurl:`/`intext:`, `+term`/`-term` (each also as `/regex/`),
  `"exact phrase"` and a remaining-plain-terms OR filter, strips all of them
  — plus bang/language tokens (`!wp`, `:fr`) — from the query the engines
  receive, then enforces every constraint authoritatively in `on_result`
  regardless of engine support.  Word terms use `\b` boundaries for ASCII
  but SUBSTRING for CJK: word boundaries never fire inside unspaced CJK
  text, so `\b教程\b` would make `+教程`/`intitle:教程` drop every result
  and `-教程` exclude nothing (see `_word_matcher`).  A domain-shaped bare
  `-word` ("test -wikipedia.org") is ALSO promoted into the site-exclude
  set — the plain -word matcher runs against title+content only, so the
  domain would otherwise survive on every result whose text never spells
  it out (number-like words such as `-1.5` match the shape too, but
  promoting them excludes a host nobody has; the word matcher still runs).
  A query that cleans to nothing (a bare `site:host`) sends the
  include-domain(s) as the engine query instead of the literal operator
  string.  It must be active wherever the theme ships — the help dialog
  documents the operators — so it is enabled in
  `client/zjsearch/dev-settings.yml`; a deployment host has to enable it
  in its own settings (the upstream `searx/settings.yml` is left
  untouched by the theme).
- `bm25_reranker` (internal, bm25s): post_search BM25 reranking of the
  merged results — CJK-aware tokenization (each han character counts on
  its own, latin runs stay words, same rule as the theme's embedder),
  title tokens weighted 2x, and weighted reciprocal-rank fusion
  (BM25 1.0 vs engine order 0.25, k=60) rewriting each result's
  `positions` before the container closes.  Zero-signal guard: when no
  query term matches any result the engine order stands.  Depends on
  `bm25s` (requirements.txt).  Toggle via the preferences plugin switch;
  per-request A/B with `&disabled_plugins=bm25_reranker`.
- `time_zone`: an unknown location is silence (ValueError swallowed), not a
  plugin error.  The filler word "in" is stripped from the search term, so
  "time in tokyo" resolves like "time tokyo" instead of going silent.
- `calculator` (AI tool, `searx/zjsearch/ai/tools/calculator.py`):
  the researcher's NON-NEGOTIABLE number rule — every non-trivial figure
  (ratios, growth, averages, financial/forecast math) goes through the
  tool, never in-head; the `<calculator>` prompt block names earnings and
  forecast material explicitly.  The writer/overview have NO tools, so
  the spine's `<figures>` rule does the honest second half: derive only
  from cited inputs, keep the derivation visible, never present a
  computed number as if a source stated it.
- `view_image`(AI 工具,`searx/zjsearch/ai/tools/view_image.py`):
  研究者的眼睛——feed 来源行带 `img=` 标记,该工具抓取该图并作为下一轮
  user 消息回灌(user turn 全方言接受图片 parts)。SSRF 门校验;图片传输
  遵循 `zjsearch.llm.images` 设置(`base64` 服务端抓取内联,默认;
  `url` 直传公开引用给端点自取)。
- `stock_quote`: `$AAPL`, `AAPL stock` render the `Stock.tsx` DDG-style
  card: price hero, change with the locale's red/green convention (zh-CN:
  red up), range pills (1D/5D/1M/YTD/1Y/5Y/MAX, all series pre-fetched in
  one parallel round), prev-close reference line, last-price tag and a
  statistics grid (open/high/low/52W/P-E/market-cap/avg-volume; PE is CN/HK
  only).  Data: eastmoney first, with automatic fallback to tencent when
  eastmoney fails or does not know the listing (tencent's history
  endpoints are unreliable for non-CN/HK symbols).  60 s in-process cache;
  any resolve/fetch failure is silence.  The answer text doubles as the
  no-JS/RSS form of the quote.

## DashScope + SystemOne decision surface (alibaba families)

The SDK registry gained the DASHSCOPE family (``zjsearch.llm.sdk:
dashscope``, `llm/sdk/dashscope.py`) and the TYPEsafe decision family
(`llm/sdk/typesafe.py`): the native qwen Generation API
(thinking via ``reasoning_content``, function calling, mm auto-routing --
a parts message carrying an image turns the call into
MultiModalConversation, and ``zjsearch.llm.surface: multimodal`` forces
that surface for every turn) plus TextEmbedding through the same bound
surface (``zjsearch.embedding.sdk: dashscope``, the width rides
``params.dimension``).  base_url rides VERBATIM (a dedicated MaaS
workspace includes its own ``/api/v1``).  Wire facts, probed LIVE on a
dedicated workspace (2026-10):

- The workspace proxies the native text-generation path for its DEPLOYED
  models (qwen-plus / qwen-flash / qwen-turbo / qwen-max) plus the
  native embedding + rerank paths; a model it does not deploy answers
  the native path with a 400 ``url error`` (surfaced loudly by the
  pump).  A workspace without the native chat path still takes
  ``sdk: openai.chat_completions`` with
  ``base_url: {workspace}/compatible-mode/v1``.
- The qwen3.8/3.7 **plus/flash models are MULTIMODAL-NATIVE**: even
  text-only turns serve ONLY on the multimodal-generation endpoint (the
  text-generation path 400s ``url error`` for them) -- set
  ``surface: multimodal``.  The mm surface's native parts are
  ``{"text": ...}`` / ``{"image": <url>}`` (NO ``type`` discriminator --
  the openai-style part shape is the COMPATIBLE API's), its stream
  chunks carry ``content`` as a parts list, and it speaks tools +
  ``response_format`` + thinking natively.
- Stream fragments accumulate on ``choices[0].MESSAGE`` (never a
  ``delta``): first fragment carries id+name, later ones the
  ``arguments`` increment plus ``index``.  Idle chunks say the STRING
  ``finish_reason: "null"``.  Usage: the cache hit rides
  ``prompt_tokens_details.cached_tokens`` and a reasoning model's
  thinking spend ``output_tokens_details.reasoning_tokens`` (the
  canonical ``thoughts`` bucket).
- The reasoning echo rides the shared ``zjsearch.llm.reasoning_passback``
  flag: qwen3.8's ``preserve_thinking`` defaults true and REQUIRES the
  full history ``reasoning_content`` echo (GLM's preserved thinking the
  same; the ``preserve_thinking`` / ``clear_thinking`` knobs themselves
  ride ``params`` verbatim).
- Embeddings: the native TextEmbedding path (``params.dimension`` is
  DashScope's width key -- ``llm/config.dimensions`` reads it per
  family; ``text_type`` / ``output_type`` / ``instruct`` ride the params
  passthrough) and the MultiModal-Embedding path via
  ``zjsearch.embedding.surface: multimodal`` (input items become
  ``{"text": ...}`` parts, results key on ``index`` not ``text_index``,
  the dimension kwarg goes out only when the params set one -- several
  mm models fix their width and reject the parameter).  ``instruct`` on
  TextReRank rides ``zjsearch.rerank.extra_body``; both rerank legs
  (openai + dashscope) honor the block's ``extra_headers`` /
  ``extra_body``.
- qwen-family models IMITATE transcript-style few-shots: a
  ``User:/You:/Action:`` example block teaches them to WRITE the calls
  into their text output (ReAct text, zero native calls -- probed).
  The researcher's ``<examples>`` block is therefore RECIPES (situation +
  calls as tool semantics) plus an explicit "a call written in text
  executes nothing" line; with it qwen-plus/3.8-flash call natively 3/3.

RERANK (`zjsearch.rerank.sdk`): TWO wires -- ``dashscope`` (native
TextReRank leg, living on the DashscopeSdk family surface like
Generation / TextEmbedding) and ``openai`` (the default: the OpenAI
SDK's generic ``client.post(<path>)`` serving ANY HTTP-shape gateway --
``DEFAULT_PATH`` is ``/rerank``, the industry convention (Cohere / Jina
/ bigmodel / SiliconFlow); the dashscope compatible-api's ``/reranks``
is the documented outlier, overridden with ``path: /reranks``; the
cohere PYTHON SDK itself was evaluated and REJECTED: its fixed /v1|v2
path convention misses every gateway shape we serve).  The provider
legs live in `llm/rerank.py` (the rerank SERVICE: config + wires); the
cascade POLICY (BM25 fusion, head selection, splice) stays in
`runs/search/rank.py`.

The SystemOne DECISION capability (`zjsearch.decision`,
`llm/decision.py` + `api/decision_route.py`: ``POST
/zjsearch/ai/decision``, HMAC-gated like the embed proxy): one forward
pass answers NAMED questions about a state -- choice / score / noul,
each with its probability distribution -- no text generation.  SDK
selection pre-embedded (`sdk: typesafe`, the registry + package gate are
the seam for the next family); `judge()` returns JSON-safe answers (the
SDK's typed models downgrade through model_dump).  The dedicated
workspace serves it at ``{workspace}/compatible-mode/v1/systemone`` --
``base_url`` ends at ``.../compatible-mode`` (the SDK appends
``/v1/systemone``).

## Python CI (upstream gates for searx/ changes)

The upstream Integration workflow (`.github/workflows/integration.yml`) is the
quality gate for every engine/plugin change: `make ci.test` = yamllint,
black, pyright, pylint, unit, robot, rst, shell, shfmt + pybabel. For python
work the relevant checks are **black, pylint, nose2 unit tests** (plus an
advisory basedpyright pass). Two structural facts:

- CI triggers only on push/PR to `master` — the `zjsearch` branch is never
  CI-checked remotely. Run the checks locally before committing python
  changes; the branch once accumulated black + pylint failures (including in
  committed theme files) that went unnoticed for weeks for exactly this
  reason.
- Tool versions are pinned in `requirements-dev.txt` (black==26.5.1,
  pylint==4.0.8, basedpyright==1.40.1, nose2==0.16.0). Match the pins: a
  different black flags ~230 upstream files and buries the signal; unit tests
  run under **nose2, not pytest**.

`make`/`./manage` do not work on Windows — run the tools directly with the
venv, using the EXACT options `manage` hardcodes (`BLACK_OPTIONS`/
`BLACK_TARGETS` near the top of `manage`; pylint options in
`utils/lib_sxng_test.sh`):

```sh
# black — bare `black` is WRONG (defaults: 88 cols + quote normalization →
# massive false diffs and a corrupted style). manage's options:
local/py3/Scripts/python -m black --check --target-version py311 \
  --line-length 120 --skip-string-normalization \
  --exclude "(searx/static|searx/languages.py)" --include 'searxng.msg|\.pyi?$' \
  searx searxng_extra tests

# pylint — two passes, both must be exit-code 0. .pylintrc has NO
# fail-under override → default 10.0, so ANY warning fails CI. `traits`,
# `logger`, `categories` are engine builtins (first pass only):
local/py3/Scripts/python -m pylint --rcfile .pylintrc \
  --additional-builtins="traits,logger,categories" searx/engines
local/py3/Scripts/python -m pylint --rcfile .pylintrc --ignore-paths=searx/engines \
  searx searx/searxng.msg searxng_extra searxng_extra/docs_prebuild tests

# unit tests (needs the pwd stub below on PYTHONPATH)
local/py3/Scripts/python -m nose2 -s tests/unit

# basedpyright — advisory (CI ignores its exit value); `list[list]`-shaped
# params produce 100+ "partially unknown" warnings that are noise, skim the
# errors only for real runtime hazards
local/py3/Scripts/python -m basedpyright --level warning <changed .py files>
```

Gotchas learned the hard way:

- Piping pylint through `tail` hides its exit code (`$?` is tail's); check
  the score/exit unpiped when scripting.
- `import searx.webapp` outside the app **exits 1** unless `SEARXNG_SECRET`
  is set (default secret_key is fatal) and `SEARXNG_SETTINGS_PATH` points at
  a settings file.
- On Windows the unit suite is 339/340:
  `test_webapp.ViewsTestCase.test_search_html` fails with
  `TemplateNotFound: result_templates/default.html` — the documented
  Windows path-separator bug, not our code (`webutils.get_result_templates()`
  os.walk-joins backslashes; `webapp.get_result_template` compares forward
  slashes, so the themed path never matches and the bare fallback can't
  resolve). Linux CI is green. Prove the mechanism in one line:
  normalize `webapp.result_templates` separators, then
  `get_result_template('simple', 'default.html')` returns the themed path.

Engine changes additionally get a load smoke test through the REAL
registration path — `searx.engines.load_engine(engine_data)` takes the
settings.yml engine dict, NOT a module; it resolves imports, required
attributes, traits and categories in one shot. Rules discovered:

- Engine `name` must NOT contain underscores, or the engine is **silently
  marked inactive**: module `brave_api` must be registered as
  `name: braveapi` (etc.). No error surfaces — the engine just never runs.
- Engines whose `setup()`/`init()` probe the network need credentials at
  load: `marginalia` refuses to load without `api_key`; `brave_api` /
  `google_custom_search` load with dummy keys but need real ones for
  results.
- Data-format rules for engines: the video `length` field is a
  `datetime.timedelta` (bare int seconds render as raw numbers in
  simple/RSS — zjsearch's macros tolerate all three shapes); `thumbnail_src`
  is valid on the typed `Image` result class and on the `LegacyResult` dict
  path (with `template: images.html`); package results need
  `package_name`/`version` for `packages.html`; `python-dateutil` IS in
  requirements.txt.
- House style: no broad `except Exception` in engines (pylint W0718, no
  upstream precedent for disabling it — narrow the types instead);
  unavoidable unused args take a trailing
  `# pylint: disable=unused-argument` (see `dummy-offline.py`); a >120-char
  def line with both noqa and pylint comments violates `max-line-length`
  (drop the noqa — this repo has no flake8).

Helper scripts live outside the repo in `C:\Users\zhijie.he\Lab\zjs-stubs\`
(`pwd.py`, `smoke_engines.py` — loads every current engine and prints
LOADED/NOT LOADED).

## zjsearch performance notes

- Every content `<img>` is `loading="lazy" decoding="async"` inside an
  aspect-ratio container (no CLS); the first four result thumbnails are
  `loading="eager" fetchPriority="high"` (LCP).
- Route-level code splitting: Preferences/Stats/Info AND the whole results
  feature tree load through `src/pages/lazyPages.ts` (`React.lazy` +
  `Suspense` skeleton fallbacks in app.tsx and features/overlay/OverlayProvider.tsx);
  the results chunk is **stable-named** (`chunk/zjs-results.min.js`, see
  `manualChunks` in vite.config) and pre-warmed by an inline `import()` in
  the streamed results shell while the engines run — main.tsx additionally
  awaits it before React takes over so the three-way boot swap stays
  gapless, and the hero search box preloads it on focus for SPA searches.
  If you rename the chunk, update `results.html` in the same change.
  OpenLayers is dynamically imported only when a map result expands. Keep
  heavy features out of the eager graph. `pnpm run audit` Lighthouse-gates
  every result presentation AND the AI surfaces **fully offline** —
  audit-settings.yml reduces the engine list (keep_only) to `zjaudit`
  (searx/engines/zjsearch_fixtures.py), a deterministic offline engine
  whose fixture sets are keyed by the query token, and points
  `zjsearch.llm` at the MOCK transport (`scripts/ai-mock.mjs`, spawned by
  the gate on :8909) — the AI counterpart of the fixture engine, routing
  fixed completions by request shape (gates via
  `response_format.json_schema.name`, the researcher via `tools` presence,
  the writer via the `<follow_ups>` system marker, everything else the
  overview).  The audited AI pages: `?q=zjaudit+general&ai=1` (the full
  takeover: reasoning timeline + intent + a web_search AND a web_reader
  round -- the browser engine reads the mock's own fixture page
  (`GET /read-fixture`, reachable because audit-settings.yml exempts
  127.0.0.1 via `zjsearch.browser.allow_hosts`), exercising the real
  render+extract path, the reading-pane, the char count
  and the read-in-full badge offline -- plus the cited synthesis with an
  inline gallery strip) and
  `?q=zjaudit+general&ai_overview=1` (the classic page whose answer card
  auto-opens via the client's `ai_overview=1` deep link — Lighthouse
  cannot click).  The AI pages carry their own performance floor
  (80 desktop / 70 mobile): the NDJSON stream holds the network busy
  through the trace, so the streamed rendering phase is INSIDE the
  measurement window.  Raw LHRs + scores.json archive under
  `.lighthouse-archive/<run>/` (git-ignored) and
  `pnpm run audit:diff -- <runA> <runB>` compares two runs.  Desktop is the
  default profile, `LH_FORM_FACTOR=mobile` for mobile floors; search-page
  SEO is exempt — upstream robots.txt disallows `?q=`.  chrome-launcher
  falls back to the Microsoft Edge app bundles when no Chrome is
  installed.
- No webfonts (system font stack) and no third-party scripts; icons come
  from `lucide-react` (tree-shaken, imported directly per usage site with
  `aria-hidden`); the brand is typeset text — instance_name + accent dot —
  not an SVG mark. Never add an icon font.
- Prompt caching is designed PER DIALECT in `llm.py`, enabled by one fact:
  the system prompts are byte-stable per mode+language (stable contract
  blocks first, per-run notes last — see `_writer_messages`).  OpenAI
  dialects ride `prompt_cache_key` in extra_body on EVERY endpoint,
  bucketed per model (`zjsearch-ai/<model>`; official API groups the
  cache, OpenAI-compatible servers ignore the unknown field); Anthropic
  marks explicit `cache_control` breakpoints — LobeChat's THREE anchors:
  system block + LAST TOOL + last message (the tools spec is the run's
  biggest byte-stable prefix; 3 of the 4 allowed breakpoints, each turn
  prefix-hits at 0.1x and writes only the tail) — ON BY DEFAULT for every
  Anthropic-dialect endpoint, `zjsearch.llm.cache_control: false` is the
  opt-out for a gateway that validates strictly; Gemini runs on implicit
  prefix caching (no wire field; explicit `cachedContent` resources are a
  managed TTL/billing surface deliberately not adopted).
- Drawer/lightbox overlays render conditionally (zero cost when closed).

## Windows (Git Bash) development notes

`./manage` and `make` assume a POSIX host and **do not work on Windows**:
`utils/lib.sh` sources `/etc/os-release`, `manage` needs a `python3` command
and a POSIX venv layout (`local/py3/bin/python`), and `make` is absent from
Git Bash. To run the dev instance on Windows anyway (all outside the repo, no
Python edits — the repo policy forbids them):

- Create the venv manually: `python -m venv local/py3` (Windows layout:
  `local/py3/Scripts/`), then
  `local/py3/Scripts/python -m pip install -r requirements.txt -r requirements-dev.txt`.
- `searx/valkeydb.py` imports the POSIX-only `pwd` module at top level and
  crashes on import. Put a tiny `pwd` stub outside the repo on `PYTHONPATH`
  (working copy: `C:\Users\zhijie.he\Lab\zjs-stubs\pwd.py`).
- The app bundle URLs live at the static ROOT (`/static/zjsearch.min.js`):
  `webapp.custom_url_for` only maps a bare filename when it exists in
  `searx/static/`, so the build publishes `zjsearch.min.js`, `zjsearch.min.css`
  and `chunk/` there itself (`tools/assets.ts` closeBundle, `chunk/` rebuilt
  from scratch each build). Beware STALE root copies: they shadow every
  rebuild (a running instance keeps answering with the old ETag bytes even
  after restart-proof rebuilds — the served bundle lacks your new classes
  while the file on disk has them). On Windows the root copies additionally
  need the POSIX-path workaround below; the old manual `os.link` recipe is
  OBSOLETE since the build publishes by copy.
- Windows path separators break theme asset URLs:
  `webutils.get_static_file_list()` returns `themes\zjsearch\...` while
  `webapp.custom_url_for` compares with forward slashes, so
  `/static/themes/zjsearch/img/...` URLs 404 (works fine on POSIX).
  The bundle files above are immune (they live at the static root under
  plain names). If a themed asset URL ever 404s on Windows, check the
  separator in `get_static_file_list()` first.
- Start the app directly, mirroring `manage`'s `webapp.run` env vars:
  `SEARXNG_SETTINGS_PATH=<settings.yml> GRANIAN_INTERFACE=wsgi
  GRANIAN_HOST=127.0.0.1 GRANIAN_PORT=8888 local/py3/Scripts/granian
  searx.webapp:app` (needs the `granian[pname,reload]` extra for the
  `GRANIAN_PROCESS_NAME`/reload vars; they can simply be omitted).
- Granian workers inherit the listening socket. Killing the shell wrapper (or
  a task manager's "stop") can leave an orphan worker bound to :8888; a second
  instance can then bind the same port too (SO_REUSEADDR) and requests race
  between an old and a new server — the classic symptom is "rebuilt assets
  but the page serves stale ones". Before starting an instance, check
  `netstat -ano | grep :8888` and `taskkill //PID <pid> //F` every listener.

## Docs worth reading first

- `AUDIT.md` (repo root) — the full-theme audit playbook: environment
  bootstrap, gates, test matrix, browser measurement recipes and the
  fix→regress→docs loop. Run audits FROM that file.
- The family `DESIGN.md` (ZJBlog repository) — design tokens, fragments,
  motion and quality contract the theme must conform to.
- `client/zjsearch/README.rst` — theme architecture and workflow.
- `docs/dev/templates.rst` — result field reference (the upstream render contract).
- `docs/dev/plugins/` — server plugin registry used by the preferences UI.
