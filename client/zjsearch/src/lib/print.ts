// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * The shared print pipeline: clicking 📄 builds the print document (the
 * wordmark, the optional injected heading, the cloned rendered content
 * with chrome stripped, the numbered sources expanded at the tail) and
 * opens the browser's print dialog — "Save as PDF" from there yields a
 * selectable, editable, system-font PDF.  The document lives under
 * #zjs-print-view-root, hidden on screen; on print everything else
 * disappears and print.css's registered-token force renders the sheet in
 * the LIGHT theme on a pure-white ground.  Mermaid is the one component
 * whose colors are BAKED into the svg, so dark diagrams are re-rendered
 * off-screen in the neutral theme before the build — the live page's DOM
 * never changes and nothing flashes.  The dialog closing (done or
 * cancelled) tears the view down.  Family contract DESIGN.md §5.3: the
 * ZJBlog print pipeline (startPrintPreview) is this module's sibling.
 * Consumer: the knowledge inspector.
 */

export interface PrintSource {
  n: number;
  title: string;
  netloc: string;
}

export interface PrintOptions {
  /** the printed heading line + the saved PDF's filename base
      (zjsearch_<safe>.<fileTag>) */
  title: string;
  /** the filename suffix (the thread page passes its 8-char id) */
  fileTag?: string;
  /** an injected serif heading between the wordmark and the content —
      for sources whose clone does not already carry one */
  heading?: string | null;
  source: HTMLElement;
  sources: PrintSource[];
  /** the localized caption above the sources tail (the UI's own section
      label -- the document reads like the view that produced it) */
  sourcesLabel?: string;
  /** the preview close chip's localized aria-label/title (ZJBlog's
      startPrintPreview carries the same) */
  closeLabel?: string;
  /** extra selectors stripped from the clone (beyond .zjs-print-hide and
      the buttons-outside-.zjs-answer-body rule) */
  dropSelectors?: string[];
  /** a muted line under the close chip: embedded webviews silently no-op
      window.print() -- the paper face is the terminal state there, so tell
      the user to output the content from the browser's Print menu */
  hint?: string;
  /** the paper the clone lays out on: "a4" (default -- portrait sheet,
      the injected wordmark/heading chrome, print.css's @page) or "deck"
      (16:9 landscape sheets, one slide per page via the clone's own
      marpit @page re-asserted AFTER print.css, no injected chrome -- the
      deck's cover slide IS the title page; the sources tail starts on
      its own sheet).  Decks printed through the a4 path collapse into
      portrait pages with half-empty sheets and a near-blank page 1. */
  paper?: "a4" | "deck";
}

/** Returns the view's dispose function (an effect's cleanup): the dialog
    closing tears the injected document down. */
