// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  BookMarked,
  Brain,
  Clock3,
  ExternalLink,
  Globe,
  History,
  MessageCircleQuestion,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { formatDate } from "@/lib/format.ts";
import { type Translate, useT } from "@/lib/i18n.ts";
import { ICON_BTN } from "@/lib/styles.ts";
import {
  type AiThreadHit,
  type AiThreadMeta,
  deleteMemory,
  deleteSearch,
  deleteSource,
  deleteThread,
  getReaderPage,
  listMemories,
  listReaderPages,
  listRecentSources,
  listSearchHistory,
  listThreads,
  type RecallHit,
  recallSources,
  searchReaderPages,
  searchThreads,
  type ThreadSearchMode,
  threadUrl,
} from "@/lib/threadStore.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";

type DrawerTab = "threads" | "library" | "searches" | "memory";

interface ReaderPageEntry {
  url: string;
  title: string;
  chars: number;
  fetchedAt: number;
}

interface SearchHistoryRow {
  q: string;
  category: string;
  results: number;
  times: number;
  lastRan: number;
}

/** The browser's history, one slide-in sheet in THREE tabs: 会话 (the AI
    threads), 研究库 (the research corpus -- every source and reader
    full-text, keyword/semantically searchable) and 搜索历史 (the classic
    search history, clickable to re-run).  All browser-local (the server
    keeps nothing); deletion is local and permanent.  Purely client data,
    so this is a plain dialog, not an overlay panel (those carry server
    page payloads). */
function MemoryList({
  memories,
  query,
  requestForget,
  t,
}: {
  memories: Array<{ id: string; content: string; updated: number }>;
  query: string;
  requestForget: (memory: { id: string; content: string; updated: number }) => void;
  t: Translate;
}) {
  const trimmed = query.trim().toLowerCase();
  const visible = trimmed ? memories.filter((m) => m.content.toLowerCase().includes(trimmed)) : memories;
  if (visible.length === 0) {
    return <p className="px-3 py-6 text-center text-sm text-ink-3">{t("ai_memory_empty")}</p>;
  }
  return visible.map((memory) => (
    <div className="flex items-start gap-2.5 rounded-xl px-2 py-2.5 hover:bg-surface-2" key={memory.id}>
      <Brain aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
      <p className="min-w-0 flex-1 break-words text-[13px] leading-relaxed text-ink" dir="auto">
        {memory.content}
      </p>
      <button
        aria-label={t("ai_memory_forget")}
        className="shrink-0 rounded-md p-1 text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger"
        onClick={() => {
          requestForget(memory);
        }}
        title={t("ai_memory_forget")}
        type="button"
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  ));
}

