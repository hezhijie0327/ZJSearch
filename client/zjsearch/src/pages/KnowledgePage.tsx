// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Database, LibraryBig, Network, Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Shell } from "@/components/Shell.tsx";
import {
  AdminPanel,
  ConfirmDialog,
  Dropdown,
  formatBytesLocal,
  Inspector,
  KindItemRows,
  MemorySection,
  SearchResults,
  ThreadRows,
} from "@/features/knowledge/sections.tsx";
import { TagGraphView } from "@/features/knowledge/TagGraphView.tsx";
import { useT } from "@/lib/i18n.ts";
import {
  clearAllStudies,
  deleteThread,
  forgetMemory,
  type KnowledgeItem,
  type KnowledgeStats,
  knowledgeStats,
  listKind,
  loadDocument,
  type MemoryRow,
  resetAll,
  type StoreSubscription,
  searchKnowledge,
  subscribeMemories,
  subscribeThreads,
  type ThreadSummary,
  threadUrl,
  toggleThreadPin,
} from "@/lib/knowledgeStore.ts";
import { flashToast } from "@/lib/toast.ts";
import type { KnowledgePageData } from "@/lib/types.ts";

/**
 * The knowledge-base page (`/zjsearch/knowledge`): the browser-local
 * research library.  Vane's Library page supplies the shape (hero header,
 * row list -- the detail lives on the AI thread page), morphic's history
 * supplies the interactions (per-row menu, delete confirm, inspector
 * panel), LobeHub's memory surface supplies the memory views (timeline +
 * cards, tag chips).  On top of those: the cross-kind hybrid search and
 * the tag graph -- the two capabilities the event-sourced knowledge table
 * uniquely enables.
 */

type KindFilter = "all" | "run" | "answer" | "source" | "document" | "memory";
type TimeFilter = "any" | "week" | "month";

const WEEK = 7 * 24 * 3600 * 1000;
const MONTH = 30 * 24 * 3600 * 1000;

