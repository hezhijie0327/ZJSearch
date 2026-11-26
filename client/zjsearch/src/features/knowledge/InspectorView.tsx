import { Check, ChevronLeft, Copy, ExternalLink, MessageCircleQuestion, Printer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Card, SectionLabel } from "@/components/SettingParts.tsx";
import { AiRunFooter, type AiUsage } from "@/features/aiAnswer/AiRunFooter.tsx";
import { type AiSourceMeta, extractRunMeta } from "@/features/aiAnswer/aiOverview.ts";
import { DeckView } from "@/features/aiAnswer/deck/DeckView.tsx";
import { DocumentView } from "@/features/aiAnswer/report/DocumentView.tsx";
import { InspectorMarkdown } from "@/features/knowledge/InspectorMarkdown.tsx";
import { RowActions } from "@/features/knowledge/rowParts.tsx";
import { buildCitationMap, citedSourceRows } from "@/lib/citations.ts";
import { buildAnswerMarkdown, buildDeckMarkdown, buildReportMarkdown } from "@/lib/exporters.ts";
import { useT } from "@/lib/i18n.ts";
import type { OverviewUsage } from "@/lib/kb/projections.ts";
import type { KnowledgeItem } from "@/lib/kb/shared.ts";
import { printDocument } from "@/lib/print.ts";
import { CHIP_BTN, CHIP_OUTLINE, CHIP_OUTLINE_IDLE, READ_PANE } from "@/lib/styles.ts";

/** The ONE glyph identity per knowledge surface: the segment tab, the kind
    directory's empty note and each view's own empty state wear the same
    icon -- one map, so they cannot drift apart again (the Layers-era
    empties once disagreed with every tab they lived under). */

function BackRow({ onClick }: { onClick: () => void }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <button
      className="inline-flex items-center gap-1 text-[13px] text-ink-3 transition-colors hover:text-ink"
      onClick={onClick}
      ref={ref}
      type="button"
    >
      <ChevronLeft aria-hidden="true" className="size-3.5" />
      {t("knowledge_back")}
    </button>
  );
}

// ------------------------------------------------------------------ rows

/** The inline rename form (one thread at a time): the input focuses on
    mount through the imperative pattern (no autoFocus attribute), Enter
    saves, Escape cancels. */

