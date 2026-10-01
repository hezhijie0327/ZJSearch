// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useEffect } from "react";
import type { AiSearchRun } from "@/features/results/aiSearch/useAiSearch.ts";

/** The dedicated print view: clicking 📄 IMMEDIATELY builds the print
    document (the wordmark, the question, the rendered answer with the
    research box and chrome stripped, the numbered sources expanded at the
    tail) and opens the browser's print dialog — "Save as PDF" from there
    yields a selectable, editable, system-font PDF.  The document lives
    under #zjs-print-view-root, hidden on screen; on print everything else
    disappears and print.css's registered-token force renders the sheet in
    the LIGHT theme on a pure-white ground (paper is always light; every
    color stays the theme's own).  Mermaid is the one component whose
    colors are BAKED into the svg, so this view renders its own light
    copies off-screen from the blocks' data-zjs-mermaid sources — the live
    page's DOM never changes and nothing flashes.  The dialog closing
    (done or cancelled) tears the view down. */
export function PrintView({ onClose, run }: { onClose: () => void; run: AiSearchRun }) {
  useEffect(() => {
    const source = document.getElementById(`ai-run-${run.runNo}`);
    if (!source) {
      onClose();
      return;
    }
    const darkDiagrams =
      (document.documentElement.classList.contains("dark") || document.documentElement.classList.contains("black")) &&
      source.querySelector("[data-zjs-mermaid]") !== null;
    const root = document.createElement("div");
    root.id = "zjs-print-view-root";
    root.className = "zjs-print-sheet";
    document.body.classList.add("zjs-print-view");
    // the saved PDF's filename comes from the document title -- mirror the
    // MD export's naming: zjsearch_<safeTitle>.<threadId8>
    const prevTitle = document.title;
    const threadId = /\/ai\/thread\/([\w-]+)/.exec(window.location.pathname)?.[1] ?? "";
    const safeTitle =
      (run.q || "zjsearch")
        .replace(/[/\\:*?"<>|]+/g, "_")
        .trim()
        .slice(0, 64) || "thread";
    document.title = `zjsearch_${safeTitle}.${threadId.slice(0, 8)}`;

    const build = (lightDiagrams: Map<string, string>): void => {
      const clone = source.cloneNode(true) as HTMLElement;
      clone.querySelector('section[aria-label="研究过程"]')?.remove();
      // the sources rail DUPLICATES the tail's numbered list; the related
      // strip is follow-up chrome, not report content
      clone.querySelector("aside")?.remove();
      clone.querySelector('section[aria-label="相关"]')?.remove();
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
      // the numbered sources, EXPANDED at the tail (the MD download's tail)
      const sourceRows = run.sources
        .slice(0, 30)
        .map((item, index) => {
          const n = item.n || index + 1;
          return `<div style="font-size:11.5px;color:var(--ink-2);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">[${n}] ${escapeHtml(
            item.title || item.url,
          )} — ${escapeHtml(item.netloc || item.url)}</div>`;
        })
        .join("");
      root.innerHTML = `
        <div style="font-family: var(--font-serif, Georgia, serif); font-size:20px;font-weight:600;color:var(--ink);">ZJSearch<span style="color:var(--accent-strong);">.</span></div>
        <div style="height:1px;background:var(--line);margin:16px 0 24px;"></div>
        ${clone.outerHTML}
        <div style="height:1px;background:var(--line);margin:28px 0 12px;"></div>
        ${sourceRows}
      `;
      document.body.appendChild(root);
    };

    const done = (): void => {
      root.remove();
      document.body.classList.remove("zjs-print-view");
      document.title = prevTitle;
      onClose();
    };
    window.addEventListener("afterprint", done, { once: true });

    let cancelled = false;
    const timers: number[] = [];
    const openDialog = (): void => {
      // give the injected document a frame to lay out before the dialog
      timers.push(
        window.requestAnimationFrame(() => {
          timers.push(
            window.requestAnimationFrame(() => {
              if (!cancelled) {
                window.print();
              }
            }),
          );
        }),
      );
    };
    if (!darkDiagrams) {
      build(new Map());
      openDialog();
    } else {
      // dark mermaid: render light copies off-screen first — a bounded
      // budget keeps a pathological chart from blocking the dialog forever
      void renderLightDiagrams(source).then((lightDiagrams) => {
        if (!cancelled) {
          build(lightDiagrams);
          openDialog();
        }
      });
    }

    return () => {
      cancelled = true;
      timers.forEach((id) => {
        window.clearTimeout(id);
        window.cancelAnimationFrame(id);
      });
      window.removeEventListener("afterprint", done);
      root.remove();
      document.body.classList.remove("zjs-print-view");
      document.title = prevTitle;
    };
    // onClose is stable (a useCallback in the section); run identifies the view
  }, [run, onClose]);

  return null;
}

/** Render every mermaid block of the run in the NEUTRAL (light) theme,
    keyed by chart source.  mermaid's config is global mutable state, so
    the neutral initialization is restored to the live theme afterwards —
    the live blocks never re-render (nothing flashes on screen), but a
    later palette flip must not inherit the print theme.  A 4s budget
    bounds the whole loop. */
async function renderLightDiagrams(source: HTMLElement): Promise<Map<string, string>> {
  const charts = [
    ...new Set(
      [...source.querySelectorAll("[data-zjs-mermaid]")]
        .map((el) => el.getAttribute("data-zjs-mermaid") ?? "")
        .filter(Boolean),
    ),
  ];
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
        window.setTimeout(resolve, 4000);
      }),
    ]);
  } finally {
    mermaid.initialize({ ...config, theme: liveDark ? "dark" : "neutral" });
  }
  return out;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
