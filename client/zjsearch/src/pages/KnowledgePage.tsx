// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  Database,
  FileText,
  Globe,
  LayoutTemplate,
  LibraryBig,
  MemoryStick,
  MessageCircleQuestion,
  Network,
  Search,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Shell } from "@/components/Shell.tsx";
import {
  AdminView,
  ConfirmDialog,
  Dropdown,
  InspectorView,
  KindItemRows,
  MemorySection,
  SearchResults,
  ThreadRows,
} from "@/features/knowledge/sections.tsx";
import { TagGraphView } from "@/features/knowledge/TagGraphView.tsx";
import { useOverlay } from "@/features/overlay/OverlayProvider.tsx";
import { useT } from "@/lib/i18n.ts";
import { loadDocument, loadItemBody, loadThreadAnswer, type ThreadAnswer } from "@/lib/kb/inspector.ts";
import { type StoreSubscription, subscribeMemories, subscribeThreads } from "@/lib/kb/live.ts";
import {
  deleteItem,
  deleteSource,
  deleteThread,
  forgetMemory,
  type MemoryRow,
  renameThread,
  resetAll,
  saveMemory,
  toggleItemPin,
  toggleThreadPin,
  updateMemory,
} from "@/lib/kb/projections.ts";
import { listKind, searchKnowledge, type ThreadSummary } from "@/lib/kb/recall.ts";
import { type KnowledgeItem, threadUrl } from "@/lib/kb/shared.ts";
import { type KnowledgeStats, knowledgeStats } from "@/lib/kb/stats.ts";
import { useRouter } from "@/lib/router.tsx";
import { SEGMENT, SEGMENT_ACTIVE, SEGMENT_IDLE } from "@/lib/styles.ts";
import { flashToast } from "@/lib/toast.ts";
import type { KnowledgePageData } from "@/lib/types.ts";
import { TemplateManagerPanel } from "@/pages/TemplateManager.tsx";

/**
 * The knowledge base (`/zjsearch/knowledge`): the browser-local research
 * library.  It lives in TWO shells -- the header button opens it as a
 * slide-in panel (`embedded`, the about/stats/preferences pattern) and the
 * standalone page stays for deep links.  Vane's Library page supplies the
 * shape (hero header, row list -- the detail lives on the AI thread page),
 * morphic's history supplies the interactions (per-row menu, delete
 * confirm, inspector panel), LobeHub's memory surface supplies the memory
 * views (timeline + cards, tag chips).  On top of those: the cross-kind
 * hybrid search and the tag graph -- the two capabilities the
 * event-sourced knowledge table uniquely enables.
 */

type KindFilter = "run" | "answer" | "source" | "document" | "memory";
type TimeFilter = "any" | "week" | "month";

const WEEK = 7 * 24 * 3600 * 1000;
const MONTH = 30 * 24 * 3600 * 1000;

