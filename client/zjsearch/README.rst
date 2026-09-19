=====
zjsearch
=====

A from-scratch React + TypeScript UI theme for SearXNG, named **ZJSearch**.

Unlike the bundled ``simple`` theme (server-rendered HTML progressively
enhanced with TypeScript), zjsearch renders **100% of the UI in React**.
The SearXNG server keeps rendering every page, but the theme's Jinja
templates are thin *data shells*: they serialize the full render context
into a JSON payload (``<script id="page-data" type="application/json">``)
and boot the React bundle. No Python files are modified — the theme is
purely additive and survives upstream upgrades.

Architecture
============

- **Page-Data pattern** — every view template
  (``searx/templates/zjsearch/*.html``) emits the server context as JSON
  via macros in ``data/macros.html``. Server-side filters
  (``image_proxify``, ``favicon_url``, ``get_pretty_url``, query
  highlighting, ``engine_data`` for pagination) are applied during
  serialization, so the React client inherits the complete data pipeline
  without any backend changes.
- **Client-side navigation** — the React router (``src/lib/router.tsx``)
  fetches the same ``/search`` / ``/preferences`` / … URLs, extracts the
  embedded ``page-data`` JSON from the HTML response and swaps the page
  via ``pushState``. A progress bar + skeletons cover the wait. Search
  parameter encoding/decoding and the page fetch live in
  ``src/lib/searchParams.ts`` so the GET URL, the POST form body and the
  infinite-scroll pager stay in sync.
- **Overlay panels** — About/Stats/Preferences open as slide-in drawers
  (``src/features/overlay/``). The panel knows the drawer chrome and the
  fetch plumbing only; which page renders which payload is injected by
  ``app.tsx`` (``renderPage``), so the overlay never imports pages.
- **i18n** — the theme owns its UI string catalog
  (``src/lib/i18n.ts`` + one file per locale in ``src/lib/i18n/``):
  English (``en.ts``) is the source and defines the ``StringKey`` union,
  so ``t()`` calls and every translation are checked at compile time.
  Adding a language = one new catalog file + one registry entry — see
  *Code organization & conventions* below.
- **Preferences** — the settings UI builds a ``FormData`` that mirrors the
  upstream ``parse_form`` semantics (absent booleans are false, the
  ``engine_<name>__<category>`` / ``plugin_<id>`` keys are REVERSED — a
  posted key marks that engine/plugin as *disabled* — and every omitted
  key is re-enabled) and POSTs it to ``/preferences``. All form state and
  the debounced auto-save live in the ``usePreferencesForm`` hook.
- **Stack** — React 19, TypeScript, Vite (rolldown), Tailwind CSS v4
  (warm Kagi-inspired palette, light/dark/auto via the ``simple_style``
  cookie), Biome for lint/format.

Design system
=============

The visual language is tokenized and audited; keep new UI on these rails
instead of inventing sizes/colours:

- **Type scale** — one size per role: 12px ``text-xs`` meta/chips/mono
  chrome, 13px ``text-[13px]`` interactive controls (tabs, dropdowns,
  pills, suggestions) and dialog copy, 14px ``text-sm`` body text and
  settings rows, 16px ``text-base`` result titles + search inputs,
  20px infobox title, 24px page headings. Weights: ``font-extrabold``
  brand only, ``font-semibold`` headings, ``font-medium``
  emphasis/selected, body regular. Card margin rhythm: ``mt-1`` title &
  meta, ``mt-1.5`` snippet & tags, ``mt-2`` engines row. Answer values
  are tiered (4xl calculator/stats heroes, xl time/translation heroes,
  ``text-sm`` ``font-mono`` copyable values) — pick the tier, don't
  invent a size.
- **Colour tokens** — only the ``--*`` custom properties from
  ``styles/tokens.css`` (``bg``/``surface``/``surface-2``/``line``/
  ``ink``/``ink-2``/``ink-3``/``accent``*``/``danger``/``warning``/
  ``ok``). Every ink token keeps ≥4.5:1 against every surface in all
  three palettes (light / ``.dark`` / ``.black`` OLED). Rules that keep
  the palettes in sync: ``accent`` is the light-mode *text* accent
  (``#8c6800``, AA on white/surface-2/accent-soft); ``accent-strong`` is
  a fill/border accent only — text on an ``accent-strong`` fill is always
  ``accent-contrast`` (including hover states over dark media chips);
  fixed-dark media chrome (lightbox, tile badges, scrims, map graphics)
  is intentionally theme-independent and says so in a comment at its
  definition site.
- **Grid density via container queries** — the results column is an
  ``@container``; every grid keys its column count off the *column*
  width (``@[24rem]``/``@[40rem]``/``@[46rem]``/``@[54rem]``/``@5xl``
  steps), so widescreen mode (90rem cap) grows a column, centered mode
  (72rem) drops one, and the sidebar/empty-rail changes re-flow grids
  automatically. New grids must use container variants, not ``sm:``/
  ``xl:`` viewport breakpoints.
- **Icons** — lucide-react, imported per usage site with
  ``aria-hidden``; 18px (``size-4.5``) in 36px round buttons, 14px
  (``size-3.5``) leading icons in tabs/pills, 12px (``size-3``) inside
  meta rows and chips, 20px (``size-5``) in large round buttons. Same
  concept = same icon everywhere (Search submits, X dismisses, Check
  confirms copy, ExternalLink leaves the site, ChevronDown discloses).
- **Motion** — entrance/exit animations use the ``animate-*`` theme
  tokens only; every JS-initiated scroll passes ``scrollBehavior()``
  (``lib/motion.ts``, also exports ``reducedMotion()``); the stylesheet
  guards ``prefers-reduced-motion`` for CSS.
- **Accessibility** — global ``:focus-visible`` outline (never remove it
  without an equivalent ring); icon-only buttons always carry an
  ``aria-label``; modal dialogs (drawer, lightbox, help modal) mount
  through ``useDialogFocus`` (``lib/dialogFocus.ts``) with a
  ``data-dialog-close`` control — focus moves in on open, is trapped
  inside via Tab and restored on close; listbox options carry
  ``role="option"`` on the interactive element itself, never a parent
  ``li``; touch targets keep WCAG 2.5.8's 24px minimum (28px+ in
  practice).
- **Shared class fragments** — recurring Tailwind strings live in
  ``lib/styles.ts`` (``SCROLLBAR_NONE``, ``SWIPE_ROW``, ``META_ROW``,
  ``CHIP``, ``MONO_CHIP``, ``ICON_BTN``, ``DISABLED``, ``TILE_BADGE``,
  plus ``reliabilityColor()``); import them instead of re-typing the
  mega-strings. All HTTP calls go through ``lib/http.ts``
  (``fetchText``/``fetchJson``, uniform ``HTTP <status>`` errors). Copy +
  confirm is one idiom: ``useCopyToast()`` from ``lib/clipboard.ts``.
- **Floating feedback** — one-shot confirmations that own no render loop
  (hotkey yank, the preferences auto-save) call ``flashToast()`` from
  ``lib/toast.ts``: a stacked, auto-dismissing pill fixed at the bottom of
  the viewport with configurable ``tone`` (``ok`` for every copy/save
  confirmation, ``accent`` neutral, ``danger`` failure) — never render such
  feedback in flow, it would shift the page. Every copy action confirms
  through the green toast; no component keeps its own inline "copied"
  state.

Layout of this workspace
========================

.. code:: text

   client/zjsearch/
   ├── dev-settings.yml     # local instance settings (default_theme: zjsearch)
   ├── audit-settings.yml   # instance settings for the Lighthouse gate (public headers)
   ├── scripts/audit.mjs    # `npm run audit`: boots an instance on :8907 and
   │                        # Lighthouse-gates the key pages per category
   ├── vite.config.ts       # build -> searx/static/themes/zjsearch, dev proxy, @ alias
   ├── tools/assets.ts      # rasterizes brand SVGs into favicons/PWA icons
   └── src/
       ├── main.tsx         # boot: parse page-data + client_settings, mount
       ├── app.tsx          # providers + page switch + overlay panel registry
       ├── styles/            # global.css single entry + partials by consumer:
       │                      # tokens (palettes/@theme), base (element
       │                      # defaults + .highlight), noscript + boot
       │                      # (server-rendered faces), prose, behaviors
       │                      # (motion/width), map (OpenLayers chrome)
       ├── lib/             # app-wide foundations (no UI): types (server
       │                    # contract), pageData, searchParams, router,
       │                    # i18n/, categories, cookies, settings, theme,
       │                    # format, link, motion, http, dialogFocus,
       │                    # clipboard, engineDescriptions, styles (shared
       │                    # class fragments)
       ├── components/      # shared UI used across pages: Shell, Link,
       │                    # SearchBox, SearchControls, Dropdown, …
       ├── features/        # one dir per cohesive feature domain:
       │   ├── overlay/     #   drawer chrome + plumbing (panels injected)
       │   ├── results/     #   result views: layout detection (layout.ts),
       │   │                #   cards/, answers/, image/, grids, infobox,
       │   │                #   blocks, CategoryBlocks/ResultsView, …
       │   ├── hotkeys.ts   #   results keyboard navigation
       │   └── calculator.ts
       └── pages/           # route composition roots (thin):
           ├── IndexPage / ResultsPage / StatsPage / InfoPage
           ├── preferences/ #   PreferencesPage + usePreferencesForm +
           │                #   parts + tabs/ (one component per tab)
           └── lazyPages.ts #   React.lazy route chunks

Lighthouse audit
================

``npm run audit`` is the theme's quality gate — **fully offline**.  It
boots a throwaway instance on ``127.0.0.1:8907`` whose engine list is
reduced to ``zjaudit`` (``searx/engines/zjsearch_fixtures.py``): a
deterministic offline engine serving fixed result sets keyed by the query
token (``zjaudit general|images|videos|music|files|science|apps``).
Remote engines would make the audited pages variance-sensitive —
timeouts, captchas and dead image URLs change the page between runs.

The gate then runs Lighthouse over the home page plus one page per result
presentation (general list, image masonry, video/music/apps grids,
torrent grid, science papers, IT packages) and fails when a category
drops below the thresholds in ``scripts/audit.mjs``.  Raw reports and a
``scores.json`` summary are archived under
``client/zjsearch/.lighthouse-archive/<run>/`` (git-ignored); compare two
runs with ``npm run audit:diff -- <runA> <runB>``.

Notes:

* Desktop is the default profile (``LH_FORM_FACTOR=mobile`` opts into the
  harsher mobile throttling with its own floors).
* Search pages' SEO category is *exempt* on purpose: upstream's
  ``robots.txt`` disallows ``/*?*q=*`` — search pages are meant to stay
  unindexed.  The audit instance presents an indexable ``X-Robots-Tag``
  (the upstream default ``noindex`` would otherwise cap the home page's
  SEO category too).
* Needs the venv (``local/py3``) and a Chromium; set ``CHROME_PATH`` when
  chrome-launcher does not autodetect yours.
* The results feature tree ships as a **stable-named** chunk
  (``chunk/zjs-results.min.js``, see ``manualChunks`` in vite.config) so
  the streamed results shell can pre-warm it with an inline ``import()``
  while the engines run. If you rename that chunk, update
  ``results.html`` in the same change.

Code organization & conventions
===============================

Layering (dependencies only point downwards):

- ``lib/`` — foundations: data contract, i18n, routing, cookies, format.
  Never imports from ``components/``, ``features/`` or ``pages/``.
- ``components/`` — UI shared by more than one page.
- ``features/<domain>/`` — everything only one feature domain needs,
  colocated (views + pure logic + hooks). Results presentation is the
  biggest one; ``layout.ts`` holds the category→presentation detection as
  a pure, unit-testable function.
- ``pages/`` — composition roots: state, event handlers, layout wiring.
  Page-private pieces live next to the page (``preferences/``).

Naming:

- Components: PascalCase file named after the file's primary export, one
  primary component per file (private helpers may share the file).
- Hooks: ``useXxx.ts``.
- Pure logic / catalogs: camelCase ``.ts`` (no JSX → ``.ts``).
- Locale catalogs: named after their BCP-47 tag (``en.ts``, ``zh-CN.ts``).

Adding a UI language takes two edits: create ``src/lib/i18n/<tag>.ts``
exporting a ``Record<StringKey, string>`` (a ``Partial`` is fine —
missing keys fall back to English) and register it in ``CATALOGS`` inside
``src/lib/i18n.ts`` plus a mapping in ``themeLocaleTag()``.

Imports use the ``@/`` alias (Vite + tsc) instead of deep relative
paths; module boundaries export only what other modules need.

Build & development
===================

.. code:: sh

   make themes.zjsearch        # npm install + vite build (into searx/static/themes/zjsearch)
   make themes.zjsearch.lint   # biome check + tsc --noEmit
   make themes.zjsearch.dev    # vite dev server (HMR), proxies API calls to
                               # a local instance; start the instance with:
                               # SEARXNG_SETTINGS_PATH=client/zjsearch/dev-settings.yml ./manage webapp.run

The dev server proxies ``/search``, ``/autocompleter``, ``/preferences``,
``/image_proxy``, … to ``http://127.0.0.1:8888`` (override with
``ZJSEARCH_BACKEND``), so the UI can be developed against a live backend.

Selecting the theme
===================

The theme becomes selectable by merely existing (a template directory is a
theme). Set it as default in your ``settings.yml``:

.. code:: yaml

   ui:
     default_theme: zjsearch

or pick *ZJSearch → Theme* in the preferences UI.

Feature checklist (parity with ``simple``)
==========================================

- Search box with debounced autocompleter (keyboard navigation), clear
  button, ``dir="auto"`` queries
- Category tabs (single select / shift-click multi select, honoring
  ``search_on_category_select``), language / time range / safesearch
  filters that re-search on change
- All 11 result layouts (default, images, videos, torrent, map, paper,
  packages, code, file, keyvalue, products) + answers (legacy,
  translations, weather), corrections, suggestions, infobox with related
  topics, engine messages with response-time bars, permalink box (POST
  mode), download-results links
- Image results: masonry grid for image-only pages, lightbox with
  keyboard/swipe navigation and ``#image-viewer`` back-button dismissal,
  proxified thumbnails with error fallback
- Numbered pagination window + plugin-gated infinite scroll,
  back-to-top
- Preferences: all six tabs, engine table with reliability/response
  stats and lazy engine descriptions, plugins, tokens, cookie list,
  preferences share/copy/restore, preview banner, reset defaults
- Stats: sortable table with bar charts + per-engine error logs
- Info/about pages, 404, OpenSearch XML, RSS (rendered server side),
  PWA manifest and icons
- Light/dark/auto theme with quick toggle (``simple_style`` cookie),
  RTL support via logical properties, ``prefers-reduced-motion`` support
- Client plugins gated by ``client_settings.plugins``: infinite scroll,
  calculator*, map results with lazy-loaded OpenLayers embed

\* calculator render is handled by the server answerer; client plugin
parity is on the roadmap.

License
=======

The zjsearch theme is released under the Apache License 2.0 with
Commons Clause v1.0 — see ``client/zjsearch/LICENSE.txt`` for the full
text. The license is also linked from the site footer.