export function KnowledgePage({ data }: { data: KnowledgePageData }) {
  const t = useT();
  const globals = data.globals;

  // ── the thread directory (live) ──────────────────────────────────────
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    const subs: StoreSubscription[] = [];
    subscribeThreads((rows) => {
      if (alive) setThreads(rows);
    })
      .then((sub) => {
        if (alive) subs.push(sub);
        else sub.unsubscribe();
      })
      .catch(() => {
        if (alive) setThreads([]);
      });
    return () => {
      alive = false;
      for (const sub of subs) sub.unsubscribe();
    };
  }, []);

  // ── search (debounced cross-kind hybrid) ─────────────────────────────
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const searching = debounced !== "";
  const [results, setResults] = useState<KnowledgeItem[] | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!debounced) {
      setResults(null);
      return;
    }
    let cancelled = false;
    searchKnowledge(debounced, {}, 30)
      .then((rows) => {
        if (!cancelled) setResults(rows);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  // ── filters ──────────────────────────────────────────────────────────
  const [kind, setKind] = useState<KindFilter>("all");
  const [time, setTime] = useState<TimeFilter>("any");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const since = time === "week" ? Date.now() - WEEK : time === "month" ? Date.now() - MONTH : 0;

  // ── memories (live, fetched for the memory view) ─────────────────────
  const [memories, setMemories] = useState<MemoryRow[] | null>(null);
  const [memoryView, setMemoryView] = useState<"timeline" | "cards">("timeline");
  useEffect(() => {
    if (kind !== "memory") {
      return;
    }
    let alive = true;
    const subs: StoreSubscription[] = [];
    subscribeMemories((rows) => {
      if (alive) setMemories(rows);
    })
      .then((sub) => {
        if (alive) subs.push(sub);
        else sub.unsubscribe();
      })
      .catch(() => {
        if (alive) setMemories([]);
      });
    return () => {
      alive = false;
      for (const sub of subs) sub.unsubscribe();
    };
  }, [kind]);

  // ── stats (mount + focus + after directory/memories changes) ─────────
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const threadsLen = threads?.length ?? -1;
  const memoriesLen = memories?.length ?? -1;
  useEffect(() => {
    // the stats re-read on mount, when the directory/memories change
    // shape (a new run, a new fact) and on window focus (a sync may have
    // landed); the lens reads keep the deps honest
    if (threadsLen < -1 || memoriesLen < -1) {
      return;
    }
    const refresh = () => {
      void knowledgeStats()
        .then((value) => setStats(value))
        .catch(() => setStats(null));
    };
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [threadsLen, memoriesLen]);

  // ── the kind directory (a filter chip's own listing, non-search) ────
  const [kindItems, setKindItems] = useState<KnowledgeItem[] | null>(null);
  const kindListing = !searching && (kind === "answer" || kind === "source" || kind === "document");
  useEffect(() => {
    if (!kindListing || threadsLen < -1) {
      setKindItems(null);
      return;
    }
    let cancelled = false;
    listKind(kind, 40)
      .then((rows) => {
        if (!cancelled) setKindItems(rows);
      })
      .catch(() => {
        if (!cancelled) setKindItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, kindListing, threadsLen]);

  // ── the inspector (a source/document hit's reading pane) ─────────────
  const [inspected, setInspected] = useState<KnowledgeItem | null>(null);
  const [inspectedBody, setInspectedBody] = useState<string | null>(null);
  useEffect(() => {
    if (inspected?.kind !== "document") {
      setInspectedBody(null);
      return;
    }
    let cancelled = false;
    loadDocument(inspected.url ?? "")
      .then((page) => {
        if (!cancelled) setInspectedBody(page?.markdown ?? "");
      })
      .catch(() => {
        if (!cancelled) setInspectedBody("");
      });
    return () => {
      cancelled = true;
    };
  }, [inspected]);

  // ── graph view + dialogs ─────────────────────────────────────────────
  const [graphOpen, setGraphOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [confirming, setConfirming] = useState<"reset" | "clear" | { thread: ThreadSummary } | null>(null);

  const navigateThread = (id: string) => {
    window.history.pushState({}, "", threadUrl(id));
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  const visibleThreads = useMemo(() => {
    let rows = threads ?? [];
    if (pinnedOnly) rows = rows.filter((thread) => thread.pinned);
    if (since) rows = rows.filter((thread) => thread.updated >= since);
    if (debounced) {
      const needle = debounced.toLowerCase();
      rows = rows.filter((thread) => thread.title.toLowerCase().includes(needle));
    }
    return rows;
  }, [threads, pinnedOnly, since, debounced]);

  const searchByKind = useMemo(() => {
    const groups = new Map<string, KnowledgeItem[]>();
    for (const item of results ?? []) {
      if (kind !== "all" && item.kind !== kind) continue;
      if (pinnedOnly && !item.pinned) continue;
      if (since && item.updated < since) continue;
      const list = groups.get(item.kind) ?? [];
      list.push(item);
      groups.set(item.kind, list);
    }
    return groups;
  }, [results, kind, pinnedOnly, since]);

  const memoryList = useMemo(() => {
    const rows = memories ?? [];
    if (!debounced) return rows;
    const needle = debounced.toLowerCase();
    return rows.filter((memory) => memory.content.toLowerCase().includes(needle));
  }, [memories, debounced]);

  const kindChips: Array<{ id: KindFilter; label: string }> = [
    { id: "all", label: t("knowledge_filter_all") },
    { id: "run", label: t("knowledge_kind_run") },
    { id: "answer", label: t("knowledge_kind_answer") },
    { id: "source", label: t("knowledge_kind_source") },
    { id: "document", label: t("knowledge_kind_document") },
    { id: "memory", label: t("knowledge_kind_memory") },
  ];
  const timeLabel =
    time === "any" ? t("knowledge_time_any") : time === "week" ? t("knowledge_time_week") : t("knowledge_time_month");

  return (
    <Shell globals={globals}>
      <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-6 sm:px-6">
        {/* ── hero ── */}
        <div className="flex flex-col gap-3 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-3">
            <LibraryBig aria-hidden="true" className="size-8 text-ink-2" />
            <div>
              <h1 className="font-serif text-2xl font-semibold text-ink">{t("knowledge_title")}</h1>
              <p className="mt-0.5 text-[13px] text-ink-3">{t("knowledge_page_subtitle")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-ink-3">
            {stats ? (
              <>
                <span className="rounded-full border border-line px-2 py-0.5">
                  {t("knowledge_stat_threads", { n: String(stats.threads) })}
                </span>
                <span className="rounded-full border border-line px-2 py-0.5">
                  {t("knowledge_stat_sources_n", { n: String(stats.sources) })}
                </span>
                <span className="hidden rounded-full border border-line px-2 py-0.5 sm:inline">
                  {t("knowledge_stat_size", { size: formatBytesLocal(stats.approxBytes) })}
                </span>
              </>
            ) : null}
            <button
              className="flex items-center gap-1 rounded-full border border-line px-2.5 py-1 transition-colors hover:bg-surface-2 hover:text-ink"
              onClick={() => setAdminOpen(true)}
              type="button"
            >
              <Database aria-hidden="true" className="size-3.5" />
              {t("knowledge_admin")}
            </button>
          </div>
        </div>

        {/* ── search ── */}
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 transition-colors focus-within:border-accent">
          <Search aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
          <input
            aria-label={t("knowledge_search_placeholder")}
            className="h-6 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("knowledge_search_placeholder")}
            type="text"
            value={query}
          />
          {query ? (
            <button
              aria-label={t("knowledge_inspector_close")}
              className="text-ink-3 transition-colors hover:text-ink"
              onClick={() => setQuery("")}
              type="button"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </div>

        {/* ── filters ── */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {kindChips.map((chip) => (
            <button
              aria-pressed={kind === chip.id}
              className={`rounded-full px-3 py-1.5 text-[13px] transition-colors ${
                kind === chip.id
                  ? "bg-accent-soft font-medium text-accent"
                  : "border border-line text-ink-3 hover:bg-surface-2 hover:text-ink"
              }`}
              key={chip.id}
              onClick={() => setKind(chip.id)}
              type="button"
            >
              {chip.label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-line" />
          <Dropdown label={timeLabel}>
            {(["any", "week", "month"] as TimeFilter[]).map((option) => (
              <button
                className="block w-full px-3 py-2 text-start text-[13px] text-ink transition-colors hover:bg-surface-2"
                key={option}
                onClick={() => setTime(option)}
                type="button"
              >
                {option === "any"
                  ? t("knowledge_time_any")
                  : option === "week"
                    ? t("knowledge_time_week")
                    : t("knowledge_time_month")}
              </button>
            ))}
          </Dropdown>
          <button
            aria-pressed={pinnedOnly}
            className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-[13px] transition-colors ${
              pinnedOnly
                ? "bg-accent-soft font-medium text-accent"
                : "border border-line text-ink-3 hover:bg-surface-2 hover:text-ink"
            }`}
            onClick={() => setPinnedOnly((prev) => !prev)}
            type="button"
          >
            <Star aria-hidden="true" className="size-3.5" />
            {t("knowledge_pinned_only")}
          </button>
          <button
            aria-pressed={graphOpen}
            className={`ms-auto flex items-center gap-1 rounded-full px-3 py-1.5 text-[13px] transition-colors ${
              graphOpen
                ? "bg-accent-soft font-medium text-accent"
                : "border border-line text-ink-3 hover:bg-surface-2 hover:text-ink"
            }`}
            onClick={() => setGraphOpen((prev) => !prev)}
            type="button"
          >
            <Network aria-hidden="true" className="size-3.5" />
            {graphOpen ? t("knowledge_graph_list") : t("knowledge_graph")}
          </button>
        </div>

        {/* ── body ── */}
        <div className="mt-5">
          {kind === "memory" ? (
            <MemorySection
              memories={memoryList}
              onForget={(id) => {
                forgetMemory(id);
                flashToast(t("knowledge_memory_forgot"), { tone: "accent" });
              }}
              onView={setMemoryView}
              view={memoryView}
            />
          ) : graphOpen ? (
            <TagGraphView
              onSelectTag={(tag) => {
                setQuery(tag);
                setGraphOpen(false);
              }}
            />
          ) : searching ? (
            <SearchResults groups={searchByKind} onOpen={setInspected} onOpenThread={navigateThread} />
          ) : kindListing ? (
            kindItems === null ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }, (_, i) => (
                  <span className="zjs-skeleton block h-16 rounded-xl" key={i} />
                ))}
              </div>
            ) : (
              <KindItemRows items={kindItems} onOpenInspector={setInspected} onOpenThread={navigateThread} />
            )
          ) : (
            <ThreadRows
              onOpen={navigateThread}
              onPin={(thread, on) => toggleThreadPin(thread.id, on)}
              onRemove={(thread) => setConfirming({ thread })}
              threads={visibleThreads}
            />
          )}
        </div>
      </div>

      {/* ── confirm dialog (every deletion funnels through one dialog) ── */}
      {confirming ? (
        <ConfirmDialog
          cancel={() => setConfirming(null)}
          message={
            typeof confirming === "string"
              ? t(confirming === "reset" ? "knowledge_admin_reset_confirm" : "knowledge_admin_clear_confirm")
              : t("ai_delete_body", { label: confirming.thread.title })
          }
          onConfirm={() => {
            if (confirming === "reset") {
              resetAll();
              flashToast(t("knowledge_admin_reset_done"), { tone: "accent" });
            } else if (confirming === "clear") {
              clearAllStudies();
              flashToast(t("knowledge_admin_clear_done"), { tone: "accent" });
            } else {
              deleteThread(confirming.thread.id);
              flashToast(t("knowledge_deleted"), { tone: "accent" });
            }
            setConfirming(null);
          }}
          title={t("ai_delete_title")}
        />
      ) : null}

      {/* ── admin drawer ── */}
      {adminOpen ? (
        <AdminPanel
          onClear={() => setConfirming("clear")}
          onClose={() => {
            setAdminOpen(false);
            void knowledgeStats()
              .then((value) => setStats(value))
              .catch(() => setStats(null));
          }}
          onReset={() => setConfirming("reset")}
          stats={stats}
        />
      ) : null}

      {/* ── inspector (source/document reading pane) ── */}
      {inspected ? (
        <Inspector
          body={inspectedBody}
          item={inspected}
          onClose={() => setInspected(null)}
          onOpenThread={(id) => {
            setInspected(null);
            navigateThread(id);
          }}
        />
      ) : null}
    </Shell>
  );
}
