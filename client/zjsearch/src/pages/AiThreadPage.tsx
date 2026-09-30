// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { History, MessageCircleQuestion } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dropdown } from "@/components/Dropdown.tsx";
import { SubmitCircle } from "@/components/SearchBox.tsx";
import { Shell } from "@/components/Shell.tsx";
import type { AiSourceMeta } from "@/features/results/aiAnswer.ts";
import { AiHistoryDrawer } from "@/features/results/aiSearch/AiHistoryDrawer.tsx";
import { AiSearchRunSection } from "@/features/results/aiSearch/AiSearchRunSection.tsx";
import { depthOptions } from "@/features/results/aiSearch/depth.tsx";
import { type AiSearchMode, useAiSearch } from "@/features/results/aiSearch/useAiSearch.ts";
import { themeLocaleTag, useLocale, useT } from "@/lib/i18n.ts";
import { scrollIntoViewAnimated } from "@/lib/motion.ts";
import { useRouter } from "@/lib/router.tsx";
import { threadUrl } from "@/lib/threadStore.ts";
import type { AiThreadPageData } from "@/lib/types.ts";

/** The standalone AI conversation page (`/ai/thread/<uuid>`): the thread is
    restored from the browser's storage (the ONLY storage it has -- the
    server endpoint stays stateless) and follow-ups append to it.  A missing
    store entry (another browser, quota eviction) renders the empty state. */

const EMPTY_META: AiSourceMeta[] = [];

export function AiThreadPage({ data }: { data: AiThreadPageData }) {
  const globals = data.globals;
  const t = useT();
  const { navigate, search } = useRouter();
  const uiLocale = useLocale();
  const aiLang = themeLocaleTag(uiLocale || globals.locale || "en");
  const aiSearch = useAiSearch(globals.ai_search);
  const [followupQuery, setFollowupQuery] = useState("");
  const [researchMode, setResearchMode] = useState<AiSearchMode>("balanced");
  const [historyOpen, setHistoryOpen] = useState(false);

  // restore once per page instance (the router remounts pages per payload)
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) {
      return;
    }
    restored.current = true;
    aiSearch.resume(data.thread);
    // no dependency array on purpose: the guard ref fires it once
  });

  // a follow-up appends its run section: bring the new question into view
  const runsCount = aiSearch.runs.length;
  const seenRuns = useRef(0);
  // no dependency array on purpose: the guard ref fires it on growth only
  useEffect(() => {
    const appended = runsCount > seenRuns.current;
    seenRuns.current = runsCount;
    if (!appended || runsCount < 2) {
      return;
    }
    const el = document.getElementById(`ai-run-${runsCount}`);
    if (el) {
      scrollIntoViewAnimated(el, "start");
    }
  });

  const onRunFallback = useCallback(() => {
    // the failed thread falls back to a classic search of its first question
    const first = aiSearch.runs[0]?.q;
    if (first) {
      search({ q: first });
    }
  }, [aiSearch.runs, search]);

  const submitFollowup = (): void => {
    const value = followupQuery.trim();
    if (!value || aiSearch.phase !== "done") {
      return;
    }
    setFollowupQuery("");
    aiSearch.followup(value, aiLang, researchMode);
  };

  const lastMode = aiSearch.runs[aiSearch.runs.length - 1]?.mode ?? researchMode;
  const hasThread = aiSearch.runs.length > 0;

  return (
    <Shell globals={globals}>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-28 pt-6 sm:px-6 lg:max-w-[68rem] xl:max-w-[72rem]">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
            <MessageCircleQuestion aria-hidden="true" className="size-3.5 shrink-0" />
            {t("ai_history_thread")}
          </span>
          <button
            className="inline-flex min-h-6 items-center gap-1 text-xs text-ink-3 transition-colors hover:text-ink"
            onClick={() => {
              setHistoryOpen(true);
            }}
            type="button"
          >
            <History aria-hidden="true" className="size-3.5 shrink-0" />
            {t("ai_history")}
          </button>
        </div>

        {hasThread ? (
          <div className="mt-4 space-y-8">
            {aiSearch.runs.map((run, index) => (
              <AiSearchRunSection
                isFirst={index === 0}
                isLast={index === aiSearch.runs.length - 1}
                key={run.runNo}
                live={index === aiSearch.runs.length - 1 && aiSearch.phase === "streaming"}
                onCite={() => {
                  return undefined;
                }}
                onFallback={onRunFallback}
                onRegenerate={() => {}}
                onRelated={(question) => {
                  setFollowupQuery("");
                  aiSearch.followup(question, aiLang, researchMode);
                }}
                onStop={() => {
                  aiSearch.stop();
                }}
                onSubmitClarify={(text) => {
                  aiSearch.submitClarify(text, aiLang, researchMode);
                }}
                run={run}
                sourceMeta={EMPTY_META}
              />
            ))}
            {aiSearch.phase === "done" ? (
              // Perplexica's floating follow-up, the takeover page's composer
              // in the thread page's own measure (palette fog + pinned pill)
              <div className="sticky bottom-6 z-10">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -inset-x-4 -top-20 bottom-full -z-10 bg-gradient-to-t from-bg from-30% via-bg/60 to-transparent sm:-inset-x-6"
                />
                <form
                  aria-label={t("ai_search_followup")}
                  className="rounded-2xl border border-line bg-surface px-5 py-4 shadow-card transition-colors focus-within:border-accent"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitFollowup();
                  }}
                >
                  <input
                    aria-label={t("ai_search_followup")}
                    autoComplete="off"
                    className="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-3"
                    dir="auto"
                    onChange={(event) => {
                      setFollowupQuery(event.target.value);
                    }}
                    placeholder={t("ai_search_followup")}
                    value={followupQuery}
                  />
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <Dropdown
                      ariaLabel={t("research_mode")}
                      onChange={(value) => {
                        setResearchMode(value as AiSearchMode);
                      }}
                      options={depthOptions(t)}
                      value={lastMode}
                    />
                    <SubmitCircle disabled={!followupQuery.trim()} label={t("ai_search_followup")} send />
                  </div>
                </form>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-24 flex flex-col items-center text-center animate-fade-up">
            <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
              <MessageCircleQuestion aria-hidden="true" className="size-7" />
            </span>
            <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">{t("ai_history_not_found")}</h1>
            <p className="mt-1.5 text-sm text-ink-2">{t("ai_history_not_found_hint")}</p>
            <button
              className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-accent-strong px-4 py-2 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
              onClick={() => {
                navigate("/");
              }}
              type="button"
            >
              {t("back_to_search")}
            </button>
          </div>
        )}
      </main>
      <AiHistoryDrawer
        currentId={aiSearch.threadId || data.thread}
        onClose={() => {
          setHistoryOpen(false);
        }}
        onNavigate={(url) => {
          if (url === threadUrl(data.thread)) {
            // the restored thread's own address: a full load re-hydrates the
            // page payload (the takeover's replaceState makes this the
            // canonical url of the current view)
            navigate(url, { replace: true });
          } else {
            navigate(url);
          }
        }}
        open={historyOpen}
      />
    </Shell>
  );
}