export function printDocument(options: PrintOptions): () => void {
  const {
    title,
    fileTag = "",
    heading = null,
    source,
    sources,
    sourcesLabel = "",
    closeLabel = "Close",
    dropSelectors = [],
    hint = "",
    paper = "a4",
  } = options;
  const deckPaper = paper === "deck";
  // a chart whose live render never ran (below the fold -- the viewport
  // gate) or whose colors are baked dark needs a neutral re-render BEFORE
  // the clone snapshots; a placeholder box cloned as-is is the empty grey
  // rectangle the paper used to show
  const mermaidBlocks = [...source.querySelectorAll("[data-zjs-mermaid]")];
  const darkTheme =
    document.documentElement.classList.contains("dark") || document.documentElement.classList.contains("black");
  const needsDiagramRender = mermaidBlocks.some((el) => darkTheme || el.querySelector("svg") === null);
  const root = document.createElement("div");
  root.id = "zjs-print-view-root";
  root.className = "zjs-print-sheet";
  document.body.classList.add("zjs-print-view");
  // the saved PDF's filename comes from the document title -- mirror the
  // MD export's naming: zjsearch_<safeTitle>.<fileTag>
  const prevTitle = document.title;
  const safeTitle =
    title
      .replace(/[/\\:*?"<>|]+/g, "_")
      .trim()
      .slice(0, 64) || "zjsearch";
  document.title = `zjsearch_${safeTitle}${fileTag ? `.${fileTag}` : ""}`;

  const build = (lightDiagrams: Map<string, string>): void => {
    const clone = source.cloneNode(true) as HTMLElement;
    for (const selector of dropSelectors) {
      clone.querySelectorAll(selector).forEach((el) => {
        el.remove();
      });
    }
    // buttons are actions — gone on paper.  EXCEPT the citation chips:
    // they ARE content in the report (each [n] ties to the sources tail)
    clone.querySelectorAll(".zjs-print-hide, button").forEach((el) => {
      if (el.tagName === "BUTTON" && el.closest(".zjs-answer-body")) {
        return;
      }
      el.remove();
    });
    // mermaid: swap in the off-screen light renders (same chart source is
    // the join key; a chart that failed to render keeps what it had)
    if (lightDiagrams.size > 0) {
      clone.querySelectorAll("[data-zjs-mermaid]").forEach((el) => {
        const svg = lightDiagrams.get(el.getAttribute("data-zjs-mermaid") ?? "");
        if (svg) {
          el.innerHTML = svg;
        }
      });
    }
    // the callers hand over EXACTLY the rows that should print (the cited
    // set in the document's own local numbering) -- no cap here: a cap
    // would silently drop tail rows and desync the paper from the body
    const sourceRows = sources
      .map((item) => {
        const n = item.n;
        return `<div style="font-size:11.5px;color:var(--ink-2);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">[${n}] ${escapeHtml(
          item.title,
        )} — ${escapeHtml(item.netloc)}</div>`;
      })
      .join("");
    if (deckPaper) {
      // the deck IS the document: the cover slide is the title page -- no
      // wordmark/heading/divider chrome.  The @page re-assertion rides in
      // a style AFTER print.css (document order) so the landscape sheets
      // deterministically win the @page cascade.
      root.innerHTML = `
        ${clone.outerHTML}
        <style>
          @page { size: 1280px 720px; margin: 0; }
        </style>
        <div style="break-before: page;margin-top:24px;">
          ${sourcesLabel ? `<div style="font-size:12.5px;font-weight:600;color:var(--ink-2);margin-bottom:6px;">${escapeHtml(sourcesLabel)}</div>` : ""}
          ${sourceRows}
        </div>
      `;
    } else {
      root.innerHTML = `
        <div style="font-family: var(--font-serif, Georgia, serif); font-size:20px;font-weight:600;color:var(--ink);">ZJSearch<span style="color:var(--accent-strong);">.</span></div>
        ${
          heading
            ? `<div style="font-family: var(--font-serif, Georgia, serif); font-size:24px;font-weight:600;color:var(--ink);margin-top:14px;">${escapeHtml(heading)}</div>`
            : ""
        }
        <div style="height:1px;background:var(--line);margin:16px 0 24px;"></div>
        ${clone.outerHTML}
        <div style="height:1px;background:var(--line);margin:28px 0 12px;"></div>
        ${sourcesLabel ? `<div style="font-size:12px;font-weight:600;color:var(--ink-2);margin-bottom:6px;">${escapeHtml(sourcesLabel)}</div>` : ""}
        ${sourceRows}
      `;
    }
    if (deckPaper) {
      root.classList.add("zjs-print-deck");
    }
    document.body.appendChild(root);
  };

  let cancelled = false;
  const timers: number[] = [];
  // THE PAPER IS THE VIEW: embedded browsers cannot open the print
  // dialog -- the observed webview shapes are a silent no-op AND a
  // PHANTOM afterprint whose timing varies (measured ~1s and ~9s), so
  // racing it is unwinnable and the on-screen-hidden paper made the
  // click read as dead.  The sheet is therefore the visible view from
  // the start (print.css's .zjs-print-preview face: white paper, the
  // paper measure, a close chip, Escape); window.print() rides right
  // after the mount -- a real browser's dialog simply opens OVER the
  // paper, and afterprint is retired without tearing anything down
  // (the user dismisses the paper with the chip or Escape; the host
  // component's cleanup always can).
  const teardown = (): void => {
    cancelled = true;
    timers.forEach((id) => {
      window.clearTimeout(id);
      window.cancelAnimationFrame(id);
    });
    window.removeEventListener("afterprint", onAfterPrint);
    window.removeEventListener("keydown", onPreviewKey);
    root.remove();
    document.body.classList.remove("zjs-print-view");
    document.title = prevTitle;
  };
  const onPreviewKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      teardown();
    }
  };
  const onAfterPrint = (): void => {
    // the dialog finished (saved or cancelled) -- the paper stays until
    // the user dismisses it
    window.removeEventListener("afterprint", onAfterPrint);
  };
  window.addEventListener("afterprint", onAfterPrint);

  const revealSheet = (): void => {
    root.classList.add("zjs-print-preview");
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "zjs-print-close zjs-print-hide";
    chip.setAttribute("aria-label", closeLabel);
    chip.title = closeLabel;
    chip.textContent = "✕";
    chip.setAttribute("data-zjs-print-close", "");
    chip.addEventListener("click", () => {
      teardown();
    });
    root.appendChild(chip);
    if (hint) {
      const hintEl = document.createElement("div");
      hintEl.className = "zjs-print-hint zjs-print-hide";
      hintEl.textContent = hint;
      root.appendChild(hintEl);
    }
    window.addEventListener("keydown", onPreviewKey);
  };
  const openDialog = (): void => {
    // give the injected document a frame to lay out before the call --
    // rAF starves in occluded/jammed panes (the IAB doctrine), so a 400ms
    // timer races it (ZJBlog's startPrintPreview ships the same pair).
    // ONE `printed` flag guards BOTH paths: a healthy pane fires the
    // double-rAF and must NOT print again from the fallback 400ms later
    // (the reported double dialog); a starved pane never fires the rAF
    // and the fallback carries it alone.
    let printed = false;
    const fire = (): void => {
      if (!cancelled && !printed) {
        printed = true;
        window.print();
      }
    };
    timers.push(
      window.requestAnimationFrame(() => {
        timers.push(window.requestAnimationFrame(fire));
      }),
    );
    timers.push(window.setTimeout(fire, 400));
  };

  const dispose = teardown;
  if (!needsDiagramRender) {
    build(new Map());
    revealSheet();
    openDialog();
  } else {
    // dark charts / never-rendered placeholders: render neutral copies
    // off-screen first — a bounded budget keeps a pathological chart from
    // blocking the dialog forever
    void renderLightDiagrams(mermaidBlocks).then((lightDiagrams) => {
      if (!cancelled) {
        build(lightDiagrams);
        revealSheet();
        openDialog();
      }
    });
  }
  return () => dispose();
}

