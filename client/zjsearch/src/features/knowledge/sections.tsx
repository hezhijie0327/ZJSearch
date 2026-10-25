// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge page's sections: the thread rows (Vane's library list),
    the grouped search results, the memory surface (LobeHub's timeline +
    cards), the inspector reading pane (morphic), the admin drawer (the
    old preferences PgliteTab's duties) and the shared confirm dialog.
    Page-private to KnowledgePage -- nothing here exports beyond it
    EXCEPT the glyph identity map, which the drawer's views wear too. */

import type { LucideIcon } from "lucide-react";
import {
  ArrowDown,
  ArrowUp,
  Brain,
  Check,
  ChevronLeft,
  Copy,
  Database,
  DatabaseZap,
  ExternalLink,
  FileDown,
  FileText,
  Gauge,
  Globe,
  LayoutTemplate,
  LoaderCircle,
  MemoryStick,
  MessageCircleQuestion,
  Network,
  Pencil,
  Plus,
  Printer,
  Search,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BootRowsCard } from "@/components/BootGhosts.tsx";
import { PaperEmpty } from "@/components/PaperEmpty.tsx";
import { Card, SectionLabel } from "@/components/SettingParts.tsx";
import { Link } from "@/components/Shell.tsx";
import { InspectorMarkdown } from "@/features/knowledge/InspectorMarkdown.tsx";
import { AiRunFooter, type AiUsage } from "@/features/results/AiRunFooter.tsx";
import type { AiSourceMeta } from "@/features/results/aiOverview.ts";
import { DeckView } from "@/features/results/aiSearch/deck/DeckView.tsx";
import { DocumentView } from "@/features/results/aiSearch/report/DocumentView.tsx";
import { buildCitationMap, citedSourceRows } from "@/lib/citations.ts";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { type EmbedUsageTotals, readEmbedUsage } from "@/lib/embed.ts";
import { buildAnswerMarkdown, buildDeckMarkdown, buildReportMarkdown } from "@/lib/exporters.ts";
import { formatDate, formatFilesize } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import type { MemoryRow, OverviewUsage } from "@/lib/kb/projections.ts";
import type { ThreadSummary } from "@/lib/kb/recall.ts";
import type { KnowledgeItem } from "@/lib/kb/shared.ts";
import type { KnowledgeStats } from "@/lib/kb/stats.ts";
import { printDocument } from "@/lib/print.ts";

/** The ONE glyph identity per knowledge surface: the segment tab, the kind
    directory's empty note and each view's own empty state wear the same
    icon -- one map, so they cannot drift apart again (the Layers-era
    empties once disagreed with every tab they lived under). */
export const KNOWLEDGE_KIND_ICONS = {
  reading: Globe,
  run: MessageCircleQuestion,
  source: Globe,
  document: FileText,
  memory: MemoryStick,
  graph: Network,
  templates: LayoutTemplate,
  admin: Database,
} as const;

import { type RerankUsageTotals, readRerankUsage } from "@/lib/rerank.ts";
import { CHIP_OUTLINE, CHIP_OUTLINE_IDLE } from "@/lib/styles.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";

/** The knowledge META chip: a 12px bordered chip for row meta and hero
    stats (the lib CHIP_OUTLINE is the 13px CLICKABLE control tier -- a
    same-name divergent token here once invited drift; this reads as its
    own tier now). */
const META_CHIP = "inline-flex min-h-6 items-center gap-1 rounded-full border border-line px-2 text-xs text-ink-3";

/** The in-panel views' back row: focus lands here on view swap (the
    imperative focus-on-mount pattern -- no autoFocus attribute). */
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
  onPin,
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
  onPin: (thread: ThreadSummary, on: boolean) => void;
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
          <button
            className="inline-flex items-center gap-1.5 rounded-full bg-accent-strong px-4 py-2 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
            onClick={onHome}
            type="button"
          >
            {t("back_to_search")}
          </button>
        ) : (
          <Link
            className="inline-flex items-center gap-1.5 rounded-full bg-accent-strong px-4 py-2 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
            href="/"
          >
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
            className={`inline-flex min-h-6 items-center rounded-full px-2 py-0.5 text-xs transition-colors ${
              reportsOnly
                ? "border border-accent-strong bg-accent-soft font-medium text-accent"
                : "border border-line text-ink-3 hover:text-ink"
            }`}
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
                  <span className="line-clamp-2">
                    {thread.pinned ? <Star aria-hidden="true" className="me-1.5 inline size-3.5 text-accent" /> : null}
                    {thread.title || t("ai_search")}
                  </span>
                </button>
                <RowActions
                  onPin={(on) => onPin(thread, on)}
                  onRemove={() => onRemove(thread)}
                  onRename={onRename ? () => setRenaming({ id: thread.id }) : undefined}
                  pinned={thread.pinned}
                />
              </>
            )}
          </div>
          {thread.preview ? (
            <p className="relative line-clamp-2 text-[13px] leading-relaxed text-ink-3" dir="auto">
              {thread.preview}
            </p>
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

/** The row's flat actions -- the source's crawl (when the caller wires
    it), star (pin), rename, trash (confirm-backed delete; the parent owns
    the confirm dialog).  Hover-revealed in list rows, always visible in
    the inspector (reveal={false}).  Clicks stop propagation: the whole
    row around them is a click target. */
function RowActions({
  onCrawl,
  crawling,
  onPin,
  onRemove,
  onRename,
  pinned,
  reveal = true,
}: {
  /** the source row's manual full-text crawl (the browser read lane) */
  onCrawl?: () => void;
  /** true while that crawl is in flight */
  crawling?: boolean;
  onPin?: (on: boolean) => void;
  onRemove: () => void;
  onRename?: () => void;
  pinned?: boolean;
  reveal?: boolean;
}) {
  const t = useT();

  return (
    <div
      className={`flex shrink-0 items-center gap-0.5 ${reveal ? "opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100" : ""}`}
    >
      {onCrawl ? (
        <button
          aria-label={t("knowledge_crawl")}
          className="grid size-7 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
          disabled={crawling}
          onClick={(event) => {
            event.stopPropagation();
            onCrawl();
          }}
          title={t("knowledge_crawl")}
          type="button"
        >
          {crawling ? (
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <FileDown aria-hidden="true" className="size-3.5" />
          )}
        </button>
      ) : null}
      {onRename ? (
        <button
          aria-label={t("knowledge_rename")}
          className="grid size-7 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          onClick={onRename}
          title={t("knowledge_rename")}
          type="button"
        >
          <Pencil aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
      {onPin ? (
        <button
          aria-label={t(pinned ? "knowledge_menu_unpin" : "knowledge_menu_pin")}
          aria-pressed={pinned}
          className={`grid size-7 place-items-center rounded-full transition-colors hover:bg-surface-2 ${
            pinned ? "fill-current text-accent" : "text-ink-3 hover:text-ink"
          }`}
          onClick={(event) => {
            event.stopPropagation();
            onPin(!pinned);
          }}
          type="button"
        >
          <Star aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
      <button
        aria-label={t("knowledge_menu_delete")}
        className="grid size-7 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        type="button"
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

// --------------------------------------------------------- search results

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

/** The cross-kind search hits, grouped by kind (the knowledge table's
    headline capability).  A source hit opens the inspector; a document
    hit reads its archived full text; anything else navigates. */
export function SearchResults({
  groups,
  loading = false,
  onOpen,
  onOpenThread,
  onPin,
  onRemove,
}: {
  groups: Map<string, KnowledgeItem[]>;
  /** the hybrid search is still in flight — row ghosts, not "no matches" */
  loading?: boolean;
  onOpen: (item: KnowledgeItem) => void;
  onOpenThread: (item: KnowledgeItem) => void;
  onPin: (item: KnowledgeItem, on: boolean) => void;
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
                    {item.title || item.body.slice(0, 80) || item.url}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                    <span className="shrink-0 font-mono">{formatDate(new Date(item.updated).toISOString())}</span>
                    {item.host ? <span className={META_CHIP}>{item.host}</span> : null}
                    {item.cited > 0 ? (
                      <span className={META_CHIP}>{t("knowledge_source_cited", { n: String(item.cited) })}</span>
                    ) : null}
                    {item.body && item.kind !== "source" ? (
                      <span className="min-w-0 flex-1 truncate">{item.body.slice(0, 90)}</span>
                    ) : null}
                  </span>
                </button>
                <RowActions onPin={(on) => onPin(item, on)} onRemove={() => onRemove(item)} pinned={item.pinned} />
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
export function MemorySection({
  memories,
  loading = false,
  onAdd,
  onForget,
  onSave,
}: {
  memories: MemoryRow[];
  loading?: boolean;
  onAdd: (content: string) => void;
  onForget: (id: string) => void;
  onSave: (id: string, content: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  if (loading) {
    return <BootRowsCard rows={3} />;
  }
  const submit = () => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    onAdd(text);
    setDraft("");
  };
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Plus aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
        <input
          className="h-6 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          dir="auto"
          maxLength={300}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return;
            }
            if (event.key === "Enter") {
              submit();
            }
          }}
          placeholder={t("knowledge_memory_placeholder")}
          value={draft}
        />
        {draft.trim() ? (
          <button
            className="shrink-0 rounded-full bg-accent-strong px-3 py-1 text-xs font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
            onClick={submit}
            type="button"
          >
            {t("knowledge_memory_save")}
          </button>
        ) : null}
      </div>
      {memories.length === 0 ? (
        <PaperEmpty
          className="py-6"
          icon={MemoryStick}
          line={t("knowledge_memory_empty_line")}
          title={t("knowledge_kind_empty")}
        />
      ) : (
        <div className="space-y-0.5">
          {memories.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} onForget={onForget} onSave={onSave} />
          ))}
        </div>
      )}
    </Card>
  );
}

function MemoryCard({
  memory,
  onForget,
  onSave,
}: {
  memory: MemoryRow;
  onForget: (id: string) => void;
  onSave: (id: string, content: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      draftRef.current?.focus();
      draftRef.current?.select();
    }
  }, [editing]);
  if (editing) {
    return (
      <div className="flex w-full items-center gap-1.5">
        <input
          className="h-7 min-w-0 flex-1 rounded-lg border border-accent bg-transparent px-2 text-[13px] text-ink outline-none"
          dir="auto"
          maxLength={300}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // the row is the editor: Enter saves, Escape cancels (and the
            // drawer must not read either)
            event.stopPropagation();
            if (event.key === "Escape") {
              setEditing(false);
            }
            if (event.key === "Enter" && draft.trim()) {
              onSave(memory.id, draft);
              setEditing(false);
            }
          }}
          ref={draftRef}
          value={draft}
        />
        <button
          aria-label={t("knowledge_memory_save")}
          className="grid size-7 shrink-0 place-items-center rounded-md text-accent transition-colors hover:bg-surface-2 disabled:opacity-40"
          disabled={!draft.trim()}
          onClick={() => {
            onSave(memory.id, draft);
            setEditing(false);
          }}
          title={t("knowledge_memory_save")}
          type="button"
        >
          <Check aria-hidden="true" className="size-3.5" />
        </button>
        <button
          aria-label={t("ai_delete_cancel")}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2"
          onClick={() => setEditing(false)}
          title={t("ai_delete_cancel")}
          type="button"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    );
  }
  return (
    <div className="group flex items-start rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed text-ink" dir="auto">
          {memory.content}
        </p>
        <p className="mt-0.5 text-xs text-ink-3">{formatDate(new Date(memory.updated).toISOString())}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          aria-label={t("knowledge_memory_edit")}
          className="rounded-md p-1 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          onClick={() => {
            setDraft(memory.content);
            setEditing(true);
          }}
          title={t("knowledge_memory_edit")}
          type="button"
        >
          <Pencil aria-hidden="true" className="size-3.5" />
        </button>
        <button
          aria-label={t("knowledge_memory_forget")}
          className="rounded-md p-1 text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger"
          onClick={() => onForget(memory.id)}
          title={t("knowledge_memory_forget")}
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- inspector

/** The morphic inspector as an IN-PANEL view: the knowledge panel
    navigates to the reading pane and back -- it never stacks a second
    drawer.  The thread action is a button (an anchor to the thread page
    would be captured by the panel's click-capture into a fallback). */
export function InspectorView({
  body,
  extras,
  item,
  onBack,
  onOpenThread,
  onPin,
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
  } | null;
  item: KnowledgeItem;
  onBack: () => void;
  onOpenThread: (id: string) => void;
  onPin: (item: KnowledgeItem, on: boolean) => void;
  onRemove: (item: KnowledgeItem) => void;
}) {
  const t = useT();
  const isDocument = item.kind === "document";
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
  const answerBody = body ?? item.body;
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
  const answerText = body ?? "";
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
                className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
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
              <button
                aria-label={t("print")}
                className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                onClick={printCard}
                title={t("print")}
                type="button"
              >
                <Printer aria-hidden="true" className="size-3.5" />
              </button>
            </>
          ) : null}
          <RowActions
            onPin={(on) => onPin(item, on)}
            onRemove={() => onRemove(item)}
            pinned={item.pinned}
            reveal={false}
          />
          {item.url ? (
            <a
              aria-label={t("open_in_new_tab")}
              className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
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
                className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
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
                  }}
                  settled
                  stamp={item.updated}
                />
              </div>
            ) : item.kind === "run" ? (
              body ? (
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
                  <InspectorMarkdown map={citationMap} meta={citationMeta} onCite={onCite} text={body} />
                </>
              ) : (
                <p className="text-[13px] text-ink-3">…</p>
              )
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
              <InspectorMarkdown map={citationMap} meta={citationMeta} onCite={onCite} text={body} />
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
export function KindItemRows({
  items,
  label,
  emptyIcon,
  emptyLine,
  onCrawl,
  onOpenInspector,
  onOpenThread,
  onPin,
  onRemove,
}: {
  /** the kind's own glyph -- the same one its segment tab wears */
  emptyIcon: LucideIcon;
  items: KnowledgeItem[];
  onOpenInspector: (item: KnowledgeItem) => void;
  onOpenThread: (item: KnowledgeItem) => void;
  onPin: (item: KnowledgeItem, on: boolean) => void;
  onRemove: (item: KnowledgeItem) => void;
  /** optional section band above the rows */
  label?: string;
  /** the empty state's guidance line (the caller knows the kind) */
  emptyLine?: string;
  /** manual full-text crawl for a source row (the browser read lane) */
  onCrawl?: (item: KnowledgeItem) => Promise<void>;
}) {
  const t = useT();
  const [crawlBusy, setCrawlBusy] = useState<Record<string, boolean>>({});
  const crawl = (item: KnowledgeItem) => {
    if (!onCrawl || crawlBusy[item.id]) {
      return;
    }
    setCrawlBusy((prev) => ({ ...prev, [item.id]: true }));
    void Promise.resolve(onCrawl(item)).finally(() => {
      setCrawlBusy((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    });
  };
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
        const favicon = isSource ? (item.meta?.favicon as string | undefined) : undefined;
        return (
          <div
            className="group flex items-start gap-3 px-5 py-4 transition-colors hover:bg-surface-2/40 sm:px-6"
            key={item.id}
          >
            {isSource ? (
              favicon ? (
                <img
                  alt=""
                  className="mt-0.5 size-8 shrink-0 rounded-lg border border-line bg-surface object-contain p-0.5"
                  src={favicon}
                />
              ) : (
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface text-ink-3">
                  <Globe aria-hidden="true" className="size-4" />
                </span>
              )
            ) : (
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface text-ink-3">
                <FileText aria-hidden="true" className="size-4" />
              </span>
            )}
            <button
              className="min-w-0 flex-1 text-start"
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
              <span className="line-clamp-1 text-sm font-medium leading-snug text-ink">{item.title || item.url}</span>
              {isSource && item.body ? (
                <span className="mt-0.5 line-clamp-2 block text-[13px] leading-relaxed text-ink-3">{item.body}</span>
              ) : null}
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-3">
                {item.host ? <span className="truncate">{item.host}</span> : null}
                <span className="shrink-0 font-mono">{formatDate(new Date(item.updated).toISOString())}</span>
                {item.cited > 0 ? <span>{t("knowledge_source_cited", { n: String(item.cited) })}</span> : null}
              </span>
            </button>
            <RowActions
              crawling={Boolean(crawlBusy[item.id])}
              onCrawl={isSource ? () => crawl(item) : undefined}
              onPin={(on) => onPin(item, on)}
              onRemove={() => onRemove(item)}
              pinned={item.pinned}
            />
          </div>
        );
      })}
    </Card>
  );
}