export function AiHistoryDrawer({
  currentId,
  initialMode = "keyword",
  onNavigate,
  open,
  onClose,
}: {
  /** the thread currently on screen (its row renders highlighted) */
  currentId?: string;
  /** the configured default search mode
      (zjsearch.feature.ai_search.history_search) */
  initialMode?: ThreadSearchMode;
  onNavigate: (url: string) => void;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { render, closing } = useExitPresence(open);
  const ref = useDialogFocus<HTMLDivElement>(open && !closing);
  const [tab, setTab] = useState<DrawerTab>("threads");
  // EVERY deletion funnels through one confirm dialog -- browser-local and
  // permanent
  const [pending, setPending] = useState<{ label: string; run: () => void } | null>(null);
  const [threads, setThreads] = useState<AiThreadMeta[]>(() => listThreads());
  /** semantic search over the thread payloads (pgvector cosine) -- non-
      null while a query is active, and the plain recency list yields */
  const [query, setQuery] = useState("");
  /** keyword (BM25) / semantic (pgvector) / hybrid (both, RRF-fused) --
      the row exists when the embedding capability is present; the
      initial value is the configured default */
  // the search mode is the DEPLOYMENT's setting (settings.yml
  // history_mode): semantic/hybrid burn embedding calls per query --
  // that spend is not the user's to flip at runtime
  const mode = initialMode;
  const [hits, setHits] = useState<AiThreadHit[] | null>(null);
  // the research library: recent lists hydrated on tab entry, the search
  // results swap in while a query is active
  const [librarySources, setLibrarySources] = useState<RecallHit[]>([]);
  const [libraryPages, setLibraryPages] = useState<ReaderPageEntry[]>([]);
  // the classic search history
  const [searchHistory, setSearchHistory] = useState<SearchHistoryRow[]>([]);
  const [memories, setMemories] = useState<Array<{ id: string; content: string; updated: number }>>([]);
  // Escape closes (the dialog contract keeps Escape with each dialog's own
  // handler); the closing window short-circuits a second press
  useEffect(() => {
    if (!open || closing) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, closing, onClose]);
  // a fresh open starts from the recency list: the query is the user's
  // in-progress intent, not a persistent filter
  useEffect(() => {
    if (open) {
      setQuery("");
      setHits(null);
      setThreads(listThreads());
      setTab("threads");
    }
  }, [open]);
  // the threads tab: debounced keyword/semantic search
  useEffect(() => {
    if (!open || closing || tab !== "threads") {
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setHits(null);
      return;
    }
    const timer = window.setTimeout(() => {
      searchThreads(trimmed, mode)
        .then((found) => {
          setHits(found);
        })
        .catch(() => {
          setHits([]);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, mode, open, closing, tab]);
  // the library tab: recent lists on entry, debounced search while typing
  useEffect(() => {
    if (!open || closing || tab !== "library") {
      return;
    }
    const load = () => {
      const trimmed = query.trim();
      void Promise.all([
        trimmed ? recallSources(trimmed, 20) : listRecentSources(30),
        trimmed ? searchReaderPages(trimmed, 12) : listReaderPages(20),
      ])
        .then(([sources, pages]) => {
          setLibrarySources(sources);
          setLibraryPages(pages.map((page) => ({ ...page, fetchedAt: Date.now(), chars: 0 })));
        })
        .catch(() => {
          /* best-effort */
        });
    };
    load();
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    const timer = window.setTimeout(load, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, open, closing, tab]);
  // the memory tab: hydrated on entry, removals reflect immediately
  useEffect(() => {
    if (!open || closing || tab !== "memory") {
      return;
    }
    setMemories(listMemories());
  }, [open, closing, tab]);
  // the search-history tab: recent on entry, debounced filter while typing
  useEffect(() => {
    if (!open || closing || tab !== "searches") {
      return;
    }
    const load = () => {
      listSearchHistory(query, 30)
        .then((rows) => {
          setSearchHistory(rows);
        })
        .catch(() => {
          setSearchHistory([]);
        });
    };
    load();
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    const timer = window.setTimeout(load, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, open, closing, tab]);
  if (!render) {
    return null;
  }
  const refresh = (): void => setThreads(listThreads());
  const remove = (id: string): void => {
    deleteThread(id);
    refresh();
  };
  const navigate = (id: string): void => {
    if (id !== currentId) {
      onNavigate(threadUrl(id));
    }
    onClose();
  };
  const forgetSearch = (q: string, category: string): void => {
    deleteSearch(q, category);
    setSearchHistory(searchHistory.filter((row) => row.q !== q || row.category !== category));
  };
  const forgetSource = (url: string): void => {
    deleteSource(url);
    setLibrarySources(librarySources.filter((source) => source.url !== url));
  };
  const tabs: Array<{ id: DrawerTab; label: string }> = [
    { id: "searches", label: t("ai_drawer_tab_searches") },
    { id: "threads", label: t("ai_drawer_tab_threads") },
    { id: "library", label: t("ai_drawer_tab_library") },
    { id: "memory", label: t("ai_drawer_tab_memory") },
  ];
  return (
    <div aria-hidden={closing || undefined}>
      <div
        aria-label={t("ai_history")}
        className={`fixed inset-0 z-50 ${closing ? "animate-fade-out" : "animate-fade-in"}`}
        inert={closing}
        ref={ref}
        role="dialog"
      >
        <button
          aria-label={t("close")}
          className="absolute inset-0 cursor-default bg-black/60"
          onClick={onClose}
          tabIndex={closing ? -1 : 0}
          type="button"
        />
        {/* the settings-panel shape: full-width sheet on mobile, a wide
            end-anchored panel from sm up -- not the old floating 80-strip
            that left the page half-visible and the list swimming */}
        <div
          className={`absolute inset-y-0 end-0 flex w-full max-w-3xl flex-col bg-bg shadow-pop ${
            closing ? "animate-slide-out-right" : "animate-slide-in-right"
          }`}
        >
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <div className="flex items-center gap-2">
              <History aria-hidden="true" className="size-4.5 text-ink-3" />
              <h2 className="text-lg font-semibold text-ink">{t("ai_drawer_title")}</h2>
            </div>
            <button aria-label={t("close")} className={ICON_BTN} data-dialog-close="" onClick={onClose} type="button">
              <X aria-hidden="true" className="size-4.5" />
            </button>
          </div>
          {/* the three surfaces: threads / research library / search history */}
          <div className="flex items-center gap-1 border-b border-line px-3 py-2">
            {tabs.map((entry) => (
              <button
                aria-pressed={tab === entry.id}
                className={`rounded-full px-3 py-1.5 text-[13px] transition-colors ${
                  tab === entry.id
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-ink-3 hover:bg-surface-2 hover:text-ink"
                }`}
                key={entry.id}
                onClick={() => {
                  setTab(entry.id);
                  setQuery("");
                }}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="border-b border-line px-3 py-2.5">
            <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5">
              <Search aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
              <input
                aria-label={t("ai_history_search")}
                autoComplete="off"
                className="h-8 w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
                dir="auto"
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder={
                  tab === "library"
                    ? t("ai_library_search")
                    : tab === "memory"
                      ? t("ai_memory_search_placeholder")
                      : t("ai_history_search")
                }
                type="text"
                value={query}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {tab === "threads" ? (
              <ThreadList
                currentId={currentId}
                hits={hits}
                navigate={navigate}
                query={query}
                requestRemove={(thread) => {
                  setPending({ label: thread.title || t("ai_search"), run: () => remove(thread.id) });
                }}
                t={t}
                threads={threads}
              />
            ) : tab === "library" ? (
              <LibraryList
                forgetSource={(source) => {
                  setPending({
                    label: source.title || source.url,
                    run: () => forgetSource(source.url),
                  });
                }}
                pages={libraryPages}
                sources={librarySources}
                t={t}
              />
            ) : tab === "memory" ? (
              <MemoryList
                memories={memories}
                query={query}
                requestForget={(memory) => {
                  setPending({
                    label: memory.content,
                    run: () => {
                      deleteMemory(memory.id);
                      setMemories(listMemories());
                    },
                  });
                }}
                t={t}
              />
            ) : (
              <SearchHistoryList
                history={searchHistory}
                onNavigate={(url) => {
                  onNavigate(url);
                  onClose();
                }}
                requestForget={(entry) => {
                  setPending({
                    label: entry.q,
                    run: () => forgetSearch(entry.q, entry.category),
                  });
                }}
                t={t}
              />
            )}
          </div>
          {pending ? (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
              <div aria-hidden="true" className="absolute inset-0 bg-black/60" />
              <div className="relative z-10 w-full max-w-md rounded-2xl border border-line bg-surface p-5">
                <h3 className="text-base font-semibold text-ink">{t("ai_delete_title")}</h3>
                <p className="mt-2 break-words text-sm leading-relaxed text-ink-2">
                  {t("ai_delete_body", { label: pending.label })}
                </p>
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    className="rounded-full px-4 py-1.5 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                    onClick={() => {
                      setPending(null);
                    }}
                    type="button"
                  >
                    {t("ai_delete_cancel")}
                  </button>
                  <button
                    className="rounded-full bg-danger px-4 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                    onClick={() => {
                      pending.run();
                      setPending(null);
                    }}
                    type="button"
                  >
                    {t("ai_delete_ok")}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ThreadList({
  currentId,
  hits,
  navigate,
  query,
  requestRemove,
  threads,
  t,
}: {
  currentId?: string;
  hits: AiThreadHit[] | null;
  navigate: (id: string) => void;
  query: string;
  requestRemove: (thread: AiThreadMeta) => void;
  threads: AiThreadMeta[];
  t: Translate;
}) {
  const searching = query.trim() !== "";
  const shown: Array<AiThreadHit | AiThreadMeta> = searching && hits !== null ? hits : threads;
  if (shown.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-sm text-ink-3">
        {searching && hits !== null ? t("ai_history_no_match") : t("ai_history_empty")}
      </p>
    );
  }
  return shown.map((thread) => (
    <div
      className={`group flex items-center gap-1 rounded-xl px-2 ${thread.id === currentId ? "bg-accent-soft" : "hover:bg-surface-2"}`}
      key={thread.id}
    >
      <MessageCircleQuestion
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-ink-3 group-hover:text-ink-2"
      />
      <button
        className="min-w-0 flex-1 py-2.5 text-start"
        onClick={() => {
          navigate(thread.id);
        }}
        type="button"
      >
        <span
          className={`block truncate text-[13px] ${thread.id === currentId ? "font-medium text-accent" : "text-ink"}`}
          dir="auto"
        >
          {thread.title || t("ai_search")}
        </span>
        <span className="block text-xs text-ink-3">{formatDate(new Date(thread.updated).toISOString())}</span>
      </button>
      <button
        aria-label={t("delete")}
        className="grid size-8 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-hover:hover:text-danger"
        onClick={() => {
          requestRemove(thread);
        }}
        title={t("delete")}
        type="button"
      >
        <Trash2 aria-hidden="true" className="size-4" />
      </button>
    </div>
  ));
}

/** The research corpus: SOURCES first (with their ref/cited counters),
    then the reader full-texts.  Every entry opens externally (the
    content lives on the web; the cache is the model's, not a reader). */
function SourceRow({ requestForget, source }: { requestForget: (source: RecallHit) => void; source: RecallHit }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [pane, setPane] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const toggle = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (pane === null && !loading) {
      setLoading(true);
      getReaderPage(source.url)
        .then((page) => {
          setPane(page?.markdown ?? "");
          setLoading(false);
        })
        .catch(() => {
          setPane("");
          setLoading(false);
        });
    }
  };
  return (
    <div className="rounded-xl transition-colors hover:bg-surface-2">
      <div className="flex items-start gap-2.5 px-2 py-2.5">
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[5px] bg-surface ring-1 ring-line">
          <Globe aria-hidden="true" className="size-3.5 text-ink-3" />
        </span>
        <button className="min-w-0 flex-1 text-start" onClick={toggle} type="button">
          <span className="block truncate text-[13px] text-ink" dir="auto">
            {source.title || source.url}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-xs text-ink-3">
            <span className="truncate">{source.host}</span>
            {source.refCount > 0 ? (
              <span className="shrink-0">{t("ai_library_refs", { n: String(source.refCount) })}</span>
            ) : null}
            {source.citedCount > 0 ? (
              <span className="shrink-0">{t("ai_library_cited", { n: String(source.citedCount) })}</span>
            ) : null}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-0.5 pt-1.5">
          <a
            aria-label={t("open_in_new_tab")}
            className="rounded-md p-1 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            href={source.url}
            onClick={(event) => {
              event.stopPropagation();
            }}
            rel="noreferrer"
            target="_blank"
            title={t("open_in_new_tab")}
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
          <button
            aria-label={t("ai_memory_forget")}
            className="rounded-md p-1 text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger"
            onClick={() => {
              requestForget(source);
            }}
            title={t("ai_memory_forget")}
            type="button"
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      </div>
      {expanded ? (
        <div className="px-2 pb-2.5">
          {loading ? (
            <p className="text-xs text-ink-3">…</p>
          ) : pane ? (
            <pre className="max-h-72 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg bg-surface-2/60 p-2.5 text-xs leading-relaxed text-ink-2">
              {pane}
            </pre>
          ) : (
            <p className="text-xs text-ink-3">{t("ai_library_not_read")}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function LibraryList({
  forgetSource,
  pages,
  sources,
  t,
}: {
  forgetSource: (source: RecallHit) => void;
  pages: ReaderPageEntry[];
  sources: RecallHit[];
  t: Translate;
}) {
  if (sources.length === 0 && pages.length === 0) {
    return <p className="px-3 py-6 text-center text-sm text-ink-3">{t("ai_library_empty")}</p>;
  }
  return (
    <div className="space-y-4">
      {sources.length > 0 ? (
        <div>
          {sources.map((source) => (
            <SourceRow key={source.url} requestForget={forgetSource} source={source} />
          ))}
        </div>
      ) : null}
      {pages.length > 0 ? (
        <div>
          <p className="flex items-center gap-1.5 px-2 pb-1 text-xs font-medium text-ink-3">
            <BookMarked aria-hidden="true" className="size-3.5" />
            {t("ai_library_pages")}
          </p>
          {/* the reading pane: clicking a page expands the ARCHIVED markdown
              right here -- getReaderPage fetches the full content */}
          {pages.map((page) => (
            <a
              className="block rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2"
              dir="auto"
              href={page.url}
              key={page.url}
              rel="noreferrer"
              target="_blank"
            >
              <span className="block truncate text-[13px] text-ink" dir="auto">
                {page.title || page.url}
              </span>
              <span className="mt-0.5 flex items-center gap-2 text-xs text-ink-3">
                <span className="shrink-0">{t("ai_page_chars", { n: String(page.chars) })}</span>
                <span className="shrink-0">{formatDate(new Date(page.fetchedAt).toISOString())}</span>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The classic search history: one row per query, click re-runs it. */
function SearchHistoryList({
  history,
  onNavigate,
  requestForget,
  t,
}: {
  history: SearchHistoryRow[];
  onNavigate: (url: string) => void;
  requestForget: (entry: SearchHistoryRow) => void;
  t: Translate;
}) {
  if (history.length === 0) {
    return <p className="px-3 py-6 text-center text-sm text-ink-3">{t("ai_searches_empty")}</p>;
  }
  return history.map((entry) => {
    // BIGINT round-trips can arrive as values Date rejects -- a row that
    // would throw Invalid time value takes the whole React tree down
    const ran = new Date(entry.lastRan);
    const ranIso = Number.isFinite(ran.getTime()) ? ran.toISOString() : null;
    return (
      <div
        className="group flex items-start gap-1 rounded-xl px-2 transition-colors hover:bg-surface-2"
        key={`${entry.q}|${entry.category}`}
      >
        <button
          className="block min-w-0 flex-1 py-2.5 text-start"
          onClick={() => {
            onNavigate(
              `/search?q=${encodeURIComponent(entry.q)}${entry.category ? `&category=${entry.category}` : ""}`,
            );
          }}
          type="button"
        >
          <span className="block truncate text-[13px] text-ink" dir="auto">
            <Clock3 aria-hidden="true" className="me-1.5 inline size-3.5 text-ink-3" />
            {entry.q}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-xs text-ink-3">
            {ranIso ? <span className="shrink-0">{formatDate(ranIso)}</span> : null}
            <span className="shrink-0">{t("ai_searches_results", { n: String(entry.results) })}</span>
            {entry.times > 1 ? <span className="shrink-0">×{entry.times}</span> : null}
          </span>
        </button>
        <button
          aria-label={t("delete")}
          className="grid size-8 shrink-0 place-items-center self-center rounded-full text-ink-3 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-hover:hover:text-danger"
          onClick={() => {
            requestForget(entry);
          }}
          title={t("delete")}
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-4" />
        </button>
      </div>
    );
  });
}
