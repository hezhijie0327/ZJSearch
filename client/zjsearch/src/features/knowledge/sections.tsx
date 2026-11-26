// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge page's sections: the thread rows (Vane's library list),
    the grouped search results, the memory surface (LobeHub's timeline +
    cards), the inspector reading pane (morphic), the admin drawer (the
    old preferences PgliteTab's duties) and the shared confirm dialog.
    Page-private to KnowledgePage -- nothing here exports beyond it
    EXCEPT the glyph identity map, which the drawer's views wear too. */

import type { LucideIcon } from "lucide-react";
import { Check, FileDown, FileText, Globe, Search, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BootRowsCard } from "@/components/BootGhosts.tsx";
import { Link } from "@/components/Link.tsx";
import { PaperEmpty } from "@/components/PaperEmpty.tsx";
import { Card, SectionLabel } from "@/components/SettingParts.tsx";
import { KNOWLEDGE_KIND_ICONS, META_CHIP, RowActions } from "@/features/knowledge/rowParts.tsx";
import { useHostFavicon } from "@/lib/favicons.ts";
import { formatDate } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import type { ThreadSummary } from "@/lib/kb/recall.ts";
import type { KnowledgeItem } from "@/lib/kb/shared.ts";
import { newTabLinkProps } from "@/lib/link.ts";
import { inlineMdHtml } from "@/lib/markdownParts.ts";
/** The ONE glyph identity per knowledge surface: the segment tab, the kind
    directory's empty note and each view's own empty state wear the same
    icon -- one map, so they cannot drift apart again (the Layers-era
    empties once disagreed with every tab they lived under). */
import { CHIP_OUTLINE_ACTIVE, CHIP_OUTLINE_IDLE, CHIP_SOLID } from "@/lib/styles.ts";

function RenameForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (draft: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = draft.trim();
        if (trimmed) {
          onSave(trimmed);
        }
        onCancel();
      }}
    >
      <input
        className="h-8 min-w-0 flex-1 rounded-lg border border-accent-strong bg-surface px-2 text-[13px] text-ink outline-none"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onCancel();
          }
        }}
        ref={ref}
        value={draft}
      />
      <button
        aria-label={t("knowledge_rename")}
        className="grid size-7 shrink-0 place-items-center rounded-full text-accent transition-colors hover:bg-surface-2"
        title={t("knowledge_rename")}
        type="submit"
      >
        <Check aria-hidden="true" className="size-3.5" />
      </button>
    </form>
  );
}

/** The thread directory as Vane-style rows: title + meta chips + a hover
    menu (pin / delete).  Clicking a row navigates to the AI thread page
    -- the detail view lives THERE, not here. */
/** The directory's run-mode tags: the thread's distinct run modes as
    compact chips (the overview tier's thread reads the overview label, a
    balanced one the balanced label...). */

