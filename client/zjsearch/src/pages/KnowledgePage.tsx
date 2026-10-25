// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { LibraryBig, Star } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { BootRowsCard } from "@/components/BootGhosts.tsx";
import { Dropdown } from "@/components/Dropdown.tsx";
import { PanelSearch } from "@/components/PanelSearch.tsx";
import { Shell } from "@/components/Shell.tsx";
import {
  AdminView,
  ConfirmDialog,
  InspectorView,
  KindItemRows,
  KNOWLEDGE_KIND_ICONS,
  MemorySection,
  SearchResults,
  ThreadRows,
} from "@/features/knowledge/sections.tsx";
import { TagGraphView } from "@/features/knowledge/TagGraphView.tsx";
import { useOverlay } from "@/features/overlay/OverlayProvider.tsx";
import { useT } from "@/lib/i18n.ts";
import { loadDocument, loadThreadAnswer, type ThreadAnswer } from "@/lib/kb/inspector.ts";
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
import { listKind, listThreadModes, searchKnowledge, type ThreadSummary } from "@/lib/kb/recall.ts";
import { type KnowledgeItem, threadUrl } from "@/lib/kb/shared.ts";
import { type KnowledgeStats, knowledgeStats } from "@/lib/kb/stats.ts";
import { useRouter } from "@/lib/router.tsx";
import {
  CHIP_OUTLINE,
  CHIP_OUTLINE_ACTIVE,
  CHIP_OUTLINE_IDLE,
  SEGMENT,
  SEGMENT_ACTIVE,
  SEGMENT_IDLE,
} from "@/lib/styles.ts";
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