/** Render the given mermaid blocks in the NEUTRAL (light) theme, keyed by
    chart source.  mermaid's config is global mutable state, so the neutral
    initialization is restored to the live theme afterwards — the live
    blocks never re-render (nothing flashes on screen), but a later palette
    flip must not inherit the print theme.  The budget scales with the
    chart count (a multi-figure report needs more than one chart) and
    still bounds the whole loop. */
async function renderLightDiagrams(blocks: Element[]): Promise<Map<string, string>> {
  const charts = [...new Set(blocks.map((el) => el.getAttribute("data-zjs-mermaid") ?? "").filter(Boolean))];
  const out = new Map<string, string>();
  if (charts.length === 0) {
    return out;
  }
  const mermaid = (await import("mermaid")).default;
  const config = {
    startOnLoad: false,
    securityLevel: "strict",
    fontFamily: "var(--font-sans)",
  } as const;
  const liveDark =
    document.documentElement.classList.contains("dark") || document.documentElement.classList.contains("black");
  mermaid.initialize({ ...config, theme: "neutral" });
  try {
    const renders = (async () => {
      for (const [index, chart] of charts.entries()) {
        try {
          const { svg } = await mermaid.render(`zjs-print-mmd-${index.toString(36)}`, chart);
          out.set(chart, svg);
        } catch {
          // an unparsable chart keeps whatever the clone carries
        }
      }
    })();
    await Promise.race([
      renders,
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, Math.max(4000, charts.length * 3000));
      }),
    ]);
  } finally {
    mermaid.initialize({ ...config, theme: liveDark ? "dark" : "neutral" });
  }
  return out;
}

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