export function ThreadRows({
  onHome,
  onOpen,
  onRemove,
  onRename,
  threads,
  /** the store subscription is still resolving — hold the directory's
      shape with the boot-ghost rows instead of the final empty state (a
      cold store's boot can take seconds; "knowledge base empty" during it
      lies) */
  loading = false,
}: {
  threads: ThreadSummary[];
  onOpen: (thread: ThreadSummary) => void;
  onRemove: (thread: ThreadSummary) => void;
  onRename?: (thread: ThreadSummary, title: string) => void;
  /** panel context: the empty state's home pill must leave the drawer, an
      anchor would be captured into a fallback panel */
  onHome?: () => void;
  loading?: boolean;
}) {
  const t = useT();
  // the directory's report filter: only threads carrying report-mode runs
  const [reportsOnly, setReportsOnly] = useState(false);
  // the inline rename: one thread at a time, Enter saves, Escape cancels
  const [renaming, setRenaming] = useState<{ id: string } | null>(null);
  if (loading) {
    return <BootRowsCard rows={4} />;
  }
  const shown = reportsOnly ? threads.filter((thread) => thread.reports > 0) : threads;
  if (threads.length === 0) {
    return (
      <PaperEmpty icon={KNOWLEDGE_KIND_ICONS.run} line={t("knowledge_empty_hint")} title={t("knowledge_empty")}>
        {onHome ? (
          <button className={CHIP_SOLID} onClick={onHome} type="button">
            {t("back_to_search")}
          </button>
        ) : (
          <Link className={CHIP_SOLID} href="/">
            {t("back_to_search")}
          </Link>
        )}
      </PaperEmpty>
    );
  }
  return (
    <Card>
      {threads.some((thread) => thread.reports > 0) ? (
        <div className="flex items-center gap-2 px-5 pt-4 sm:px-6">
          <button
            className={`inline-flex items-center ${reportsOnly ? CHIP_OUTLINE_ACTIVE : CHIP_OUTLINE_IDLE}`}
            onClick={() => {
              setReportsOnly((on) => !on);
            }}
            type="button"
          >
            {t("knowledge_filter_reports")}
          </button>
        </div>
      ) : null}
      {shown.length === 0 ? (
        // the report filter emptied the list (threads exist, none carries a
        // report) -- the same paper empty, the filter chip above stays so
        // the user can toggle it off
        <PaperEmpty
          className="py-4"
          icon={FileText}
          line={t("knowledge_reports_filter_empty")}
          title={t("no_results_found")}
        />
      ) : null}
      {shown.map((thread) => (
        <div
          className="group relative flex flex-col gap-1.5 px-5 py-5 transition-colors hover:bg-surface-2/40 sm:px-6"
          key={thread.id}
        >
          <div className="relative flex items-start justify-between gap-3">
            {renaming?.id === thread.id ? (
              <RenameForm
                initial={thread.title || ""}
                onCancel={() => {
                  setRenaming(null);
                }}
                onSave={(draft) => {
                  onRename?.(thread, draft);
                }}
              />
            ) : (
              <>
                <button
                  className="min-w-0 flex-1 text-start font-serif text-xl font-semibold leading-snug text-ink transition-colors hover:text-accent sm:text-2xl"
                  onClick={() => onOpen(thread)}
                  title={thread.title}
                  type="button"
                >
                  <span className="line-clamp-2">{thread.title || t("ai_search")}</span>
                </button>
                <RowActions
                  onRemove={() => onRemove(thread)}
                  onRename={onRename ? () => setRenaming({ id: thread.id }) : undefined}
                />
              </>
            )}
          </div>
          {thread.preview ? (
            // the answer's head carries the model's inline markdown -- the
            // one-line chrome pass (bold, code) renders it; block syntax in
            // a two-line clamp stays literal
            <p
              className="relative line-clamp-2 text-[13px] leading-relaxed text-ink-3"
              dangerouslySetInnerHTML={{ __html: inlineMdHtml(thread.preview) }}
              dir="auto"
            />
          ) : null}
          <div className="relative flex flex-wrap items-center gap-2 text-xs text-ink-3">
            <span className="shrink-0 font-mono">{formatDate(new Date(thread.updated).toISOString())}</span>
            {thread.modes?.includes("overview") ? (
              <span className="inline-flex min-h-6 items-center gap-1 rounded-full border border-accent-strong/40 bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                <Sparkles aria-hidden="true" className="size-3" />
                {t("mode_overview")}
              </span>
            ) : null}
            {thread.reports > 0 ? (
              <span className="inline-flex min-h-6 items-center rounded-full border border-accent-strong/40 bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                {t("knowledge_badge_report", { n: String(thread.reports) })}
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </Card>
  );
}

/** The listing's excerpt line: the crawl text is markdown, the listing
    line is plain -- image/link syntax stripped to their text, markup
    noise and urls dropped, whitespace collapsed. */

function listingExcerpt(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#>*`|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The listing body line's html: the link/url strip of listingExcerpt
    MINUS the marker stripping -- the inline pass renders bold and code
    (the thread preview's contract at listing scale). */
function listingBodyHtml(text: string): string {
  const stripped = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return inlineMdHtml(stripped);
}

/** The row's host: the stored column first -- older settle rows left
    it empty, the url derives it. */
function rowHost(item: KnowledgeItem): string {
  if (item.host) {
    return item.host;
  }
  try {
    return item.url ? new URL(item.url).hostname : "";
  } catch {
    return "";
  }
}

/** The reading pane's text: the scrape stores markdown, the pane reads
    plain -- images drop, links keep their text, heading/emphasis marks
    drop, line structure survives. */

function displayUrl(url: string | null): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname.replace(/\/$/, "") + parsed.search;
  } catch {
    return url;
  }
}

/** The source row's favicon cell: the row's stored url first, then the
    classic channel (the resolver-backed server route) -- the Globe
    glyph stays the fallback. */
function RowFavicon({ item }: { item: KnowledgeItem }) {
  const stored = item.meta?.favicon as string | undefined;
  const fetched = useHostFavicon(rowHost(item) || null);
  const src = stored || fetched || "";
  return src ? (
    <img alt="" className="size-4 shrink-0 rounded-sm object-contain" src={src} />
  ) : (
    <Globe aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
  );
}

/** The row's flat actions -- star (pin), rename, trash (confirm-backed
    delete; the parent owns the confirm dialog).  Hover-revealed in list
    rows, always visible in the inspector (reveal={false}).  Clicks stop
    propagation: the whole row around them is a click target. */
/** The admin cards' in-card section header (the two admin blocks were a
    hand-copy of each other -- one local fragment owns the anatomy;
    AGENTS.md sanctions admin's own anatomy vs SectionLabel). */

const KIND_LABEL_KEYS: Record<
  string,
  | "knowledge_kind_run"
  | "knowledge_kind_source"
  | "knowledge_kind_document"
  | "knowledge_kind_memory"
  | "knowledge_kind_call"
  | "knowledge_kind_task"
  | "knowledge_kind_clarify"
> = {
  run: "knowledge_kind_run",
  source: "knowledge_kind_source",
  document: "knowledge_kind_document",
  memory: "knowledge_kind_memory",
  call: "knowledge_kind_call",
  task: "knowledge_kind_task",
  clarify: "knowledge_kind_clarify",
};

export function SearchResults({
  groups,
  loading = false,
  onOpen,
  onOpenThread,
  onRemove,
}: {
  groups: Map<string, KnowledgeItem[]>;
  /** the hybrid search is still in flight — row ghosts, not "no matches" */
  loading?: boolean;
  onOpen: (item: KnowledgeItem) => void;
  onOpenThread: (item: KnowledgeItem) => void;
  onRemove: (item: KnowledgeItem) => void;
}) {
  const t = useT();
  if (loading) {
    return <BootRowsCard rows={4} />;
  }
  if (groups.size === 0) {
    return <PaperEmpty icon={Search} line={t("knowledge_no_match_line")} title={t("knowledge_thread_no_match")} />;
  }
  return (
    <div className="space-y-6">
      {[...groups.entries()].map(([kind, items]) => {
        const labelKey = KIND_LABEL_KEYS[kind] ?? "knowledge_kind_source";
        return (
          <Card key={kind}>
            <SectionLabel label={`${t(labelKey)} · ${items.length}`} />
            {items.map((item) => (
              <div
                className="group flex items-start gap-3 px-5 py-5 transition-colors hover:bg-surface-2/40 sm:px-6"
                key={item.id}
              >
                <button
                  className="min-w-0 flex-1 text-start"
                  onClick={() => {
                    if (item.kind === "source" || item.kind === "document") {
                      onOpen(item);
                      return;
                    }
                    if (item.threadId) {
                      onOpenThread(item);
                    }
                  }}
                  type="button"
                >
                  <span className="line-clamp-2 font-serif text-base font-semibold leading-snug text-ink">
                    {item.title || (item.body ? listingExcerpt(item.body).slice(0, 80) : "") || item.url}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                    <span className="shrink-0 font-mono">{formatDate(new Date(item.updated).toISOString())}</span>
                    {item.host ? <span className={META_CHIP}>{item.host}</span> : null}
                    {item.cited > 0 ? (
                      <span className={META_CHIP}>{t("knowledge_source_cited", { n: String(item.cited) })}</span>
                    ) : null}
                    {item.body && item.kind !== "source" ? (
                      // the body is markdown: the listing line reads the
                      // stripped plain text (same contract as the main
                      // listing's excerpt line)
                      <span className="min-w-0 flex-1 truncate">{listingExcerpt(item.body).slice(0, 90)}</span>
                    ) : null}
                  </span>
                </button>
                <RowActions onRemove={() => onRemove(item)} />
              </div>
            ))}
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- memory

/** The memory surface, LobeHub-style: a timeline/cards view switch and
    one card per durable fact (content + forget). */

export function KindItemRows({
  items,
  label,
  emptyIcon,
  emptyLine,
  onOpenInspector,
  onOpenThread,
  onRemove,
}: {
  /** the kind's own glyph -- the same one its segment tab wears */
  emptyIcon: LucideIcon;
  items: KnowledgeItem[];
  onOpenInspector: (item: KnowledgeItem) => void;
  onOpenThread: (item: KnowledgeItem) => void;
  onRemove: (item: KnowledgeItem) => void;
  /** optional section band above the rows */
  label?: string;
  /** the empty state's guidance line (the caller knows the kind) */
  emptyLine?: string;
}) {
  const t = useT();
  if (items.length === 0) {
    return (
      <PaperEmpty
        icon={emptyIcon}
        line={emptyLine ?? t("knowledge_kind_empty_line")}
        title={t("knowledge_kind_empty")}
      />
    );
  }
  return (
    <Card>
      {label ? <SectionLabel label={label} /> : null}
      {items.map((item) => {
        const isSource = item.kind === "source";
        return (
          <div
            className="group flex items-start gap-3 px-5 py-5 transition-colors hover:bg-surface-2/40 sm:px-6"
            key={item.id}
          >
            <div className="min-w-0 flex-1">
              {isSource ? (
                <a
                  className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3 transition-colors hover:text-ink-2"
                  href={item.url ?? "#"}
                  {...newTabLinkProps(true)}
                >
                  <RowFavicon item={item} />
                  <span className="truncate" dir="ltr">
                    {displayUrl(item.url)}
                  </span>
                </a>
              ) : (
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
                  <FileText aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate">{t("knowledge_kind_document")}</span>
                </span>
              )}
              <button
                className="mt-1 block w-full min-w-0 text-start"
                onClick={() => {
                  if (isSource || item.kind === "document") {
                    onOpenInspector(item);
                    return;
                  }
                  if (item.threadId) {
                    onOpenThread(item);
                  }
                }}
                type="button"
              >
                <span className="line-clamp-1 font-serif text-base font-semibold leading-snug text-ink">
                  {item.title || item.url}
                </span>
                {item.body ? (
                  // the body is markdown (crawled pages ride markitdown): the
                  // link/url strip stays, the inline markers render -- the
                  // thread directory's preview contract
                  <span
                    className="mt-0.5 line-clamp-2 block text-[13px] leading-relaxed text-ink-3"
                    dangerouslySetInnerHTML={{ __html: listingBodyHtml(item.body) }}
                  />
                ) : null}
                <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                  <span className="shrink-0 font-mono">{formatDate(new Date(item.updated).toISOString())}</span>
                  {item.cited > 0 ? <span>{t("knowledge_source_cited", { n: String(item.cited) })}</span> : null}
                  {isSource && item.meta?.crawled ? (
                    <span className="inline-flex items-center gap-1">
                      <FileDown aria-hidden="true" className="size-3" />
                      {t("knowledge_source_crawled")}
                    </span>
                  ) : null}
                </span>
              </button>
            </div>
            <RowActions onRemove={() => onRemove(item)} />
          </div>
        );
      })}
    </Card>
  );
}

// ------------------------------------------------------------------ admin

/** The admin surface as an IN-PANEL view (the panel navigates, no second
    drawer): per-kind row counts, the storage estimate, the embedding
    model, the snapshot export/import (the cross-device path -- the
    export downloads immediately, the import files through the parent's
    confirm dialog), and the destructive action behind its confirm
    dialog the parent owns. */