type KindFilter = "run" | "source" | "document" | "memory";
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

  // ── view tab: the overview archive (the classic page's AI overview) leads,
  // then the research threads, sources, documents, memories; the graph is
  // a VIEW (global, memory rows carry no tags) and admin closes the bar ──
  const [kind, setKind] = useState<KindFilter | "graph" | "templates" | "admin">("run");
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
  const kindListing = !searching && (kind === "source" || kind === "document");
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
    report?: ThreadAnswer["report"];
    sections?: ThreadAnswer["sections"];
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
          setInspectedExtras({
            sources: result.sources,
            usage: result.usage,
            report: result.report ?? null,
            sections: result.sections ?? null,
          });
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

    setInspectedExtras(null);
    return undefined;
  }, [inspected]);

  // the directory's run-mode tags: refreshed out-of-band (the live thread
  // subscription must stay a plain select) and merged into the rows
  const [modesById, setModesById] = useState<Record<string, string[]>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tags refresh on the same bumps as the directory listing
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tags refresh on the same bumps as the directory listing
  useEffect(() => {
    let cancelled = false;
    listThreadModes()
      .then((value) => {
        if (!cancelled) setModesById(value);
      })
      .catch(() => {
        if (!cancelled) setModesById({});
      });
    return () => {
      cancelled = true;
    };
  }, [threadsLen, listingBump]);
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
    // the close is a no-op.  The ROUTER's navigate owns the history dance
    // (a raw pushState+popstate raced the AI takeover's own thread-URL
    // pushState -- the takeover enters the thread without the router
    // learning the url, so the popstate guard could mismatch and skip
    // the load; the takeover page's drawer was exactly where the jump
    // silently died).
    closeOverlay();
    // the same thread's own pill (the common case on an AI thread page):
    // the takeover page IS the research view -- closing the drawer reveals
    // it; a re-navigate to the identical URL would be skipped by the
    // router and leave the drawer hanging open
    if (location.pathname === threadUrl(id)) {
      return;
    }
    navigate(threadUrl(id));
  };

  const goHome = () => {
    closeOverlay();
    navigate("/");
  };

  /** A thread's inspector item: the answer loads from the evt log and the
      view-research pill jumps to the full thread page. */
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
  const listTab = kind === "run" || kind === "source" || kind === "document";
  const viewTabs: Array<{ id: KindFilter | "graph" | "templates" | "admin"; label: string; icon: ReactNode }> = [
    // the research directory leads: the overview lives INSIDE its threads
    { id: "run", label: t("knowledge_kind_run"), icon: <KNOWLEDGE_KIND_ICONS.run className="size-3.5" /> },
    { id: "source", label: t("knowledge_kind_source"), icon: <KNOWLEDGE_KIND_ICONS.source className="size-3.5" /> },
    {
      id: "document",
      label: t("knowledge_kind_document"),
      icon: <KNOWLEDGE_KIND_ICONS.document className="size-3.5" />,
    },
    { id: "memory", label: t("knowledge_kind_memory"), icon: <KNOWLEDGE_KIND_ICONS.memory className="size-3.5" /> },
    { id: "graph", label: t("knowledge_graph"), icon: <KNOWLEDGE_KIND_ICONS.graph className="size-3.5" /> },
    {
      id: "templates",
      label: t("knowledge_tab_templates"),
      icon: <KNOWLEDGE_KIND_ICONS.templates className="size-3.5" />,
    },
    { id: "admin", label: t("knowledge_admin"), icon: <KNOWLEDGE_KIND_ICONS.admin className="size-3.5" /> },
  ];
  const graphOpen = kind === "graph";

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
              <PanelSearch
                ariaLabel={t("knowledge_search_placeholder")}
                className="mt-3"
                clearLabel={t("clear")}
                onChange={(value) => setQuery(value)}
                onClear={() => setQuery("")}
                placeholder={kind === "templates" ? t("knowledge_search_templates") : t("knowledge_search_placeholder")}
                value={query}
              />
            ) : null}

            {/* ── toolbar: the time/pinned filters, list kinds only ── */}
            {listTab ? (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Dropdown
                  ariaLabel={t("knowledge_time_filter")}
                  onChange={(value) => setTime(value as TimeFilter)}
                  options={[
                    { label: t("knowledge_time_any"), value: "any" },
                    { label: t("knowledge_time_week"), value: "week" },
                    { label: t("knowledge_time_month"), value: "month" },
                  ]}
                  value={time}
                  variant="chip"
                />
                <button
                  aria-pressed={pinnedOnly}
                  className={`${CHIP_OUTLINE} ${pinnedOnly ? CHIP_OUTLINE_ACTIVE : CHIP_OUTLINE_IDLE}`}
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
                  loading={memories === null}
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
                  loading={results === null}
                  onOpen={setView}
                  onOpenThread={(item) => openThreadInspector(item.threadId ?? "", item.title)}
                  onPin={pinItem}
                  onRemove={removeItem}
                />
              ) : kindListing ? (
                kindItems === null ? (
                  <BootRowsCard rows={5} />
                ) : (
                  <KindItemRows
                    emptyIcon={KNOWLEDGE_KIND_ICONS[kind]}
                    emptyLine={kind === "source" ? t("knowledge_source_empty_line") : t("knowledge_doc_empty_line")}
                    items={kindItems}
                    onOpenInspector={setView}
                    onOpenThread={(item) => openThreadInspector(item.threadId ?? "", item.title)}
                    onPin={pinItem}
                    onRemove={removeItem}
                  />
                )
              ) : (
                <ThreadRows
                  loading={threads === null}
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
                  threads={visibleThreads.map((thread) => ({ ...thread, modes: modesById[thread.id] ?? [] }))}
                />
              )}
            </div>
          </>
        )}
      </div>

      {/* ── confirm dialog (every deletion funnels through one dialog) ── */}
      {/* ALWAYS mounted (the dialog owns its exit animation) -- the open
          flag drives it */}
      <ConfirmDialog
        cancel={() => setConfirming(null)}
        message={
          confirming
            ? typeof confirming === "string"
              ? t("knowledge_admin_reset_confirm")
              : t("ai_delete_body", { label: confirming.label })
            : ""
        }
        onConfirm={() => {
          if (confirming === "reset") {
            resetAll();
            flashToast(t("knowledge_admin_reset_done"), { tone: "accent" });
            setKind("graph");
            refreshStats();
          } else if (confirming) {
            confirming.run();
            flashToast(t("knowledge_deleted"), { tone: "accent" });
            refreshStats();
            setListingBump((b) => b + 1);
          }
          setConfirming(null);
        }}
        open={confirming !== null}
        title={t("ai_delete_title")}
      />
    </Shell>
  );
}
