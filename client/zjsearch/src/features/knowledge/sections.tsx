// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge page's sections: the thread rows (Vane's library list),
    the grouped search results, the memory surface (LobeHub's timeline +
    cards), the inspector reading pane (morphic), the admin drawer (the
    old preferences PgliteTab's duties) and the shared confirm dialog.
    Page-private to KnowledgePage -- nothing here exports beyond it. */

import {
  ChevronDown,
  Database,
  ExternalLink,
  Globe,
  Layers,
  MemoryStick,
  MessageCircleQuestion,
  Search,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Link } from "@/components/Shell.tsx";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { formatDate } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import {
  type KnowledgeItem,
  type KnowledgeStats,
  type MemoryRow,
  type ThreadSummary,
  threadUrl,
} from "@/lib/knowledgeStore.ts";

export function formatBytesLocal(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const CHIP = "inline-flex min-h-6 items-center gap-1 rounded-full border border-line px-2 text-xs text-ink-3";

// ------------------------------------------------------------------ rows

/** The thread directory as Vane-style rows: title + meta chips + a hover
    menu (pin / delete).  Clicking a row navigates to the AI thread page
    -- the detail view lives THERE, not here. */
export function ThreadRows({
  threads,
  onOpen,
  onPin,
  onRemove,
}: {
  threads: ThreadSummary[];
  onOpen: (id: string) => void;
  onPin: (thread: ThreadSummary, on: boolean) => void;
  onRemove: (thread: ThreadSummary) => void;
}) {
  const t = useT();
  if (threads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-2 py-20 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
          <Sparkles aria-hidden="true" className="size-7" />
        </span>
        <p className="mt-4 text-sm font-medium text-ink">{t("knowledge_empty")}</p>
        <p className="mt-1 text-[13px] text-ink-3">{t("knowledge_empty_hint")}</p>
        <Link
          className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-accent-strong px-4 py-2 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
          href="/"
        >
          {t("back_to_search")}
        </Link>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      {threads.map((thread, index) => (
        <div
          className={`group flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-surface-2 ${
            index !== threads.length - 1 ? "border-b border-line" : ""
          }`}
          key={thread.id}
        >
          <div className="flex items-start justify-between gap-3">
            <button
              className="min-w-0 flex-1 text-start text-[15px] font-medium leading-snug text-ink transition-colors hover:text-accent"
              onClick={() => onOpen(thread.id)}
              title={thread.title}
              type="button"
            >
              <span className="line-clamp-2">
                {thread.pinned ? <Star aria-hidden="true" className="me-1.5 inline size-3.5 text-accent" /> : null}
                {thread.title || t("ai_search")}
              </span>
            </button>
            <RowMenu
              items={[
                {
                  label: t(thread.pinned ? "knowledge_menu_unpin" : "knowledge_menu_pin"),
                  onSelect: () => onPin(thread, !thread.pinned),
                },
                { label: t("knowledge_menu_delete"), danger: true, onSelect: () => onRemove(thread) },
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
            <span className="shrink-0">{formatDate(new Date(thread.updated).toISOString())}</span>
            <span className={CHIP}>{t("knowledge_row_runs", { n: String(thread.runs) })}</span>
            {thread.sources > 0 ? (
              <span className={CHIP}>{t("knowledge_row_sources", { n: String(thread.sources) })}</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The morphic pattern: a hover menu with a confirm-backed destructive
    action (the parent owns the confirm dialog). */
function RowMenu({ items }: { items: Array<{ label: string; danger?: boolean; onSelect: () => void }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        aria-label={items[0]?.label}
        className="grid size-8 place-items-center rounded-full text-ink-3 opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        <ChevronDown className="size-4" />
      </button>
      {open ? (
        <div className="absolute end-0 top-9 z-20 w-36 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop">
          {items.map((item) => (
            <button
              className={`block w-full px-3 py-2 text-start text-[13px] transition-colors hover:bg-surface-2 ${
                item.danger ? "text-danger" : "text-ink"
              }`}
              key={item.label}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------- search results

const KIND_LABEL_KEYS: Record<
  string,
  | "knowledge_kind_run"
  | "knowledge_kind_answer"
  | "knowledge_kind_source"
  | "knowledge_kind_document"
  | "knowledge_kind_memory"
  | "knowledge_kind_call"
  | "knowledge_kind_task"
  | "knowledge_kind_clarify"
> = {
  run: "knowledge_kind_run",
  answer: "knowledge_kind_answer",
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
  onOpen,
  onOpenThread,
}: {
  groups: Map<string, KnowledgeItem[]>;
  onOpen: (item: KnowledgeItem) => void;
  onOpenThread: (id: string) => void;
}) {
  const t = useT();
  if (groups.size === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-2 py-20 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
          <Search aria-hidden="true" className="size-7" />
        </span>
        <p className="mt-4 text-sm text-ink-2">{t("knowledge_thread_no_match")}</p>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {[...groups.entries()].map(([kind, items]) => {
        const labelKey = KIND_LABEL_KEYS[kind] ?? "knowledge_kind_source";
        return (
          <div key={kind}>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-ink-3">
              <Globe aria-hidden="true" className="size-3.5" />
              {t(labelKey)}
              <span className="text-ink-3/60">{items.length}</span>
            </p>
            <div className="overflow-hidden rounded-2xl border border-line bg-surface">
              {items.map((item, index) => (
                <button
                  className={`flex w-full flex-col gap-1 px-4 py-3 text-start transition-colors hover:bg-surface-2 ${
                    index !== items.length - 1 ? "border-b border-line" : ""
                  }`}
                  key={item.id}
                  onClick={() => {
                    if (item.kind === "source" || item.kind === "document") {
                      onOpen(item);
                      return;
                    }
                    if (item.threadId) {
                      onOpenThread(item.threadId);
                    }
                  }}
                  type="button"
                >
                  <span className="line-clamp-2 text-[15px] font-medium leading-snug text-ink">
                    {item.title || item.body.slice(0, 80) || item.url}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                    <span className="shrink-0">{formatDate(new Date(item.updated).toISOString())}</span>
                    {item.host ? <span className={CHIP}>{item.host}</span> : null}
                    {item.cited > 0 ? (
                      <span className={CHIP}>{t("knowledge_source_cited", { n: String(item.cited) })}</span>
                    ) : null}
                    {item.body && item.kind !== "source" ? (
                      <span className="min-w-0 flex-1 truncate">{item.body.slice(0, 90)}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
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
  onForget,
  onView,
  view,
}: {
  memories: MemoryRow[];
  onForget: (id: string) => void;
  onView: (view: "timeline" | "cards") => void;
  view: "timeline" | "cards";
}) {
  const t = useT();
  if (memories === null) {
    return null;
  }
  if (memories.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-2 py-20 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
          <MemoryStick aria-hidden="true" className="size-7" />
        </span>
        <p className="mt-4 text-sm text-ink-2">{t("knowledge_memory_empty")}</p>
      </div>
    );
  }
  // group by day for the timeline view (LobeHub's GroupedVirtuoso shape,
  // minus the virtualization -- browser-local scale is hundreds of rows)
  const groups = new Map<string, MemoryRow[]>();
  for (const memory of memories) {
    const day = formatDate(new Date(memory.updated).toISOString());
    const list = groups.get(day) ?? [];
    list.push(memory);
    groups.set(day, list);
  }
  return (
    <div>
      <div className="mb-3 flex items-center gap-1.5">
        {(["timeline", "cards"] as const).map((mode) => (
          <button
            aria-pressed={view === mode}
            className={`rounded-full px-3 py-1.5 text-[13px] transition-colors ${
              view === mode
                ? "bg-accent-soft font-medium text-accent"
                : "border border-line text-ink-3 hover:bg-surface-2 hover:text-ink"
            }`}
            key={mode}
            onClick={() => onView(mode)}
            type="button"
          >
            {mode === "timeline" ? t("knowledge_memory_timeline") : t("knowledge_memory_cards")}
          </button>
        ))}
      </div>
      {view === "timeline" ? (
        <div className="relative ps-5">
          <span aria-hidden="true" className="absolute inset-block-0 start-2 w-px bg-line" />
          {[...groups.entries()].map(([day, rows]) => (
            <div className="mb-5" key={day}>
              <p className="relative mb-2 text-xs font-medium text-ink-3">
                <span
                  aria-hidden="true"
                  className="absolute -start-[13px] top-1 size-2 rounded-full bg-accent-strong"
                />
                {day}
              </p>
              {rows.map((memory) => (
                <MemoryCard key={memory.id} memory={memory} onForget={onForget} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {memories.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} onForget={onForget} />
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryCard({ memory, onForget }: { memory: MemoryRow; onForget: (id: string) => void }) {
  const t = useT();
  return (
    <div className="group flex items-start gap-2.5 rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2">
      <MemoryStick aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
      <p className="min-w-0 flex-1 break-words text-[13px] leading-relaxed text-ink" dir="auto">
        {memory.content}
      </p>
      <button
        aria-label={t("knowledge_memory_forget")}
        className="shrink-0 rounded-md p-1 text-ink-3 opacity-0 transition-opacity hover:bg-surface-2 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
        onClick={() => onForget(memory.id)}
        title={t("knowledge_memory_forget")}
        type="button"
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

// -------------------------------------------------------------- inspector

/** The morphic inspector: a source/document hit's reading pane -- an
    end-anchored panel on the desktop, a full sheet on the narrow view. */
export function Inspector({
  body,
  item,
  onClose,
}: {
  body: string | null;
  item: KnowledgeItem;
  onClose: () => void;
  onOpenThread: (id: string) => void;
}) {
  const t = useT();
  const ref = useDialogFocus<HTMLDivElement>(true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const isDocument = item.kind === "document";
  const markdown = isDocument ? (body ?? "") : "";
  return (
    <div aria-hidden="false">
      <div aria-label={t("knowledge_title")} className="fixed inset-0 z-50 animate-fade-in" ref={ref} role="dialog">
        <button
          aria-label={t("close")}
          className="absolute inset-0 cursor-default bg-black/60"
          onClick={onClose}
          type="button"
        />
        <div className="absolute inset-y-0 end-0 flex w-full flex-col bg-bg shadow-pop animate-slide-in-right sm:max-w-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{item.title || item.url}</p>
            <div className="flex items-center gap-1">
              {item.url ? (
                <a
                  aria-label={t("open_in_new_tab")}
                  className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                  href={item.url}
                  rel="noreferrer"
                  target="_blank"
                  title={t("open_in_new_tab")}
                >
                  <ExternalLink aria-hidden="true" className="size-4" />
                </a>
              ) : null}
              {item.threadId ? (
                <Link
                  ariaLabel={t("knowledge_kind_run")}
                  className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                  href={threadUrl(item.threadId)}
                  title={t("knowledge_kind_run")}
                >
                  <MessageCircleQuestion aria-hidden="true" className="size-4" />
                </Link>
              ) : null}
              <button
                aria-label={t("close")}
                className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                onClick={onClose}
                type="button"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
            {!isDocument ? (
              item.body ? (
                <>
                  <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">
                    {item.body}
                  </pre>
                  <p className="mt-3 text-xs text-ink-3">{t("knowledge_inspector_not_read")}</p>
                </>
              ) : (
                <p className="text-[13px] text-ink-3">{t("knowledge_inspector_not_read")}</p>
              )
            ) : body === null ? (
              <p className="text-[13px] text-ink-3">…</p>
            ) : body === "" ? (
              <p className="text-[13px] text-ink-3">{t("knowledge_inspector_not_read")}</p>
            ) : (
              <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{markdown}</pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- kind items

/** One kind's directory listing (the filter chips' non-search view):
    answers / sources / documents as rows.  Sources and documents open
    the inspector; answers navigate to their thread. */
export function KindItemRows({
  items,
  onOpenInspector,
  onOpenThread,
  showKind = false,
}: {
  items: KnowledgeItem[];
  onOpenInspector: (item: KnowledgeItem) => void;
  onOpenThread: (id: string) => void;
  /** the mixed "全部" feed labels every row with its kind */
  showKind?: boolean;
}) {
  const t = useT();
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-2 py-20 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
          <Layers aria-hidden="true" className="size-7" />
        </span>
        <p className="mt-4 text-sm text-ink-2">{t("knowledge_kind_empty")}</p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      {items.map((item, index) => {
        const opens = item.kind === "source" || item.kind === "document";
        return (
          <button
            className={`flex w-full flex-col gap-1 px-4 py-3 text-start transition-colors hover:bg-surface-2 ${
              index !== items.length - 1 ? "border-b border-line" : ""
            }`}
            key={item.id}
            onClick={() => {
              if (opens) {
                onOpenInspector(item);
                return;
              }
              if (item.threadId) {
                onOpenThread(item.threadId);
              }
            }}
            type="button"
          >
            <span className="line-clamp-2 text-[15px] font-medium leading-snug text-ink">
              {item.title || item.body.slice(0, 90) || item.url}
            </span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
              <span className="shrink-0">{formatDate(new Date(item.updated).toISOString())}</span>
              {showKind ? (
                <span className={CHIP}>{t(KIND_LABEL_KEYS[item.kind] ?? "knowledge_kind_source")}</span>
              ) : null}
              {item.host ? <span className={CHIP}>{item.host}</span> : null}
              {item.cited > 0 ? (
                <span className={CHIP}>{t("knowledge_source_cited", { n: String(item.cited) })}</span>
              ) : null}
              {item.refs > 0 ? (
                <span className={CHIP}>{t("knowledge_source_refs", { n: String(item.refs) })}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ admin

/** The admin drawer: the old preferences PgliteTab's duties moved into
    the knowledge page -- per-kind row counts, the storage estimate, the
    embedding model, and the two destructive actions behind confirm
    dialogs the parent owns. */
export function AdminPanel({
  onClose,
  onClear,
  onReset,
  stats,
}: {
  onClose: () => void;
  onClear: () => void;
  onReset: () => void;
  stats: KnowledgeStats | null;
}) {
  const t = useT();
  const ref = useDialogFocus<HTMLDivElement>(true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const rows: Array<{ label: string; value: string }> = stats
    ? [
        { label: t("knowledge_admin_threads"), value: String(stats.threads) },
        { label: t("knowledge_admin_runs"), value: String(stats.runs) },
        { label: t("knowledge_admin_answers"), value: String(stats.answers) },
        { label: t("knowledge_admin_sources"), value: String(stats.sources) },
        { label: t("knowledge_admin_documents"), value: String(stats.documents) },
        { label: t("knowledge_admin_memories"), value: String(stats.memories) },
        { label: t("knowledge_admin_events"), value: String(stats.events) },
        { label: t("knowledge_stat_size", { size: formatBytesLocal(stats.approxBytes) }), value: "" },
        { label: t("knowledge_admin_embed"), value: stats.embedModel ?? "—" },
      ]
    : [];
  return (
    <div aria-hidden="false">
      <div aria-label={t("knowledge_admin_title")} className="fixed inset-0 z-50 animate-fade-in" role="dialog">
        <button
          aria-label={t("close")}
          className="absolute inset-0 cursor-default bg-black/60"
          onClick={onClose}
          type="button"
        />
        <div className="absolute inset-y-0 end-0 flex w-full flex-col bg-bg shadow-pop animate-slide-in-right sm:max-w-md">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <div className="flex items-center gap-2">
              <Database aria-hidden="true" className="size-4.5 text-ink-3" />
              <h2 className="text-base font-semibold text-ink">{t("knowledge_admin_title")}</h2>
            </div>
            <button
              aria-label={t("close")}
              className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
              onClick={onClose}
              type="button"
            >
              <X aria-hidden="true" className="size-4.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5" ref={ref}>
            <dl className="grid grid-cols-2 gap-2">
              {rows.map((row) => (
                <div className="rounded-xl border border-line bg-surface px-3 py-2.5" key={row.label}>
                  <dt className="text-xs text-ink-3">{row.label}</dt>
                  <dd className="mt-0.5 truncate text-sm font-medium text-ink">{row.value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-6 space-y-3 border-t border-line pt-5">
              <button
                className="flex w-full items-center justify-between rounded-xl border border-line px-4 py-3 text-start text-[13px] text-ink transition-colors hover:bg-surface-2"
                onClick={onClear}
                type="button"
              >
                {t("knowledge_admin_clear")}
                <Trash2 aria-hidden="true" className="size-4 text-ink-3" />
              </button>
              <button
                className="flex w-full items-center justify-between rounded-xl border border-danger/40 px-4 py-3 text-start text-[13px] text-danger transition-colors hover:bg-danger/5"
                onClick={onReset}
                type="button"
              >
                {t("knowledge_admin_reset")}
                <Trash2 aria-hidden="true" className="size-4" />
              </button>
              <p className="text-xs leading-relaxed text-ink-3">{t("knowledge_admin_reset_desc")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shared

/** The one confirm dialog every destructive action funnels through (the
    knowledge drawer's old pattern). */
export function ConfirmDialog({
  cancel,
  message,
  onConfirm,
  title,
}: {
  cancel: () => void;
  message: string;
  onConfirm: () => void;
  title: string;
}) {
  const t = useT();
  const ref = useDialogFocus<HTMLDivElement>(true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div aria-hidden="true" className="absolute inset-0 bg-black/60" />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-line bg-surface p-5" ref={ref}>
        <h3 className="text-base font-semibold text-ink">{title}</h3>
        <p className="mt-2 break-words text-sm leading-relaxed text-ink-2">{message}</p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            className="rounded-full px-4 py-1.5 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            onClick={cancel}
            type="button"
          >
            {t("ai_delete_cancel")}
          </button>
          <button
            className="rounded-full bg-danger px-4 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
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

/** A tiny dropdown (the row menus): closes on outside click. */
export function Dropdown({ children, label }: { children: ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        aria-expanded={open}
        className="flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        {label}
        <ChevronDown aria-hidden="true" className="size-3.5" />
      </button>
      {open ? (
        <div className="absolute start-0 top-9 z-20 w-40 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop">
          {children}
        </div>
      ) : null}
    </div>
  );
}
