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
  render raw-text answers.

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
- The AI Overview (`searx/zjsearch/ai/overview.py`, route `POST /ai/answer`; client
  `features/results/AiSummary.tsx` + `aiAnswer.ts`): the gate is an HMAC
  token in the page-data globals, the client assembles the numbered source
  context from the payload it already has, and the endpoint streams a cited
  markdown answer (reasoning relayed wrapped in `<think>`).  As soon as
  the answer settles, every result it actually cites is marked with the
  persistent dashed accent frame — the cited source numbers are parsed
  from the settled text (`citedSourceNumbers`, same grammar and code-block
  skips as the renderer).  Clicking a citation chip scrolls to its result
  row and adds the one-shot locate tint (`data-ai-flash`, base.css); the
  marks belong to the answer that produced them — regenerate and new
  searches drop the set (ResultsPage `aiCited`).  A stream that
  dies before its first token answers 502 with a truncated upstream reason
  in the body (tags stripped — gateways answer with HTML pages), which
  fetchStream carries as the error detail and the card renders under its
  failed label. Transports are
  the official SDKs (openai chat/responses, anthropic, gemini), configured
  under `zjsearch: ai:` in settings; the API key may travel via the
  `ZJSEARCH_AI_KEY` env (dev-settings deliberately keeps it out of the
  repo). NOTE: LM Studio VALIDATES the bearer token — the placeholder
  "none" that local auth-free endpoints get is rejected with 401, so LM
  Studio deployments must set a real key. Lighthouse-critical: the
  feature adds zero bytes to the eager graph (the trigger lives in the
  results chunk; KaTeX/mermaid load only when the answer uses them).