export function KnowledgePage({ data, embedded = false }: { data: KnowledgePageData; embedded?: boolean }) {
  const t = useT();
  const { navigate } = useRouter();
  const { closeOverlay } = useOverlay();
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

  // ── view tab: the overview archive (the classic page's AI 概览) leads,
  // then the research threads, sources, documents, memories; the graph is
  // a VIEW (global, memory rows carry no tags) and admin closes the bar ──
  const [kind, setKind] = useState<KindFilter | "graph" | "templates" | "admin">("answer");
  // the one-shot listings (feed / kind directories) are not live: a bump
  // re-fetches them after a pin or a delete lands
  const [listingBump, setListingBump] = useState(0);
  const [time, setTime] = useState<TimeFilter>("any");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const since = time === "week" ? Date.now() - WEEK : time === "month" ? Date.now() - MONTH : 0;

  // ── memories (live, fetched for the memory view) ─────────────────────
  const [memories, setMemories] = useState<MemoryRow[] | null>(null);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: listingBump only re-fetches the one-shot listing
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
  }, [kind, kindListing, threadsLen, listingBump]);

  // ── panel views: the inspector is an in-panel view over whatever tab is
  // open (the panel NAVIGATES, it never stacks a second drawer) ──────────
  const [view, setView] = useState<"library" | KnowledgeItem>("library");
  const inspected = view === "library" ? null : view;
  const [inspectedBody, setInspectedBody] = useState<string | null>(null);
  const [inspectedExtras, setInspectedExtras] = useState<{
    sources: ThreadAnswer["sources"];
    usage: ThreadAnswer["usage"];
  } | null>(null);
  useEffect(() => {
    if (inspected?.kind === "document") {
      let cancelled = false;
      loadDocument(inspected.url ?? "")
        .then((page) => {
          if (!cancelled) setInspectedBody(page?.markdown ?? "");
        })
        .catch(() => {
          if (!cancelled) setInspectedBody("");
        });
      setInspectedExtras(null);
      return () => {
        cancelled = true;
      };
    }
    if (inspected?.kind === "run") {
      // the thread's full answer + cited sources + token usage, off the
      // run_summary rollup row
      let cancelled = false;
      loadThreadAnswer(inspected.threadId ?? "")
        .then((result) => {
          if (cancelled) return;
          setInspectedBody(result.answer);
          setInspectedExtras({ sources: result.sources, usage: result.usage });
        })
        .catch(() => {
          if (!cancelled) {
            setInspectedBody("");
            setInspectedExtras(null);
          }
        });
      return () => {
        cancelled = true;
      };
    }
    if (inspected?.kind === "answer") {
      // the overview archive's full text: the listing rows carry the
      // 600-char head excerpt only
      let cancelled = false;
      loadItemBody(inspected.id)
        .then((text) => {
          if (!cancelled) setInspectedBody(text);
        })
        .catch(() => {
          if (!cancelled) setInspectedBody("");
        });
      setInspectedExtras(null);
      return () => {
        cancelled = true;
      };
    }
    setInspectedBody(null);
    setInspectedExtras(null);
    return undefined;
  }, [inspected]);

  // ── dialogs ──────────────────────────────────────────────────────────
  const [confirming, setConfirming] = useState<"reset" | { label: string; run: () => void } | null>(null);
  const pinItem = (item: KnowledgeItem, on: boolean) => {
    toggleItemPin(item.id, on);
    setListingBump((b) => b + 1);
  };
  const removeItem = (item: KnowledgeItem, after?: () => void) => {
    setConfirming({
      label: item.title || item.url || t("knowledge_title"),
      run: () => {
        if (item.kind === "source" || item.kind === "document") {
          deleteSource(item.url ?? "");
        } else {
          deleteItem(item.id);
        }
        after?.();
      },
    });
  };

  const navigateThread = (id: string) => {
    // panel context: the drawer fades while the main view swaps to the
    // thread (a thread is a work surface, not a panel page); standalone
    // the close is a no-op
    closeOverlay();
    window.history.pushState({}, "", threadUrl(id));
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  const goHome = () => {
    closeOverlay();
    navigate("/");
  };

  /** A thread's inspector item: the answer loads from the evt log and the
      查看研究 pill jumps to the full thread page. */
  const openThreadInspector = (threadId: string, title: string) => {
    setView({
      body: "",
      cited: 0,
      host: null,
      id: `thread:${threadId}`,
      kind: "run",
      meta: {},
      n: null,
      pinned: false,
      refs: 0,
      runId: null,
      status: "done",
      tags: [],
      threadId,
      title,
      updated: Date.now(),
      url: null,
      urlHash: null,
    });
  };

  const refreshStats = () => {
    void knowledgeStats()
      .then((value) => setStats(value))
      .catch(() => setStats(null));
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
      if (item.kind !== kind) continue;
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

  // the search box serves the five content kinds; the time/pinned filter
  // row only the four list kinds (memories are a timeline -- they neither
  // pin nor take a time filter, the timeline groups by day itself)
  const contentTab = kind !== "graph" && kind !== "admin";
  const listTab = kind === "run" || kind === "answer" || kind === "source" || kind === "document";
  const viewTabs: Array<{ id: KindFilter | "graph" | "templates" | "admin"; label: string; icon: ReactNode }> = [
    { id: "answer", label: t("knowledge_kind_answer"), icon: <Sparkles className="size-3.5" /> },
    { id: "run", label: t("knowledge_kind_run"), icon: <MessageCircleQuestion className="size-3.5" /> },
    { id: "source", label: t("knowledge_kind_source"), icon: <Globe className="size-3.5" /> },
    { id: "document", label: t("knowledge_kind_document"), icon: <FileText className="size-3.5" /> },
    { id: "memory", label: t("knowledge_kind_memory"), icon: <MemoryStick className="size-3.5" /> },
    { id: "graph", label: t("knowledge_graph"), icon: <Network className="size-3.5" /> },
    { id: "templates", label: t("knowledge_tab_templates"), icon: <LayoutTemplate className="size-3.5" /> },
    { id: "admin", label: t("knowledge_admin"), icon: <Database className="size-3.5" /> },
  ];
  const graphOpen = kind === "graph";
  const timeLabel =
    time === "any" ? t("knowledge_time_any") : time === "week" ? t("knowledge_time_week") : t("knowledge_time_month");

  return (
    <Shell embedded={embedded} globals={globals}>
      <div className={`mx-auto w-full max-w-3xl px-4 sm:px-6 ${embedded ? "pb-8 pt-2" : "pb-24 pt-6"}`}>
        {/* ── page heading (standalone only; the drawer chrome carries the title in the panel) ── */}
        {embedded ? null : (
          <div className="py-5">
            <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-ink">
              <LibraryBig aria-hidden="true" className="size-5 shrink-0 text-accent" />
              {t("knowledge_title")}
            </h1>
            <p className="mt-1 text-[13px] text-ink-3">{t("knowledge_page_subtitle")}</p>
          </div>
        )}

        {inspected ? (
          <InspectorView
            body={inspectedBody}
            extras={inspectedExtras}
            item={inspected}
            onBack={() => setView("library")}
            onOpenThread={navigateThread}
            onPin={pinItem}
            onRemove={(item) => removeItem(item, () => setView("library"))}
          />
        ) : (
          <>
            {/* ── kind tabs (the preference-page segmented language) ── */}
            <div className="flex flex-wrap gap-1.5 rounded-2xl border border-line bg-surface p-2" role="tablist">
              {viewTabs.map((tab) => (
                <button
                  aria-controls="knowledge-panel"
                  aria-selected={kind === tab.id}
                  className={`${SEGMENT} flex-1 ${kind === tab.id ? SEGMENT_ACTIVE : SEGMENT_IDLE}`}
                  id={`knowledge-tab-${tab.id}`}
                  key={tab.id}
                  onClick={() => setKind(tab.id)}
                  role="tab"
                  type="button"
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            {/* ── search ── */}
            {contentTab ? (
              <div className="mt-3 flex items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-3 transition-colors focus-within:border-accent">
                <Search aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                <input
                  aria-label={t("knowledge_search_placeholder")}
                  className="h-7 w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-3"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={
                    kind === "templates" ? t("knowledge_search_templates") : t("knowledge_search_placeholder")
                  }
                  type="text"
                  value={query}
                />
                {query ? (
                  <button
                    aria-label={t("clear")}
                    className="grid size-6 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                    onClick={() => setQuery("")}
                    type="button"
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* ── toolbar: the time/pinned filters, list kinds only ── */}
            {listTab ? (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
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
              </div>
            ) : null}

            {/* ── body ── */}
            <div aria-labelledby={`knowledge-tab-${kind}`} className="mt-5" id="knowledge-panel" role="tabpanel">
              {kind === "admin" ? (
                <AdminView onReset={() => setConfirming("reset")} stats={stats} />
              ) : kind === "templates" ? (
                <TemplateManagerPanel search={debounced} />
              ) : kind === "memory" ? (
                <MemorySection
                  memories={memoryList}
                  onAdd={(content) => {
                    saveMemory(content);
                    flashToast(t("saved"), { tone: "ok" });
                  }}
                  onForget={(id) => {
                    forgetMemory(id);
                    flashToast(t("knowledge_memory_forgot"), { tone: "accent" });
                  }}
                  onSave={(id, content) => {
                    updateMemory(id, content);
                    flashToast(t("saved"), { tone: "ok" });
                  }}
                />
              ) : graphOpen ? (
                // the graph carries its own search card: pull it up to the
                // list tabs' 12px search position (the body wraps at mt-5)
                <div className="-mt-2">
                  <TagGraphView
                    onOpenInspector={setView}
                    onOpenThread={(id) => openThreadInspector(id, t("knowledge_kind_run"))}
                    onSelectTag={(tag) => {
                      setQuery(tag);
                      setKind("run");
                    }}
                  />
                </div>
              ) : searching ? (
                <SearchResults
                  groups={searchByKind}
                  onOpen={setView}
                  onOpenThread={(item) => openThreadInspector(item.threadId ?? "", item.title)}
                  onPin={pinItem}
                  onRemove={removeItem}
                />
              ) : kindListing ? (
                kindItems === null ? (
                  <div className="space-y-2">
                    {Array.from({ length: 5 }, (_, i) => (
                      <span className="zjs-skeleton block h-16 rounded-xl" key={i} />
                    ))}
                  </div>
                ) : (
                  <KindItemRows
                    items={kindItems}
                    onOpenInspector={setView}
                    onOpenThread={(item) => openThreadInspector(item.threadId ?? "", item.title)}
                    onPin={pinItem}
                    onRemove={removeItem}
                  />
                )
              ) : (
                <ThreadRows
                  onHome={embedded ? goHome : undefined}
                  onOpen={(thread) => openThreadInspector(thread.id, thread.title)}
                  onPin={(thread, on) => toggleThreadPin(thread.id, on)}
                  onRemove={(thread) =>
                    setConfirming({
                      label: thread.title || t("ai_search"),
                      run: () => deleteThread(thread.id),
                    })
                  }
                  onRename={(thread, title) => {
                    void renameThread(thread.id, title);
                  }}
                  threads={visibleThreads}
                />
              )}
            </div>
          </>
        )}
      </div>

      {/* ── confirm dialog (every deletion funnels through one dialog) ── */}
      {confirming ? (
        <ConfirmDialog
          cancel={() => setConfirming(null)}
          message={
            typeof confirming === "string"
              ? t("knowledge_admin_reset_confirm")
              : t("ai_delete_body", { label: confirming.label })
          }
          onConfirm={() => {
            if (confirming === "reset") {
              resetAll();
              flashToast(t("knowledge_admin_reset_done"), { tone: "accent" });
              setKind("graph");
              refreshStats();
            } else {
              confirming.run();
              flashToast(t("knowledge_deleted"), { tone: "accent" });
              refreshStats();
              setListingBump((b) => b + 1);
            }
            setConfirming(null);
          }}
          title={t("ai_delete_title")}
        />
      ) : null}
    </Shell>
  );
}
