# AGENTS.md

Guidance for AI agents working in this repository.

## Repository

Fork of [SearXNG](https://github.com/searxng/searxng) (metasearch engine, Python/Flask + Jinja2).
Current working branch: `skin`. The purpose of this fork is the custom theme
**zjsearch** — a from-scratch React + TypeScript UI — alongside the upstream
`simple` theme. Python changes are the exception, not the rule: only make them
when the user explicitly asks (e.g. the structured `data` payloads that
special-query answers carry for the theme — see
`searx/result_types/answer.py` and the hash/self-info/time-zone plugins plus
the random/statistics answerers).

Licensing: every theme-authored file — client sources and tools,
`searx/templates/zjsearch/`, and our python additions
(`searx/plugins/stock_quote.py`, `searx/zjsearch_stream.py`, including all
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
make themes.zjsearch        # npm install + vite build -> searx/static/themes/zjsearch
make themes.zjsearch.lint   # biome check + tsc --noEmit (run inside client/zjsearch)
make themes.zjsearch.dev    # vite dev server (HMR), proxies API calls to :8888
make run                    # dev instance on http://127.0.0.1:8888 (granian, reloads ./searx)
npm run audit               # Lighthouse gate (inside client/zjsearch): boots its own instance
                            # on :8907 with audit-settings.yml and thresholds per category/page
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
  `searx/static` — as an ignored `zjsearch-theme.patch` for `git apply` + `npm run
  build` on the target. Templates and python must ship together: new templates
  reading `answer.data` against old python only log jinja2 Undefined warnings and
  render raw-text answers.

## zjsearch architecture (Page-Data pattern)

The server renders **no UI**. Every zjsearch Jinja template is a thin shell that
serializes the render context into `<script id="page-data" type="application/json">`
and boots `zjsearch.min.js`; React renders 100% of the interface.

- Search HTML responses **stream** (`searx/zjsearch_stream.py`, registered by a
  single `install(app)` + before_request hook appended at the end of
  `webapp.py` — the upstream file is otherwise untouched so rebases stay
  conflict-free): the head + static boot skeleton (`zjsearch/skeleton.html`,
  inside `#app` via base.html's `app_skeleton` block) flush immediately and
  the app **boots right away** into a pending payload (`#boot-data`,
  `page_boot` macro, `pending: true` — `import()` from a classic inline
  script evaluates before the document finishes parsing), so the header and
  search box are interactive while the engines run. The late chunk emits the
  real payload through `#page-data` (`results.html` reads search data only
  through the lazy `streamed` runner — first property access triggers the
  search) plus a notify script; `RouterProvider` consumes the pushed payload
  (`window.__zjsPageData` / `zjs:page-data` event) and never re-fetches.
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
  must implement it fully; every other locale falls back to English. Add new
  keys to `en.ts` first (then the other catalogs), render via `useT()` /
  `t("key")` — unknown keys are compile errors. Adding a language = one new
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
- Theme style light/dark uses the `simple_style` cookie; `black` is OLED black
  (html gets both `dark` and `black` classes). Auto = no cookie + system setting.
  The html class is set by an inline script in `base.html` and mirrored by
  `applyThemeStyle()` in `client/zjsearch/src/lib/theme.ts` — keep both in sync.
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
  transitions/animations, but JS-initiated smooth scrolling (BackToTop,
  hotkey navigation, suggestion pager) must pass `scrollBehavior()` from
  `src/lib/motion.ts` as its `behavior` — the stylesheet cannot reach it
  (the module also exports `reducedMotion()` for durations).
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
  empty slots for those. All text cards share the margin language
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
- 20px `text-xl`: infobox title; 24px `text-2xl`: page headings; section
  headings in between are `text-base`/`text-lg` `font-semibold`.
- Brand marks: hero `text-6xl/7xl`, header `text-xl`, both `font-extrabold`
  (the brand dot span is `text-accent` — readable in every palette).
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
  mounted). Apply the spacing margin CONDITIONALLY on the Collapse wrapper
  (`open ? "mt-2" : ""`) — a static margin under a folded panel reads as a
  stray gap. Triggers keep `aria-expanded` + the rotating chevron. Native
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
  every tab switch (`key={tab}` remount). Dismissals stay instant-unmount
  by design (no exit animations anywhere).

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
- Cap-and-expand chip rows ("show 3 + N") use `lib/useCapExpand.ts`
  (EnginesLine "+N", paper/package tags, weather sources) — callers render
  their own chips, the hook owns the visibility state machine.
- Thumbnail load state is `useGraceThumb` (Tile.tsx): 12s hung-request
  grace, shared by grid tiles and the image masonry; the first four cells
  of a page are `eager` + fetchPriority high (page-global index via
  `indexOffset`).
- Tile anatomy extras live in `features/results/Tile.tsx`:
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
  `features/results/Tile.tsx` — every grid cell renders through `TileCell`
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
rail frees the column and the container-query grids widen into it. The
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
bar, seconds column aligned); the panel starts expanded when there are
zero results.  Infinite scroll never engages on a zero-result page (the
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
  Dark mode there is `prefers-color-scheme` (no JS to set classes).
- Radii follow the app scale (cards 16px = rounded-2xl), the wordmark is
  1.25rem/800 like the header brand, and the brand dot is `.dot`
  (accent), not an ad-hoc class.
- Strings are English-only by design: the no-JS templates have no i18n
  mechanism (adding per-server-locale template variants doesn't scale);
  the React surface owns localisation for every JS locale.  Never wire
  searxng's gettext catalogs into zjsearch chrome, on the server side
  either.

## Custom plugin behaviour (server side, keep with the theme)

- `unit_converter` / `currency_convert`: value-less queries ("kg to lb",
  "usd to cny") convert **1** by default; a keyword split stops at the
  first match (no duplicate answers).  Both ship the sibling-unit table so
  the client converter can re-pair without new requests.
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
  and `-教程` exclude nothing (see `_word_matcher`).  A query that cleans
  to nothing (a bare `site:host`) sends the include-domain(s) as the engine
  query instead of the literal operator string.  It must be active wherever
  the theme ships — the help dialog documents the operators — so it is
  enabled in `client/zjsearch/dev-settings.yml`; a deployment host has to
  enable it in its own settings (the upstream `searx/settings.yml` is left
  untouched by the theme).
- `time_zone`: an unknown location is silence (ValueError swallowed), not a
  plugin error.
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
  heavy features out of the eager graph. `npm run audit` Lighthouse-gates
  every result presentation **fully offline** — audit-settings.yml reduces
  the engine list (keep_only) to `zjaudit`
  (searx/engines/zjsearch_fixtures.py), a deterministic offline engine
  whose fixture sets are keyed by the query token; raw LHRs + scores.json
  archive under `.lighthouse-archive/<run>/` (git-ignored) and
  `npm run audit:diff -- <runA> <runB>` compares two runs.  Desktop is the
  default profile, `LH_FORM_FACTOR=mobile` for mobile floors; search-page
  SEO is exempt — upstream robots.txt disallows `?q=`.
- No webfonts (system font stack) and no third-party scripts; icons come
  from `lucide-react` (tree-shaken, imported directly per usage site with
  `aria-hidden`); the brand is typeset text — instance_name + accent dot —
  not an SVG mark. Never add an icon font.
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
  crashes on import. Put a tiny `pwd` stub outside the repo on `PYTHONPATH`.
- Windows path separators break theme asset URLs:
  `webutils.get_static_file_list()` returns `themes\zjsearch\...` while
  `webapp.custom_url_for` compares with forward slashes, so `/static/zjsearch.min.js`
  is served unmapped and 404s (works fine on POSIX). Workaround: hardlink the
  built assets into `searx/static/` — `zjsearch.min.js`, `zjsearch.min.css`
  AND the whole `chunk/` directory (vite splits lazy pages into it; the
  preferences chunk landing there makes the preferences drawer 404 without
  this step). Sync everything after EVERY rebuild (vite replaces the target
  files, breaking the links); they are untracked and git-ignored. `mklink`
  backslash escaping is unreliable from Git Bash — use Python `os.link`:
  `local/py3/Scripts/python -c "import os,shutil;src='themes/zjsearch/chunk';dst='chunk';shutil.rmtree(dst,ignore_errors=True);os.makedirs(dst);[os.link(os.path.join(src,f),os.path.join(dst,f)) for f in os.listdir(src)]"`
  (run inside `searx/static`). Junctions (`mklink /J`) do NOT work —
  WhiteNoise's directory walk skips them. Symptom of a stale link: curl the
  URL and get HTML instead of JS. See `HANDOVER.md` for the full recipe.
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

- `client/zjsearch/README.rst` — theme architecture and workflow.
- `docs/dev/templates.rst` — result field reference (the upstream render contract).
- `docs/dev/plugins/` — server plugin registry used by the preferences UI.