function paneText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(^|[\s(])[*_`~]+([^*_`\n]*)[*_`~]+/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The url line's text: host + path + query, protocol and any trailing
    slash dropped -- the same shape the classic results' pretty url wears. */

export function InspectorView({
  body,
  extras,
  item,
  onBack,
  onOpenThread,
  onRemove,
}: {
  body: string | null;
  /** run items: the loaded answer's cited sources + token usage (+ the
      report document's outline + per-section texts when the run was a
      report -- the inspector re-renders the SAME DocumentView) */
  extras: {
    sources: Array<{ n: number; url: string; title: string; host: string; favicon: string }>;
    usage: OverviewUsage | null;
    report?: {
      title: string;
      subtitle?: string;
      deck?: boolean;
      sections: Array<{ id: string; title: string }>;
    } | null;
    sections?: Record<string, string> | null;
    /** the per-section reasoning buffers (the section's retained
        thinking disclosure) -- absent on rows settled before the relay */
    sectionThink?: Record<string, string> | null;
  } | null;
  item: KnowledgeItem;
  onBack: () => void;
  onOpenThread: (id: string) => void;
  onRemove: (item: KnowledgeItem) => void;
}) {
  const t = useT();
  const isDocument = item.kind === "document";
  // a crawled source reads in the MACHINE pane (the run's reading-pane
  // language -- collected material, not the answer's editorial voice)
  // and the ORIGINAL search snippet leads it; the head line skips
  // itself when it is just the body's own opening (rows born without
  // a snippet wear the page opening there)
  const isCrawledSource = item.kind === "source" && Boolean(item.meta?.crawled);
  const snippetLine = isCrawledSource && item.body && !(body ?? "").startsWith(item.body) ? item.body : null;
  const sources: Array<{ n: number; url: string; title: string; host: string }> =
    item.kind === "run"
      ? (extras?.sources ?? [])
      : ((item.meta?.sources as Array<{ n: number; url: string; title: string }> | undefined) ?? []).map((source) => ({
          n: source.n,
          url: source.url,
          title: source.title,
          host: "",
        }));
  const usage: OverviewUsage | null =
    item.kind === "run" ? (extras?.usage ?? null) : ((item.meta?.usage as OverviewUsage | undefined) ?? null);
  // the REPORT document's shape (settled into run.meta.report) -- the
  // inspector renders it as a reading TOC above the glued answer
  const reportToc = (() => {
    if (item.kind !== "run") {
      return null;
    }
    const report = item.meta?.report as
      | { title?: string; sections?: Array<{ id?: string; title?: string }> }
      | undefined;
    const sections = (report?.sections ?? []).filter((section) => section.title);
    return sections.length >= 2 ? { title: report?.title ?? "", sections } : null;
  })();
  // the REPORT DOCUMENT (the research page's own renderer): outline +
  // per-section texts stored at settle -- present for every post-v5.2
  // report run; the fallback for older rows stays the glued answer
  const reportDoc = (() => {
    if (item.kind !== "run" || !extras?.report || !extras.sections) {
      return null;
    }
    const sectionTexts = extras.sections;
    const docSections = extras.report.sections
      .map((section) => ({
        id: section.id,
        title: section.title,
        status: "done" as const,
        text: sectionTexts[section.id] ?? "",
      }))
      .filter((section) => section.text.trim().length > 0);
    return docSections.length >= 1
      ? {
          title: extras.report.title || item.title,
          subtitle: extras.report.subtitle,
          // the SLIDE shape: the bodies are slide-markdown chapters
          deck: extras.report.deck ?? false,
          sections: docSections,
        }
      : null;
  })();
  // THE DOCUMENT-LOCAL citation map (the run page's contract): bodies read
  // [1..N] in first-citation order -- InspectorMarkdown's chips, the
  // sources card below and the print tail share this one map; the
  // report/deck
  // renderers build their own from the same texts.
  // OLD overview rows recorded the wire's trailing meta sentinel inside
  // the stored answer (splitAnswerStream never stripped it) -- the
  // render-side strip heals pre-fix records; new records are clean at
  // the recording boundary.  null (still loading) passes through.
  const bodyText = body === null ? null : extractRunMeta(body).text;
  const answerBody = bodyText ?? item.body;
  const docTexts = reportDoc ? reportDoc.sections.map((section) => section.text) : [answerBody];
  const citationMap = buildCitationMap(docTexts, new Set(sources.map((source) => source.n)));
  const citedRows = citedSourceRows(citationMap, sources);
  // citation chips open the source (the knowledge base's honest action --
  // the research page's rail scroll has no counterpart in the panel)
  const citationMeta: AiSourceMeta[] = sources.map((source) => ({
    domain: source.host || source.url,
    favicon: String((extras?.sources ?? []).find((s) => s.n === source.n)?.favicon ?? ""),
    // the global registry n: the citation map matches rows by it
    n: source.n,
    t: source.title || source.url,
    u: source.url,
  }));
  const onCite = (n: number) => {
    const hit = sources.find((source) => source.n === n);
    if (hit?.url) {
      window.open(hit.url, "_blank", "noopener");
    }
  };
  // the MD/PDF exports' source list (overview: the stored cited sources;
  // research: the run's source_ref join) -- RAW rows: the markdown
  // builders build their own document map (the text stays global until
  // they renumber it)
  const exportSources = sources.map((source) => ({
    n: source.n,
    netloc: source.host || source.url,
    title: source.title || source.url,
    url: source.url,
  }));
  const answerText = bodyText ?? "";
  const exportLabels = { sources: t("knowledge_inspector_sources") };
  // one document shape for BOTH markdown paths (the download + copy-as-
  // Markdown clipboard -- the ZJBlog copy-as-markdown contract); a DECK
  // exports its slide SOURCE (Marpit markdown, drop-in deck:true post)
  const exportMarkdown = (): string =>
    reportDoc?.deck
      ? buildDeckMarkdown({
          title: reportDoc.title,
          subtitle: reportDoc.subtitle,
          sections: reportDoc.sections.map((section) => ({ text: section.text })),
        })
      : reportDoc
        ? buildReportMarkdown(
            {
              title: reportDoc.title,
              subtitle: reportDoc.subtitle,
              sections: reportDoc.sections.map((section) => ({ title: section.title, text: section.text })),
              sources: exportSources,
            },
            exportLabels,
          )
        : buildAnswerMarkdown(item.title || item.url || t("knowledge_title"), answerText, exportSources, exportLabels);
  // copy-as-markdown: the twin of ZJBlog's CopyMarkdownButton -- the Copy
  // glyph swaps to Check for 1.6s once the clipboard write lands (the icon
  // IS the feedback, no toast); a failed write stays silent.
  const [copied, setCopied] = useState(false);
  const copyMd = () => {
    navigator.clipboard
      .writeText(exportMarkdown())
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  };
  const printCard = () => {
    const card = bodyCardRef.current;
    if (!card) {
      return;
    }
    const heading = item.title || item.url || t("knowledge_title");
    printDocument({
      // a deck doc prints on its own 16:9 sheets -- the cover slide is
      // the title page (the injected heading would buy a near-blank page 1)
      paper: reportDoc?.deck ? "deck" : "a4",
      hint: t("print_hint_webview"),
      heading: reportDoc?.deck ? null : heading,
      source: card,
      // the CITED set in the document's own local numbers -- the paper
      // agrees with the body above it
      sources: citedRows.map((source) => ({
        n: source.local,
        netloc: source.host || source.url,
        title: source.title || source.url,
      })),
      sourcesLabel: t("knowledge_inspector_sources"),
      closeLabel: t("print_close"),
      title: heading,
      // the pane's own title heading would print twice (the injected
      // heading IS the same line)
      dropSelectors: ["[data-zjs-pane-title]"],
    });
  };
  const bodyCardRef = useRef<HTMLDivElement>(null);
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackRow onClick={onBack} />
        <div className="flex items-center gap-1">
          {item.kind === "run" ? (
            <>
              <button
                aria-label={t("copy_md")}
                className={`${CHIP_BTN} disabled:pointer-events-none disabled:opacity-40`}
                disabled={copied}
                onClick={copyMd}
                title={t("copy_md")}
                type="button"
              >
                {copied ? (
                  <Check aria-hidden="true" className="size-3.5" />
                ) : (
                  <Copy aria-hidden="true" className="size-3.5" />
                )}
              </button>
              <button aria-label={t("print")} className={CHIP_BTN} onClick={printCard} title={t("print")} type="button">
                <Printer aria-hidden="true" className="size-3.5" />
              </button>
            </>
          ) : null}
          <RowActions onRemove={() => onRemove(item)} reveal={false} />
          {item.url ? (
            <a
              aria-label={t("open_in_new_tab")}
              className={CHIP_BTN}
              href={item.url}
              rel="noreferrer"
              target="_blank"
              title={t("open_in_new_tab")}
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          ) : null}
          {item.threadId ? (
            item.kind === "run" ? (
              <button
                className={`${CHIP_OUTLINE} ${CHIP_OUTLINE_IDLE}`}
                onClick={() => onOpenThread(item.threadId ?? "")}
                type="button"
              >
                {t("knowledge_open_research")}
              </button>
            ) : (
              <button
                aria-label={t("knowledge_open_research")}
                className={CHIP_BTN}
                onClick={() => onOpenThread(item.threadId ?? "")}
                title={t("knowledge_open_research")}
                type="button"
              >
                <MessageCircleQuestion aria-hidden="true" className="size-3.5" />
              </button>
            )
          ) : null}
        </div>
      </div>
      <Card>
        <div className="px-5 py-4 sm:px-6" ref={bodyCardRef}>
          {/* the item's question/title is this reading pane's PAGE HEADING --
              the AI thread page's own h2 language (text-2xl medium), not a
              caption; the detail view never clamps it away */}
          <h2
            className="mb-4 break-words border-b border-line pb-3 font-semibold leading-tight text-ink text-lg"
            data-zjs-pane-title
            dir="auto"
          >
            {item.title || item.url}
          </h2>
          <div className="text-[13px] leading-relaxed text-ink-2">
            {item.kind === "run" && reportDoc && reportDoc.deck ? (
              // THE SAME slide view the research page used -- the stored
              // slide-markdown chapters re-render through the family compile
              // (citation chips open the source in a new tab here)
              <div className="text-sm leading-relaxed text-ink">
                <DeckView
                  meta={citationMeta}
                  onCite={onCite}
                  outline={{
                    title: reportDoc.title,
                    subtitle: reportDoc.subtitle,
                    sections: reportDoc.sections.map(({ id, title, status }) => ({ id, title, status })),
                  }}
                  sections={Object.fromEntries(reportDoc.sections.map((section) => [section.id, section.text]))}
                  settled
                />
              </div>
            ) : item.kind === "run" && reportDoc ? (
              // THE SAME renderer the research page used -- identical
              // syntax and layout (cover header, clickable TOC, per-section
              // headings, citation chips, tables, mermaid, the filing
              // postmark); DocumentView carries its own long-form root
              <div>
                <DocumentView
                  meta={citationMeta}
                  onCite={onCite}
                  run={{
                    galleries: [],
                    outline: {
                      title: reportDoc.title,
                      subtitle: reportDoc.subtitle,
                      sections: reportDoc.sections.map(({ id, title, status }) => ({ id, title, status })),
                    },
                    // DocumentView reads runNo ONLY for its scroll-spy
                    // anchor prefix -- the inspector shows one document at a
                    // time; the run row's own tail number keeps prefixes unique
                    runNo: Number(item.id.split(":").pop()) || 1,
                    sections: Object.fromEntries(reportDoc.sections.map((section) => [section.id, section.text])),
                    // the retained per-section reasoning (the archived
                    // evt log's think-marked section deltas re-fold here)
                    sectionThink: extras?.sectionThink ?? undefined,
                  }}
                  settled
                  stamp={item.updated}
                />
              </div>
            ) : item.kind === "run" ? (
              body === null ? (
                // the run's answer is still loading off the evt log -- the
                // document branch's prose ghosts, not a lone ellipsis
                <div aria-busy="true" className="space-y-3">
                  <span className="zjs-skeleton block h-4 w-full" />
                  <span className="zjs-skeleton block h-4 w-[93%]" />
                  <span className="zjs-skeleton block h-4 w-[70%]" />
                </div>
              ) : body === "" ? (
                <p className="text-[13px] text-ink-3">{t("knowledge_inspector_not_read")}</p>
              ) : (
                <>
                  {reportToc ? (
                    <nav aria-label={t("ai_report_toc")} className="mb-4 rounded-xl bg-surface-2/40 px-3 py-2.5">
                      <p className="px-1.5 pb-1 text-xs font-medium uppercase tracking-wide text-ink-3">
                        {String(reportToc.title || t("ai_report_toc"))}
                      </p>
                      <ol className="space-y-0.5">
                        {reportToc.sections.map((section, index) => (
                          <li
                            className="flex items-center gap-2 px-1.5 py-0.5 text-[13px] text-ink-2"
                            key={section.id ?? String(index)}
                          >
                            <span className="w-4 shrink-0 text-end font-mono text-xs tabular-nums text-ink-3">
                              {index + 1}
                            </span>
                            <span className="min-w-0 flex-1 truncate" dir="auto">
                              {section.title}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </nav>
                  ) : null}
                  <InspectorMarkdown map={citationMap} meta={citationMeta} onCite={onCite} text={bodyText ?? ""} />
                </>
              )
            ) : isCrawledSource ? (
              <>
                {snippetLine ? (
                  <div className="mb-4 rounded-lg bg-surface-2/40 px-3 py-2.5 text-[13px] leading-relaxed text-ink-2">
                    {snippetLine}
                  </div>
                ) : null}
                {body === null ? (
                  <div aria-busy="true" className="space-y-3">
                    <span className="zjs-skeleton block h-4 w-full" />
                    <span className="zjs-skeleton block h-4 w-[93%]" />
                    <span className="zjs-skeleton block h-4 w-[70%]" />
                  </div>
                ) : body === "" ? (
                  <p className="text-[13px] text-ink-3">{t("knowledge_inspector_not_read")}</p>
                ) : (
                  <>
                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-3">
                      {t("knowledge_full_text")}
                    </p>
                    <div
                      className={`relative ${READ_PANE} max-h-[32rem] overflow-y-auto overscroll-contain`}
                      dir="auto"
                    >
                      {paneText(body)}
                    </div>
                  </>
                )}
              </>
            ) : !isDocument ? (
              item.body ? (
                <>
                  <pre className="whitespace-pre-wrap break-words">{item.body}</pre>
                  <p className="mt-3 text-xs text-ink-3">{t("knowledge_inspector_not_read")}</p>
                </>
              ) : (
                <p className="text-[13px] text-ink-3">{t("knowledge_inspector_not_read")}</p>
              )
            ) : body === null ? (
              // the run's answer is still loading off the evt log — prose
              // ghosts, not a lone ellipsis
              <div aria-busy="true" className="space-y-3">
                <span className="zjs-skeleton block h-4 w-full" />
                <span className="zjs-skeleton block h-4 w-[93%]" />
                <span className="zjs-skeleton block h-4 w-[70%]" />
              </div>
            ) : body === "" ? (
              <p className="text-[13px] text-ink-3">{t("knowledge_inspector_not_read")}</p>
            ) : (
              <InspectorMarkdown map={citationMap} meta={citationMeta} onCite={onCite} text={bodyText ?? ""} />
            )}
          </div>
          {/* the SAME meta line the thread page's answer card ends with --
              pinned to the card's foot */}
          <AiRunFooter
            finish={usage?.finish ?? null}
            model={usage?.model ?? null}
            usage={
              usage
                ? ({
                    cache_write: usage.cache_write ?? 0,
                    cached: usage.cached ?? 0,
                    input: usage.input ?? 0,
                    output: usage.output ?? 0,
                    thoughts: usage.thoughts ?? null,
                    rerank: usage.rerank,
                    decision: usage.decision,
                    embedding: usage.embedding,
                  } satisfies AiUsage)
                : null
            }
          />
        </div>
      </Card>
      {sources.length > 0 ? (
        <Card>
          <SectionLabel label={t("knowledge_inspector_sources")} />
          {/* the cited set in the document's OWN local numbers (first-
              citation order) -- the tail agrees with the body; a row the
              document never cited stays out (the full registry lives in
              the sources tab) */}
          {(citedRows.length > 0
            ? citedRows.map((source) => ({
                key: `${source.n}:${source.url}`,
                label: source.local,
                url: source.url,
                title: source.title,
                host: source.host,
              }))
            : sources.map((source) => ({
                key: `${source.n}:${source.url}`,
                label: source.n,
                url: source.url,
                title: source.title,
                host: source.host,
              }))
          ).map((source) => (
            <a
              className="group flex items-baseline gap-2 px-5 py-2.5 transition-colors hover:bg-surface-2/40 sm:px-6"
              href={source.url}
              key={source.key}
              rel="noreferrer"
              target="_blank"
            >
              <span className="shrink-0 font-mono text-xs text-accent">[{source.label}]</span>
              <span
                className="min-w-0 flex-1 truncate text-[13px] text-ink-2 transition-colors group-hover:text-ink"
                dir="auto"
              >
                {source.title || source.url}
              </span>
              {source.host ? <span className="shrink-0 text-xs text-ink-3">{source.host}</span> : null}
            </a>
          ))}
        </Card>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------- kind items

/** One kind's directory listing (the filter chips' non-search view):
    answers / sources / documents as rows.  Sources and documents open
    the inspector; answers navigate to their thread. */
