// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// KaTeX typography for the math pipeline (lazy-loaded plugins, css is small
// enough to ride the results stylesheet; the woff2 fonts load on demand)
import "katex/dist/katex.min.css";

import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { PluggableList } from "unified";
import { AnswerGallery, renderWithGalleries } from "@/features/aiAnswer/AnswerGallery.tsx";
import { Lightbox, type LightboxItem } from "@/features/aiAnswer/AttachmentLightbox.tsx";
import type { AiSearchGallery, AiSourceMeta } from "@/features/aiAnswer/aiOverview.ts";
import { markdownComponents } from "@/features/aiAnswer/markdownComponents.tsx";
import { normalizeEmphasis, SHARED_REMARK, sharedRemarkWithMath } from "@/lib/markdownParts.ts";

/** The answer body, memoized: the card re-renders on every clamp
    measurement (contentPx), and a fresh components object made
    react-markdown rebuild the whole tree each time -- which remounted
    MermaidBlock and reset its svg/failed state on every tick, flickering
    the answer (and any diagram) for as long as the content height kept
    changing.  Stable props (markdown text, per-result meta, settled) keep
    the subtree untouched by measurement churn.
    The KaTeX math pipeline (the ZJBlog remark-math + rehype-katex pair):
    a sizable dependency, lazy-loaded only when the answer actually
    carries math; until it loads the body renders as plain markdown (the
    delimiters flash raw for a beat -- the mermaid placeholder's own
    pattern).  DELIBERATE FAMILY DIVERGENCE (DESIGN.md §5.1's separator
    seam):
    singleDollarTextMath is OFF -- our content is UNAUDITED model output,
    and a currency pair ($3,000 ... $5,000) would ride straight into
    KaTeX as garbled formulas (the false-positive class ZJBlog's
    0f92d7a had to escape by hand in its human-audited content; a model
    cannot be taught to escape every dollar).  Inline math is therefore
    $$..$$ only, exactly what spine.markdown_surface teaches. */
const MATH_FENCE = /\$\$[\s\S]+?\$\$|^```math/m;

export const MarkdownAnswer = memo(function MarkdownAnswer({
  markdown,
  meta,
  onCite,
  settled,
  galleries,
  figureLightbox = false,
}: {
  markdown: string;
  meta: AiSourceMeta[];
  onCite?: (index: number) => void;
  settled: boolean;
  /** the run's validated inline image groups -- the answer's
      {{zjs-gallery:i}} placeholders render these in place */
  galleries?: AiSearchGallery[][];
  /** The reading pane turns ON the figure lightbox (the ZJBlog Prose
      family mechanism): body images + rendered
      mermaid cards form one document-order mixed gallery.  Self-managed
      surfaces (the deck's own paging semantics) do not pass it */
  figureLightbox?: boolean;
}) {
  const needsMath = MATH_FENCE.test(markdown);
  const [mathPlugins, setMathPlugins] = useState<[PluggableList, PluggableList] | null>(null);
  useEffect(() => {
    if (!needsMath || mathPlugins) {
      return;
    }
    let cancelled = false;
    void Promise.all([import("remark-math"), import("rehype-katex")]).then(([rm, rh]) => {
      if (!cancelled) {
        setMathPlugins([[rm.default, { singleDollarTextMath: false }] as PluggableList, [rh.default] as PluggableList]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [needsMath, mathPlugins]);
  const withMath = needsMath && mathPlugins;
  const body = (text: string, key: string) => (
    <Markdown
      components={markdownComponents(meta, onCite, settled, figureLightbox)}
      key={key}
      rehypePlugins={withMath ? mathPlugins[1] : undefined}
      remarkPlugins={withMath ? sharedRemarkWithMath(mathPlugins[0]) : SHARED_REMARK}
    >
      {text}
    </Markdown>
  );
  const content = renderWithGalleries(normalizeEmphasis(markdown), galleries, body, (index, key) => (
    <AnswerGallery gallery={galleries?.[index] ?? EMPTY_GALLERY} key={key} onCite={onCite} />
  ));
  if (!figureLightbox) {
    return content;
  }
  return <FigureLightboxRoot>{content}</FigureLightboxRoot>;
});

/** The figure lightbox container (the ZJBlog Prose family mechanism,
    DESIGN.md §5.1): delegates clicks on body
    images and rendered mermaid cards (data-zjs-figure) into one
    document-order mixed gallery--
    prev/next walks every figure.  SVG must be inline-cloned into the
    lightbox's svg item (serialized at click
    time, consistent with the current theme): <img src>'s secure static
    mode does not render
    htmlLabels' foreignObject.  AnswerGallery thumbnail blocks are buttons
    with citation-jump click semantics -- doubly excluded. */
function FigureLightboxRoot({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  // Focus returns to the trigger element after the lightbox closes
  // (keyboard/screen-reader users land back where they started)
  const lastTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) {
      return;
    }
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !container.contains(target)) {
        return;
      }
      if (target.closest("button")) {
        return; // gallery thumbnails / citation chips keep their own click semantics, out of the lightbox
      }
      const image = target.closest("img");
      const figure = image ? null : target.closest<HTMLElement>("[data-zjs-figure]");
      if (!image && !figure) {
        return;
      }
      // Gallery = every image + every rendered mermaid (not-yet-rendered
      // ones are still placeholders, no svg -- skipped);
      // querySelectorAll returns the mixed sequence in document order
      const items: LightboxItem[] = [];
      let index = -1;
      for (const node of container.querySelectorAll("img, [data-zjs-figure]")) {
        if (node.closest("button")) {
          continue;
        }
        if (node instanceof HTMLImageElement) {
          if (node === image) {
            index = items.length;
          }
          items.push({ alt: node.alt, kind: "img", src: node.currentSrc || node.src });
        } else {
          const svg = node.querySelector("svg");
          if (!svg) {
            continue;
          }
          if (node === figure) {
            index = items.length;
          }
          items.push({
            alt: node.getAttribute("aria-label") ?? "",
            html: svg.outerHTML,
            kind: "svg",
          });
        }
      }
      if (index === -1) {
        return;
      }
      event.preventDefault();
      lastTriggerRef.current = image ?? figure;
      setPreview({ items, index });
    };
    container.addEventListener("click", onClick);
    return () => {
      container.removeEventListener("click", onClick);
    };
  }, []);

  // The dialog's close event fires (top layer already released): return
  // focus to the trigger first, then unmount
  const closePreview = () => {
    const trigger = lastTriggerRef.current;
    if (trigger) {
      trigger.tabIndex = -1;
      trigger.focus({ preventScroll: true });
    }
    setPreview(null);
  };

  return (
    <>
      <div ref={ref}>{children}</div>
      {preview && preview.items.length > 0 && (
        <Lightbox initialIndex={preview.index} items={preview.items} onClose={closePreview} />
      )}
    </>
  );
}

const EMPTY_GALLERY: AiSearchGallery[] = [];