// ------------------------------------------------------------------ admin

/** The admin surface as an IN-PANEL view (the panel navigates, no second
    drawer): per-kind row counts, the storage estimate, the embedding
    model, and the two destructive actions behind confirm dialogs the
    parent owns. */
export function AdminView({ onReset, stats }: { stats: KnowledgeStats | null; onReset: () => void }) {
  const t = useT();
  const [embedUsage, setEmbedUsage] = useState<EmbedUsageTotals | undefined>(undefined);
  const [rerankUsage, setRerankUsage] = useState<RerankUsageTotals | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void readEmbedUsage().then((totals) => {
      if (live) {
        setEmbedUsage(totals);
      }
    });
    void readRerankUsage().then((totals) => {
      if (live) {
        setRerankUsage(totals);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const rows: Array<{ label: string; value: string }> = stats
    ? [
        { label: t("knowledge_admin_threads"), value: String(stats.threads) },
        { label: t("knowledge_admin_runs"), value: String(stats.runs) },
        { label: t("knowledge_admin_answers"), value: String(stats.answers) },
        { label: t("knowledge_admin_sources"), value: String(stats.sources) },
        { label: t("knowledge_admin_documents"), value: String(stats.documents) },
        { label: t("knowledge_admin_memories"), value: String(stats.memories) },
        { label: t("knowledge_admin_events"), value: String(stats.events) },
        { label: t("knowledge_admin_size"), value: formatFilesize(stats.approxBytes) ?? "--" },
      ]
    : [];
  return (
    <div className="space-y-6 animate-fade-in">
      {(() => {
        const embed = embedUsage?.calls ? embedUsage : undefined;
        const llm = stats?.usage;
        if (!llm && !embed) {
          return null;
        }
        // think only reports on SDKs that break reasoning out (openai's
        // reasoning_tokens; the anthropic protocol folds it into output
        // and reports nothing) -- a misleading 0 hides itself
        const llmTiles = stats?.usage
          ? (
              [
                ["knowledge_usage_input", stats.usage.input, ArrowUp],
                ["knowledge_usage_output", stats.usage.output, ArrowDown],
                ["knowledge_usage_thoughts", stats.usage.thoughts, Brain],
                ["knowledge_usage_cached", stats.usage.cached, Database],
                ["knowledge_usage_cache_write", stats.usage.cache_write, DatabaseZap],
              ] as const
            ).filter(([, value]) => value !== 0)
          : [];
        return (
          <Card>
            <div className="px-5 py-5 sm:px-6">
              <div className="flex items-center gap-2">
                <Gauge aria-hidden="true" className="size-4.5 text-ink-3" />
                <h2 className="text-sm font-semibold text-ink">{t("knowledge_admin_usage_title")}</h2>
              </div>
              {llmTiles.length > 0 ? (
                <>
                  <p className="mt-4 text-xs font-medium text-ink-3">{t("knowledge_usage_group_llm")}</p>
                  <dl className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-2">
                    {llmTiles.map(([label, value, Icon]) => (
                      <div className="rounded-xl border border-line bg-surface px-3 py-2.5" key={label}>
                        <dt className="flex items-center gap-1 text-xs text-ink-3">
                          <Icon aria-hidden="true" className="size-3" />
                          {t(label)}
                        </dt>
                        <dd className="mt-0.5 font-mono text-sm font-medium text-ink">
                          {value.toLocaleString()}
                          <span className="ms-1 text-xs font-sans font-normal text-ink-3">
                            {t("knowledge_usage_tokens")}
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : null}
              {embed || stats?.usage?.rerank || rerankUsage?.calls || stats?.usage?.decision ? (
                // embed / rerank / decision: the LLM group's language -- one
                // group
                // title per model, ONE input tile inside (the score
                // endpoints are input-only); the three groups share ONE
                // row (they stack below sm).  The rerank tile sums BOTH
                // pools: the runs' cascade spend (run meta) AND the
                // browser recall's own calls (the usage:rerank row).
                <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-6 gap-y-4">
                  {embed ? (
                    <div>
                      <p className="text-xs font-medium text-ink-3">{t("knowledge_usage_embedding")}</p>
                      <div className="mt-2 rounded-xl border border-line bg-surface px-3 py-2.5">
                        <dt className="flex items-center gap-1 text-xs text-ink-3">
                          <ArrowUp aria-hidden="true" className="size-3" />
                          {t("knowledge_usage_input")}
                        </dt>
                        <dd className="mt-0.5 font-mono text-sm font-medium text-ink">
                          {embed.input.toLocaleString()}
                          <span className="ms-1 text-xs font-sans font-normal text-ink-3">
                            {t("knowledge_usage_tokens")}
                          </span>
                        </dd>
                      </div>
                    </div>
                  ) : null}
                  {stats?.usage?.rerank || rerankUsage?.calls
                    ? (() => {
                        const rerankInput = (stats?.usage?.rerank?.tokens ?? 0) + (rerankUsage?.input ?? 0);
                        return (
                          <div>
                            <p className="text-xs font-medium text-ink-3">{t("knowledge_usage_rerank")}</p>
                            <div className="mt-2 rounded-xl border border-line bg-surface px-3 py-2.5">
                              <dt className="flex items-center gap-1 text-xs text-ink-3">
                                <ArrowUp aria-hidden="true" className="size-3" />
                                {t("knowledge_usage_input")}
                              </dt>
                              <dd className="mt-0.5 font-mono text-sm font-medium text-ink">
                                {rerankInput.toLocaleString()}
                                <span className="ms-1 text-xs font-sans font-normal text-ink-3">
                                  {t("knowledge_usage_tokens")}
                                </span>
                              </dd>
                            </div>
                          </div>
                        );
                      })()
                    : null}
                  {stats?.usage?.decision ? (
                    <div>
                      <p className="text-xs font-medium text-ink-3">{t("knowledge_usage_decision")}</p>
                      <div className="mt-2 rounded-xl border border-line bg-surface px-3 py-2.5">
                        <dt className="flex items-center gap-1 text-xs text-ink-3">
                          <ArrowUp aria-hidden="true" className="size-3" />
                          {t("knowledge_usage_input")}
                        </dt>
                        <dd className="mt-0.5 font-mono text-sm font-medium text-ink">
                          {stats.usage.decision.tokens.toLocaleString()}
                          <span className="ms-1 text-xs font-sans font-normal text-ink-3">
                            {t("knowledge_usage_tokens")}
                          </span>
                        </dd>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {llmTiles.length === 0 && !embed && !stats?.usage?.rerank && !stats?.usage?.decision ? (
                <p className="mt-4 text-[13px] text-ink-3">{t("knowledge_usage_empty")}</p>
              ) : null}
            </div>
          </Card>
        );
      })()}
      <Card>
        <div className="px-5 py-5 sm:px-6">
          <div className="flex items-center gap-2">
            <Database aria-hidden="true" className="size-4.5 text-ink-3" />
            <h2 className="text-sm font-semibold text-ink">{t("knowledge_admin_title")}</h2>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-2">
            {rows.map((row) => (
              <div className="rounded-xl border border-line bg-surface px-3 py-2.5" key={row.label}>
                <dt className="text-xs text-ink-3">{row.label}</dt>
                <dd className="mt-0.5 truncate text-sm font-medium text-ink">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="space-y-3 px-5 py-5 sm:px-6">
          <button
            className="flex w-full items-center justify-between rounded-xl border border-danger/40 px-4 py-3 text-start text-[13px] text-danger transition-colors hover:bg-danger/5"
            onClick={onReset}
            type="button"
          >
            {t("knowledge_admin_reset")}
            <Trash2 aria-hidden="true" className="size-3.5" />
          </button>
          <p className="text-xs leading-relaxed text-ink-3">{t("knowledge_admin_reset_desc")}</p>
        </div>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ shared

/** The one confirm dialog every destructive action funnels through (the
    knowledge drawer's old pattern).  ALWAYS-MOUNTED with an `open` flag:
    the dismissal plays its exit animation (useExitPresence) instead of
    snapping out of the DOM -- the one dialog in the panel that still
    unmounted instantly. */
export function ConfirmDialog({
  cancel,
  message,
  onConfirm,
  open,
  title,
}: {
  cancel: () => void;
  message: string;
  onConfirm: () => void;
  open: boolean;
  title: string;
}) {
  const t = useT();
  const { render, closing } = useExitPresence(open, 140);
  const ref = useDialogFocus<HTMLDivElement>(open && !closing);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, open]);
  if (!render) {
    return null;
  }
  return (
    <div
      className={`fixed inset-0 z-[60] flex items-center justify-center p-4 ${closing ? "pointer-events-none" : ""}`}
    >
      <div
        aria-hidden="true"
        className={`absolute inset-0 bg-black/60 ${closing ? "animate-fade-out" : "animate-fade-in"}`}
      />
      <div
        aria-label={title}
        aria-modal="true"
        className={`relative z-10 w-full max-w-md rounded-2xl border border-line bg-surface p-5 ${
          closing ? "animate-fade-out" : "animate-fade-up"
        }`}
        inert={closing || undefined}
        ref={ref}
        role="dialog"
      >
        <h3 className="text-base font-semibold text-ink">{title}</h3>
        <p className="mt-2 break-words text-sm leading-relaxed text-ink-2">{message}</p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            className="rounded-full px-4 py-1.5 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            data-dialog-close=""
            onClick={cancel}
            type="button"
          >
            {t("ai_delete_cancel")}
          </button>
          <button
            className="rounded-full bg-danger px-4 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-danger/85"
            onClick={onConfirm}
            type="button"
          >
            {t("ai_delete_ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