- Both AI features run ONE agent framework (`searx/zjsearch/ai/agent.py`):
  `run_agent` drives turns over the `llm.py` transport (the four dialect
  pumps collect `think`/`delta`/`tool_calls`; a turn ends in tool calls
  only when a `tools` spec + executor are given).  The executor is a
  generator that yields feature events and MUST end with aligned
  `("tool_results", [(call, text), ...])`; the research budget is
  PROGRESS, not time or counts: max_rounds is only a safety ceiling, and
  the real termination is the stall detector -- a round that adds no new
  information (repeats/empty results) is unproductive, and
  stall_rounds consecutive unproductive rounds (1/2/2/3 by tier) end the
  research with a stale-research explanation.  TIME limits are removed
  on purpose (the model may take as long as it needs; the user's stop
  button is the control and a live 已调研 X 秒 timer the visibility;
  every engine request carries its own per-request timeout and
  per-round call counts are the MODEL's call -- uncapped, queued through
  MAX_PARALLEL slots).  An exhausted budget forces the next turn to run
  WITHOUT tools.  The forced-answer transition is EXPLAINED, never
  silent: the model gets a wrap-up message (a silently tool-less model
  emits tool-call markup as raw text -- the DSML leak) and a `wrapup`
  wire event (the client discards partial prose); a deadline cutting a
  turn mid-stream gets a grace turn that rewrites the complete answer.
  There is NO answer-review gate, on purpose (it was tried and removed):
  a second-pass reviewer's audit-voice critique leaked straight into the
  patched answer (「阅读说明/待核实/原句可核」 header blocks that read like
  an inspection report, not an answer) while rejecting drafts that were
  better than the patch -- morphic and Vane both ship quality through ONE
  reader-facing system prompt instead; `prompts.reader_voice()` is the
  anti-parroting rule that keeps the audit vocabulary out of the answer.
  Writer-phase resilience: a writer stream that closes with ZERO events
  (a 200-empty gateway body) gets ONE silent retry; a writer that
  answered in its reasoning channel only is NOT retried (the identical
  request would repeat the misroute) -- it fails the run with an
  explained error.  The failure surface
  is the CLIENT's contract -- a settled run without an answer text shows
  the failed box (reason + retry + classic fallback), never silent
  nothing (the user's stop button marks the run `stopped`, which stays
  exempt -- an intentional cut is not a failure).  The narration contract:
  the client renders CHRONOLOGICALLY -- each round's narration is its own
  intent step sitting right before that round's call rows (the model's own
  think → narration → calls order, ZCode's rhythm; an earlier one-merged-
  intent-step design flattened interleaved reasoning models into a single
  narration wall detached from its rounds).  A model that calls tools
  MID-SENTENCE reads its continuation as the next paragraph after the
  calls row it belongs to (a `plan`-tool step is kind `plan`, never a
  narration merge target), and the researcher prompt tells the model to
  finish its sentence before the calls; the writer prompt pins the
  ```related fence AFTER the complete prose (a fence-only writer once
  settled a run with suggestions but no answer).
  The clarify gate (quality/goal, first run
  only) may open a run with structured questions (`ask` wire event, run
  settles `awaiting`); the answers travel back as `clarifications` and
  the SAME run researches on.  `ThinkGate` owns the `<think>` semantics (open on first
  reasoning, close on first content, stray reasoning after content
  dropped) — the Overview's raw-text adapter and AI Search's NDJSON
  events render around that one state machine.  Multimodal (text/image
  parts) is part of the canonical message contract on `llm.py`; the
  abandoned-stream cancel discipline lives in `run_agent`'s finally.
- DEPLOYMENT (public instances): `/ai/answer` and `/ai/search` sit
  OUTSIDE upstream botdetection's `/search` burst limits, and the HMAC
  gate token ships in every page-data payload (TTL 1h) — it authenticates,
  it does not rate-limit.  A public deployment must front the AI routes
  with its own per-IP limit (reverse proxy or a custom limiter); each
  `/ai/search` drives real engine fan-outs plus a dozen LLM calls —
  and, with `web_crawler` configured, real Browserless renders (a
  browser launch per read on a server that has its own concurrency
  ceiling, typically 3).
- AI Search (the `searx/zjsearch/ai/search/` package, route
  `POST /ai/search`).  NAMING: underscore = module-private only --
  every cross-module collaborator is a public name (search/route
  imports `gates.research_gate`, `tools.tool_spec`,
  `prompts.initial_messages`, `config.budget`/`enabled`, ...);
  the AI layer's layout is INFRA + CAPABILITIES +
  FEATURES: infra lives at the `ai/` top level -- `llm/` (the LLM
  transport PACKAGE: `config` the settings surface, `security` the HMAC
  page-data token gate, `clients` the cached SDK clients, `caching` the
  request shaping + prompt-cache strategies, `usage` the canonical
  finish/usage contract, `streaming` the LlmStream queue bridge,
  `json_gate` the tiered structured-output completion, and `dialects/`
  ONE MODULE PER SDK -- openai_chat / openai_responses / anthropic /
  gemini -- behind the uniform `KIND`/`JSON_TIERS`/`pump`/`json_completion`
  interface with a `DIALECTS` registry; adding a transport is one module
  + one registry line; the package `__init__` is a FACADE re-exporting
  the whole public surface so consumers keep
  `from searx.zjsearch.ai import llm` -- naming rule: cross-module
  collaborators are public (no underscore) in their home module,
  module-internal helpers stay `_`-prefixed), `agent.py` (the loop +
  ThinkGate), `prompts.py` (the composable XML fragments + the shared
  `answer_contract` spine), `http.py` (the route prologue: authorize /
  answer_lang / streaming / 502 helpers) -- `capabilities/` holds the
  cross-feature services (`images.py` the multimodal attachments any
  feature can compose, `reader/` the page reader); each feature is a
  subpackage with a thin `__init__` re-exporting `capability` +
  `install` and its own config/tools/prompts/gates/executor/wire/route
  modules (overview: route/prompts only) -- research gate and route:
  the RESEARCHER/WRITER split (Vane's shape).  A PRE-FLIGHT GATE
  (`_research_gate`, Vane's skipSearch narrowed) runs one small JSON
  completion first: greetings, chat and writing tasks skip research
  entirely — the run emits a `direct` wire event and the writer answers
  alone (the zero-tool case of the shared loop; the client hides the
  research box); a question carrying a URL always researches (and the
  `<page_reader>` prompt rule tells the model to open that page with
  `web_crawler` FIRST instead of searching for it — Morphic's fetch-first
  rule, prompt-level like the original).  A research agent
  analyses the question, states a one-line intent, then calls the
  `web_search` tool — several calls per turn run as REAL instance
  searches (the `SearchWithPlugins` path, plugins included) in a worker
  pool whose callables are wrapped in `copy_current_request_context`
  (the search machinery needs a live request context; construct the
  search objects inside the wrapper).  Each search's results are
  serialized through the `_result_data` macro — import it via the
  public `result_data` wrapper macro (Jinja refuses underscore imports)
  and keep array separators as block-ifs — and stream as page-data-shaped
  `sources` events; researcher and writer both consume a globally
  numbered `[n]` feed (5 deep + 5 shallow per search; image-bearing
  results append `img=` URLs to the deep feed lines and register them in
  `state.gallery_pool`; the executor accumulates every block in
  `state.feed`).  A url already numbered in the run is DEDUPED in the
  feed (its existing [n] is reused — the numbering stays contiguous and
  the sources grid shows the page once).  When the research ends —
  the model stops calling tools, the ceiling/stall verdict halts it, or
  a research turn's transport dies — agent.py flies a `wrapup` event and
  a FRESH WRITER completion (`prompts._writer_messages`) writes the cited answer
  from the accumulated feed: the researcher's prose is STRUCTURALLY
  unable to leak into the answer, and the shared answer contract
  (citations/markdown/grounding/voice — the prompts.py fragments) lives
  exactly where the answer is written.  The tier split is therefore
  two-sided: `_DEPTH_RESEARCH` (round policy) prompts the researcher,
  `_DEPTH_SHAPE` (output shape) prompts the writer.  Over the 40k writer
  cap whole OLDEST feed blocks are evicted (`_fit_context`), never a
  mid-block slice (a silently cut tail could drop the source the model
  was about to cite).  The writer's system prompt is ordered
  CACHE-FRIENDLY — byte-stable blocks first (role/identity/date/language/
  shape/citations/markdown/voice), per-run variable blocks (research
  plan, halt notes) last — and `<identity>` names the engine zjsearch
  (Morphic's brand guidance: never claim to be ChatGPT/Claude/…).
  Follow-ups are
  rewritten into self-contained questions first (Vane's standalone
  follow-up: `gates._standalone_question`, one small JSON completion, fail-open
  to the original wording — the thread still shows the user's own
  question).  All four gates (research, clarify, related fallback,
  standalone rewrite)
  ride `llm.json_completion` — NATIVE structured output per dialect
  (openai chat `response_format` / responses `text.format` / anthropic
  `output_config.format` / gemini `response_json_schema`, verified
  against the installed SDKs) with Vane's belt-and-braces: a lenient
  brace-scan repair on every payload (gateways ignore output
  constraints), a `json_object` second tier for openai-family
  endpoints that reject the full schema (DeepSeek does), the plain
  streaming completion as the last tier, and a per-endpoint 400
  memory so a rejected tier is skipped on later gate calls.  The
  writer emits its follow-up suggestions IN-STREAM: a ```related fence
  at the very end of the answer (Morphic's in-stream related, with the
  Deepen/Act/Broaden intent rule and skip criteria) — `_generate`'s
  `_FenceSplitter` intercepts it (and the ```zjs-images gallery fences,
  same mechanism) so no raw fence text ever reaches the client, and the
  questions fly as a `related` event BEFORE `end`; a writer that skips
  the fence falls back to the post-`end` small completion (which is why
  that completion still exists — on reasoning models it can think for
  the better part of a minute, so the fence is the fast path).  The
  splitter holds text in BOTH states: the opener search holds 20 chars,
  the in-fence state holds 2 — a closer split across deltas (`` + `)
  must re-assemble or the body swallows prose up to the NEXT fence's
  opener (this once shipped a whole answer tail into a gallery body).
  The narration side has its own discipline: the splitter FLUSHES at
  each `calls` event (a held tail landing after the calls line would
  end up in the client's answer slice instead of the round's intent)
  and the wrapup clears the accumulated answer parts (the researcher's
  narration must not pollute the related fallback).  Gallery
  fences carry a JSON array of URLs copied verbatim from the feed's
  `img=` entries and are VALIDATED against `state.gallery_pool`
  server-side (invented URLs are dropped, an all-invalid group renders
  nothing); a valid group flies as a `gallery` event plus a
  `{{zjs-gallery:i}}` placeholder delta at its position, which
  `renderWithGalleries` (AnswerGallery.tsx) expands into a MODEST inline
  strip (small fixed-height thumbs in a wrapping row -- the sources rail
  owns the page's visual weight; a full-measure hero insert reads
  oversized) whose tiles re-use the citation jump ([n] badge, click =
  scroll to the source card).  Local models may skip the images fence
  (qwen3.6 at low effort does; the related fence it writes) — the
  degradation is silent by design.  Prompt
  organization is XML blocks end to end: prompts.py
  fragments emit `<tag>` blocks, the researcher prompt composes
  `<role>/<today>/<step_notes>/<how_to_search>/<examples>` (few-shot,
  composed from the tools THIS run registers — an example demonstrating
  an unregistered tool teaches a broken call) plus per-tool capability
  blocks.  Wire protocol: NDJSON lines
  (`think`/`delta`/`calls`/`search`/`sources`/`page`/`plan`/
  `direct`/`gallery`/`wrapup`/`ask`/`related`/`error`/`finish`/`end`); a
  stream that dies before its first
  line answers 502 like the Overview.  CHANNEL DOCTRINE (strict): the
  reasoning channel (`reasoning_content` and friends) is ALWAYS think --
  timeline material, never the answer -- and the content channel is
  ALWAYS the answer; there is NO promotion fallback (the old guard that
  promoted think as the answer once shipped the writer's chain-of-thought
  as the "report").  Every turn's pump carries the wire's `finish_reason`
  and usage (`finish` per dialect: openai chat asks `stream_options`
  include_usage with a 400/422 retry without it; responses maps
  `max_output_tokens` to `length`; anthropic maps `stop_reason`; gemini
  maps `finishReason`) -- agent.py consolidates them (LAST turn's finish
  reason = the answer's state, usage summed across turns) and yields ONE
  `finish` event before `end`; the client renders EVERY reason in the
  research header (`RunOutcome`: "length" = truncation warning, stop =
  quiet 正常完成) plus the token totals, so a truncation can never end
  silently again.  Usage is RENDER-WHAT-YOU-GET: the pumps surface
  whatever the endpoint reports -- input/output, `thoughts` (openai
  reasoning_tokens, gemini thoughts), `cached` (openai
  prompt_tokens_details.cached_tokens / DeepSeek prompt_cache_hit_tokens
  / anthropic cache_read_input_tokens / gemini
  cached_content_token_count) and `cache_write` (anthropic
  cache_creation_input_tokens) -- zero when an endpoint does not break a
  field out.  A turn that answers in its reasoning channel ONLY
  fails the run loudly (`error`: answered-in-reasoning-only) -- the
  model's thinking configuration is the user's setting and is never
  overridden to work around a misrouting template (qwen3.6 + LM Studio
  does this when enable_thinking is on; the fix is the deployment's
  extra_body, not ours).  `end` settles
  the run FIRST and `related` trails as a post-end event: the small
  completion behind the follow-up suggestions can think for the better
  part of a minute on reasoning models, and the follow-up box must not
  wait for it (the client accepts `related` after phase=done; the
  related completion itself needs `relay_reasoning=True` — with the
  channel dropped the queue sits silent through the think phase and the
  idle timeout kills the completion before any content arrives).
  The `web_crawler` tool
  (`searx/zjsearch/ai/capabilities/reader/`) reads ONE result's page in full
  through the self-hosted Browserless v2 browser (`POST /content` — a
  real Chrome, so JS/SPA pages come out complete) and feeds the model
  real Markdown from a compact lxml pipeline (main-content heuristic +
  noise/permalink-anchor stripping) converted by `html-to-markdown` —
  ATX headings, GFM tables with separator rows, code-block languages,
  inline semantics — plus a 25-link appendix the model can follow with
  further reads.  The dependency is MIT with ZERO runtime deps and a
  compiled core (requirements.txt, theme section); without it the reader
  logs a warning and degrades to the built-in walker (markdown-ish, no
  inline semantics — the pre-converter fallback lives in the same file).
  The HTTP call rides a DEDICATED network
  (`get_network("zjsearch-reader")`, falling back to the default) — the
  app-initialized DEFAULT network is HTTPS-ONLY (searx hard-codes
  `enable_http: false` into its `default_params`), so a plain-http
  Browserless — a self-hosted LAN deployment, the audit gate's mock —
  needs an `outgoing.networks.zjsearch-reader: {enable_http: true}`
  entry; https endpoints are unaffected.  `outgoing.proxies` still apply
  through the network definition.  Config = `zjsearch.ai.browserless` (`endpoint` + `key`,
  the key via the `ZJSEARCH_BROWSERLESS_KEY` env like `ZJSEARCH_AI_KEY`;
  optional `max_chars`, 12 000 default): UNCONFIGURED = the tool never
  registers (the web_search description's cross-reference is
  conditional on the same check).  Its executor shares the search
  worker pool; a read of a url already in the run's `[n]` registry
  reuses that number, a NEW url mints the next `[n]` (a `sources`
  event follows, so the answer can cite the opened page and its card
  joins the grid; favicon stays empty — the client renders the Globe
  fallback; the entry carries `crawled: true`, and a re-read of an
  already-numbered url RE-EMITS its `[n]` so the client upgrades the
  existing card in place — the 已读全文/Read-in-full badge marks the
  sources the model verified first-hand), a re-read settles
  `duplicate` without rendering again,
  and an in-process 10-min TTL cache (128 pages) absorbs repeat reads
  across runs.  `_guard_url` refuses non-public http(s) targets
  (loopback/private/link-local — `not ip.is_global` — plus
  `.local`/`.internal` hostnames): the render happens inside the
  Browserless host's network and the model is untrusted input.
  Read events ride the `page` wire event (`status`/`url`/`title`/
  `chars`); the client's call row branches on the `calls` item's
  `tool` field (`web_search` renders the query, `web_crawler` a
  host+path label and a char count) and a successful read's source
  card becomes the row's swipe strip, same as a search's.
  The `web_search` tool also takes `included_sites`/`excluded_sites`
  (Morphic's domain filters, enforced on OUR side): bare domains the
  model passes only on a user source preference ("在 GitHub 上找" ->
  ["github.com"]); the executor appends them to the query as
  `site:`/`-site:` operators, which the advanced_search_syntax plugin
  enforces AUTHORITATIVELY on every result — the timeline row displays
  the operators folded into its query label.
  The executor's round-end tool results carry the model-facing budget
  notes (Vane rebuilds the system prompt with an iteration counter every
  turn; this is the canonical-messages equivalent): one round before the
  ceiling the last feed gets "ONE research round remains", and past a
  24k feed a one-shot "context is getting large — converge" note fires.
  The `plan` tool (quality/goal tiers, agent-level like `ask_user`)
  is the answer-planning escape valve adapted from Vane's reasoning
  preamble: the model's deliberation about the SHAPE of its final
  answer goes into the tool (alone in its turn) — agent.py answers the
  turn WITHOUT executing anything (a FREE turn: no round consumed, the
  progress verdict never sees it) and yields a `plan` wire event; the
  client re-homes that prose as an intent step, and the plan text rides
  to the writer as `<research_plan>` guidance (the writer, not the
  researcher, writes the answer).
  Config: transport =
  `zjsearch.ai`; feature flags = `zjsearch.ai.search.enabled` and
  `zjsearch.ai.overview.enabled`, BOTH DEFAULTING TO TRUE — setting one
  false makes the endpoint answer 404 AND the page-data drop the
  capability (globals.ai / globals.ai_search absent), which hides the UI
  entry point (the AI Overview trigger / the [classic|AI] switch; the
  hero also ignores `?ai=1` without the capability).  AI Search needs a
  tool-capable model — gemma-4-26b-a4b-qat in LM
  Studio intermittently skips tool calls ENTIRELY and answers from
  memory even when the prompt demands a search; qwen3.6 is reliable).
  AI mode is a FULL TAKEOVER:
  `ai=1` + capability makes `stream.py` skip the raw query's engine
  fan-out entirely (`ZjsearchAiModeSearch` — an empty, instant payload;
  `globals.ai_mode` tells the client) and ResultsPage renders ONLY the
  agent experience — the `[classic|AI]` switch (`AiModeSwitch`, now
  HOMEPAGE-ONLY: it lives in the ask-card's bottom row; the results
  header dropped it, so the boot skeleton no longer mirrors it either)
  writes the
  `ai` URL/body flag (`searchParams.ts`), the homepage's AI hero is
  morphic's ask-card — SearchBox `variant="bare"` (no pill chrome, no
  submit circle) inside a bordered card whose bottom row carries the
  mode switch, the research-depth dropdown and the circular submit —
  and the depth pick travels as the `mode` URL param to seed
  `researchMode` (both hero and results page re-read `mode` from the
  URL on navigation, and `buildParams` re-emits it whenever the ai flag
  is set).  The depths are speed / balanced / quality / goal --
  speed/balanced/quality raise the research budget AND change the output
  shape (speed = ONE search round ceiling, Morphic's quick discipline,
  and one dense "what is this" paragraph with no sections;
  quality = structured "## " sections, tables, heavy citation); goal is
  the iterate-until-met tier: the model plans the evidence the target
  needs, self-checks the gap after each round and keeps searching until
  the goal is demonstrably met (16 rounds / 600s ceiling --
  every tier still ends with a forced no-tools answer), and closes with
  a GFM task-list evidence ledger.  The client parses `mode` through
  parseDepthMode (depth.tsx, single source of truth; server mirror:
  SEARCH_MODES).  ResultsPage auto-runs one
  `POST /ai/search` (`useAiSearch`, `fetchEventStream` NDJSON client;
  the classic tabs/filters/meta/suggestions/results/pagination are all
  hidden).  The page is a THREADED Vane-style layout: every question —
  the initial one and each follow-up (`followup()`, prior Q&A travels
  as history, `sources_base` continues the global [n] numbering) —
  appends an `AiSearchRunSection` behind a `border-t` divider
  (auto-scrolled into view).  Each run is TWO-COLUMN from lg
  (Perplexity's shape): the question heading, the collapsible Research
  box and the answer body keep the reading measure on the LEFT (the
  answer carries NO header row — the prose is the anchor; while the
  writer has not started, one compact "正在撰写回答…" line covers the
  silence), the cited synthesis with its inline image groups and the
  run's Related questions follow it, and the run's OWN source cards
  (skeleton until its searches settle) ride a STICKY RIGHT RAIL
  (`lg:w-72 xl:w-80` — ONE responsive markup that is a 2-column grid
  below lg and a vertical card list from lg, so the
  `[data-ai-n]` citation-jump target exists exactly once in the DOM).
  NATIVE PROGRESSIVE THINKING: the think relay (``relay_reasoning``) is
  passive for dialects that emit reasoning on their own (deepseek-style
  ``reasoning_content`` on the openai chat dialect, Responses-API
  reasoning summaries), and NATIVELY ENABLED where the API needs an
  explicit knob -- the anthropic dialect default-ENABLES extended
  thinking (budget 2048; ``params.thinking`` wins, an explicit false
  opts out, a user-set ``temperature`` suppresses the default since the
  Messages API rejects the pairing, and a gateway that rejects the
  parameter gets one automatic thinking-free retry), the gemini dialect
  folds ``thinkingConfig.includeThoughts: true`` for 2.5+ generation
  models, and the gemini dialect stamps every synthesized part with
  LobeChat's ``skip_thought_signature_validator`` magic
  ``thoughtSignature`` (replayed history without echoed signatures is
  rejected by 2.5+/3 function calling).  The JSON gates opt out of the
  native default (a raw JSON payload needs no reasoning phase).  The
  agent loop ECHOES each turn's reasoning back on the replayed history
  (canonical ``reasoning_blocks`` / ``encrypted_content`` /
  ``reasoning_items``): anthropic requires the thinking blocks + their
  signatures on tool-use turns (the pump captures them from
  ``thinking_delta`` / ``signature_delta``), and the openai chat
  dialect echoes ``reasoning_content`` (doubao's
  ``encrypted_content`` too, which takes priority) for the passback
  model families -- deepseek/glm/kimi/minimax/mimo/doubao matched on
  the MODEL id, forced on/off via ``params.reasoning_echo`` -- while
  the responses dialect echoes its captured reasoning input items
  verbatim.  LobeHub is the reference for all of it.
  The sources section keeps the ORIGINAL collapse shape -- the first
  four cards inline with the card-shaped 查看全部 toggle (favicon
  preview of what's hidden) right below them -- and the revealed list
  is a scroll box sized to EIGHT visible cards (`max-h` 17rem mobile =
  4 rows x 2 cols, 25.5rem desktop rail = 8 rows; the rest scrolls
  inside): the toggle is ALWAYS the section's last
  element (查看全部 below the inline cards, 收起 below the revealed
  list -- it never sits mid-grid), so a 90-source run reads as a
  bounded block, not an endless page.  A READ-IN-FULL card carries a
  thin amber ring (`ring-accent-soft` -- the model verified that source
  first-hand, scannable at a glance without layout shifts), and the
  read-in-full mark is an icon chip in the card's meta row riding a
  FIXED-WIDTH slot (an empty reservation on plain cards), so the [n]
  numbers right-align across crawled and plain cards alike -- never a
  full-width label bar;
  below lg everything stacks: answer, related, actions, sources.  The
  thread's follow-up
  pill floats `sticky bottom-6` above a palette fog fade (Perplexica's
  pinned input).  `useAiSearch` rebuilds a CHRONOLOGICAL step
  timeline per run (`AiSearchStep`: collapsible think segment →
  intent line → expandable parallel call rows — a settled row with
  results toggles a swipe strip of that search's result cards, fed
  from the run's registry slice; no step/time statistics are shown),
  in the model's own order; a
  round's `calls` event freezes its pending prose as the intent step.
  Think segments DEFAULT OPEN once the run settles — the inter-round
  reasoning IS the reply between the call rows (reasoning models often
  write their round commentary into the reasoning channel only, so a
  collapsed-by-default timeline reads as calls with nothing between);
  while streaming only the LIVE round's segment stays open, and
  ThinkScroll caps each segment at `max-h-40` so the volume stays
  bounded.  Prose after the first `calls` streams into the answer live AND is
  held as the turn's pending slice — when the turn's own `calls` land,
  that slice is split back out of the answer into the intent step, so
  the settled answer is the final synthesis alone.  State-discipline
  trap learned the hard way: EVERY event handler in `applyEvent` that
  touches `runs` must return `{...core, runs}` — returning `core`
  discards the freshly built array (React bails out on the identical
  reference) and the event silently never applies (this once froze all
  call rows at "searching…" and starved the sources grid, whose
  `sources` event case had also been dropped outright).
  `ai=1` WITHOUT the capability (hand-crafted URL,
  feature switched off) falls back to the classic page client-side;
  the server-side skip only fires when the capability exists.  The raw
  results are deliberately NOT fed to the agent as a seed — reference
  material makes it skip searching (live-verified).  LM Studio +
  qwen3.6 note: enable_thinking must be off via extra_body, otherwise
  the model routes the whole answer into the reasoning channel; gemma-4
  ignores that knob and streams a reasoning channel regardless (harmless
  — think segments render in the Research timeline).
- AI SESSIONS are LobeHub-style CONVERSATIONS: every run lives in a
  browser-stored THREAD identified by a uuid — the takeover (`?ai=1`)
  mints one on start and `history.replaceState`s its canonical address
  `/ai/thread/<uuid>` (`ai/search/page.py` + `ai_thread.html`: a slim
  server shell carrying fresh capability tokens and nothing else).  The
  thread (runs, sources, usage) persists in localStorage ONLY
  (`lib/threadStore.ts`: one key per thread + an index, LRU ~20,
  quota-evicting oldest-first) — the server stays stateless (`POST
  /ai/search` logs the optional `thread` field for problem localization
  and forgets it).  A reload or a history-drawer revisit lands on the
  thread route and restores via `useAiSearch.resume` (pending calls
  settle as interrupted; an awaiting clarify never survives).  The
  drawer (`AiHistoryDrawer`) lists/opens/deletes threads from the
  takeover composer row and the thread page; deleting is permanent and
  browser-local by design (never syncs across devices).
- The boot skeleton (`zjsearch/skeleton.html` + the `.zjs-boot` block in
  `src/styles/boot.css`) is a **geometry mirror of the real results page**, not an
  invented loading screen — it only covers the JS-boot window (server flush →
  module executes) and must share every layout decision with `ResultsPage`:
  brand hidden <30rem, container `px-4 sm:px-6`, query pill with `shadow-card`
  and max-widths 42/48/56rem (base/xl/2xl), ghost HeaderActions circles, ghost
  category-tab (first tab amber-underlined) + filter rows, card bars in the
  exact `ResultSkeleton` rhythm (url / mt-1 title / mt-1.5 snippet ×2 / mt-2
  engines pill), right rail reserved width-only (20rem at lg, 24rem at xl).
  The three-way swap static skeleton → React pending → real results must never
  shift layout: change `skeleton.html`, the `.zjs-boot` CSS and
  `ResultSkeleton` together in one change, and re-verify at mobile / lg / xl
  widths (a no-JS preview of the streamed early chunk up to
  `<!--zjs-shell-->` with the scripts stripped keeps the skeleton on screen).

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
- About/Stats/Preferences open as slide-in drawers
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
  ResultRow, cards/, answers/, image/, grids, infobox/debug/suggestions),
  `hotkeys.ts`, `calculator.ts`.
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
answers: `parsed_url` is null there).  Suggestions render as a single-row
chip strip
under the results meta line (`SuggestionsBox`, all breakpoints): chips
are single-line truncated, the row pages via ‹ › ghost arrows that stay
persistent (disabled at the ends and when the row fits, so flipping state
never shifts the chips; uncapped — paging handles any count, honors
`prefers-reduced-motion`); the right rail never hosts suggestions.

Query-term highlighting (`.highlight` in `styles/base.css`) is a tinted
background only — color marks the term, no bold.

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
- `time_zone`: an unknown location is silence (ValueError swallowed), not a
  plugin error.  The filler word "in" is stripped from the search term, so
  "time in tokyo" resolves like "time tokyo" instead of going silent.
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
  `zjsearch.ai` at the MOCK transport (`scripts/ai-mock.mjs`, spawned by
  the gate on :8909) — the AI counterpart of the fixture engine, routing
  fixed completions by request shape (gates via
  `response_format.json_schema.name`, the researcher via `tools` presence,
  the writer via the `<follow_ups>` system marker, everything else the
  overview).  The audited AI pages: `?q=zjaudit+general&ai=1` (the full
  takeover: reasoning timeline + intent + a web_search AND a web_crawler
  round -- the same mock server answers the reader's `POST /content` with
  a fixture document, exercising the reading-pane path, the char count
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
  Anthropic-dialect endpoint, `zjsearch.ai.cache_control: false` is the
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
