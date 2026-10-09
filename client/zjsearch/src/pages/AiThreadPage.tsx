// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { MessageCircleQuestion, Zap } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Dropdown } from "@/components/Dropdown.tsx";
import { SubmitCircle } from "@/components/SearchBox.tsx";
import { Shell } from "@/components/Shell.tsx";
import type { AiSourceMeta } from "@/features/results/aiOverview.ts";
import { AiSearchRunSection } from "@/features/results/aiSearch/AiSearchRunSection.tsx";
import { AttachmentPicker } from "@/features/results/aiSearch/AttachmentPicker.tsx";
import { depthOptions } from "@/features/results/aiSearch/depth.tsx";
import { SteerChips } from "@/features/results/aiSearch/SteerChips.tsx";
import type { AiSearchAttachment } from "@/features/results/aiSearch/timeline.ts";
import { type AiSearchMode, useAiSearch } from "@/features/results/aiSearch/useAiSearch.ts";
import { useAiSteer } from "@/features/results/aiSearch/useAiSteer.ts";
import { themeLocaleTag, useLocale, useT } from "@/lib/i18n.ts";
import { scrollIntoViewAnimated } from "@/lib/motion.ts";
import { useRouter } from "@/lib/router.tsx";
import type { AiThreadPageData } from "@/lib/types.ts";

// the debug stage LAZY-loads behind ?aidebug: its fixture catalog is
// ~1,500 lines of QA-only data that otherwise rides EVERY real thread
// visit in the page chunk (the stage itself is a QA surface, never a
// user path)
const AiDebugStage = lazy(() =>
  import("@/features/results/aiSearch/AiDebugStage.tsx").then((m) => ({ default: m.AiDebugStage })),
);

/** The standalone AI conversation page (`/zjsearch/ai/thread/<uuid>`):
    the thread is
    restored from the browser's storage (the ONLY storage it has -- the
    server endpoint stays stateless) and follow-ups append to it.  A missing
    store entry (another browser, quota eviction) renders the empty state. */

/** The thread page's resume ghost (page-private): while the async resume
    reads the store (the per-tab mirror may miss; PGlite is the fallback)
    the main column rendered BLANK -- a shared thread link read as dead.
    The ghost mirrors AiSearchRunSection's zero-event state. */
/** The page entry: `?aidebug` diverts to the AI debug stage (the UI's
    own audit surface -- fixture wire-event scripts through the real fold
    + renderers, no server surface, no tokens).  The flag lives on a
    HOOKLESS wrapper so the impl's hook order is unconditional. */
export function AiThreadPage({ data }: { data: AiThreadPageData }) {
  if (typeof window !== "undefined" && new window.URLSearchParams(window.location.search).has("aidebug")) {
    return (
      <Shell globals={data.globals}>
        {/* the SAME horizontal geometry as the real thread page's main
            below: a fixed-measure container, so layouts tuned on the debug
            stage hold on the live page (a shrink-to-fit main drifts with
            the content -- research vs report read as a width change) */}
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-6 sm:px-6 lg:max-w-[68rem] xl:max-w-[72rem]">
          <Suspense
            fallback={
              <div aria-busy="true" className="mt-4 space-y-5">
                <span className="zjs-skeleton block h-9 w-72 max-w-full" />
                <span className="zjs-skeleton block h-24 w-full" />
              </div>
            }
          >
            <AiDebugStage />
          </Suspense>
        </main>
      </Shell>
    );
  }
  return <AiThreadPageImpl data={data} />;
}

function ThreadGhost() {
  return (
    <div aria-busy="true" className="mt-4 animate-fade-up space-y-5">
      <span className="zjs-skeleton block h-9 w-72 max-w-full" />
      <div className="flex flex-wrap items-center gap-2">
        <span className="zjs-skeleton size-5 rounded-full" />
        <span className="zjs-skeleton h-5 w-24" />
        <span className="zjs-skeleton h-4 w-16" />
      </div>
      <div className="rounded-lg border border-line p-3">
        <span className="zjs-skeleton block h-4 w-44" />
        <span className="zjs-skeleton mt-2 block h-6 w-full" />
        <span className="zjs-skeleton mt-2 block h-6 w-[82%]" />
      </div>
      <div className="space-y-3">
        <span className="zjs-skeleton block h-4 w-full" />
        <span className="zjs-skeleton block h-4 w-[93%]" />
        <span className="zjs-skeleton block h-4 w-[70%]" />
      </div>
    </div>
  );
}

function AiThreadPageImpl({ data }: { data: AiThreadPageData }) {
  const globals = data.globals;
  const t = useT();
  const { navigate, search } = useRouter();
  const uiLocale = useLocale();
  const aiLang = themeLocaleTag(uiLocale || globals.locale || "en");
  const aiSearch = useAiSearch(globals.ai_search);
  const [followupQuery, setFollowupQuery] = useState("");
  const [followupAttachments, setFollowupAttachments] = useState<AiSearchAttachment[]>([]);
  const [researchMode, setResearchMode] = useState<AiSearchMode>("balanced");
  // the composer adopts the thread's own depth once runs exist: continue/
  // retry/followup submit researchMode, so it must match the dropdown's
  // display (a thread URL carries no mode param -- the balanced default
  // would silently downgrade a report thread's next run)
  const lastRunMode = aiSearch.runs[aiSearch.runs.length - 1]?.mode;
  useEffect(() => {
    if (lastRunMode) {
      setResearchMode(lastRunMode);
    }
  }, [lastRunMode]);

  // restore once per page instance (the router remounts pages per payload);
  // the resume is ASYNC now (it may read PGlite when this tab's mirror
  // misses) -- the not-found gate waits for it
  const restored = useRef(false);
  const [resuming, setResuming] = useState(true);
  useEffect(() => {
    if (restored.current) {
      return;
    }
    restored.current = true;
    aiSearch.resume(data.thread).finally(() => {
      setResuming(false);
    });
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
    aiSearch.followup(value, aiLang, researchMode, "", followupAttachments);
    setFollowupAttachments([]);
  };

  // the composer's guide lane (same dual-mode contract as the results
  // page): while the run streams, the input steers it
  const steering = aiSearch.phase === "streaming";
  const steer = useAiSteer(aiSearch);
  const hasThread = aiSearch.runs.length > 0;
  // the not-found empty state only shows AFTER the resume attempt resolved
  const showMissing = !resuming && !hasThread;

  return (
    <Shell globals={globals}>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-44 pt-6 sm:px-6 lg:max-w-[68rem] xl:max-w-[72rem]">
        {resuming ? (
          <ThreadGhost />
        ) : hasThread ? (
          <div className="mt-4 space-y-8">
            {aiSearch.runs.map((run, index) => (
              <AiSearchRunSection
                isFirst={index === 0}
                isLast={index === aiSearch.runs.length - 1}
                key={run.runNo}
                live={index === aiSearch.runs.length - 1 && aiSearch.phase === "streaming"}
                onCite={(n) => {
                  // locate the cited source card in this run's grid (the
                  // takeover's jump language, scoped to the thread page).
                  // The lg rail is its own scroll container AND an absolute
                  // full-height column that contributes no page height --
                  // the WINDOW cannot scroll its content into view, so the
                  // card centers by the rail's own scrollTop (a static
                  // mobile rail falls back to the page scroll)
                  const root = document.getElementById(`ai-run-${run.runNo}`);
                  const card = root?.querySelector<HTMLElement>(`[data-ai-n="${n}"]`);
                  const rail = root?.parentElement?.querySelector("aside");
                  if (!card) {
                    return;
                  }
                  const flash = () => {
                    card.removeAttribute("data-ai-flash");
                    void card.offsetWidth;
                    card.setAttribute("data-ai-flash", "");
                    window.setTimeout(() => card.removeAttribute("data-ai-flash"), 1900);
                  };
                  if (rail && rail.scrollHeight > rail.clientHeight) {
                    const railRect = rail.getBoundingClientRect();
                    const cardRect = card.getBoundingClientRect();
                    rail.scrollTop += cardRect.top - railRect.top - railRect.height / 2 + cardRect.height / 2;
                    flash();
                    return;
                  }
                  scrollIntoViewAnimated(card, "center");
                  flash();
                }}
                onContinue={() => {
                  aiSearch.continue(aiLang, researchMode, "");
                }}
                onFallback={onRunFallback}
                onRegenerate={() => {
                  // in-place re-run of the last run -- the same semantic the
                  // takeover's 重新生成 carries (the button was a silent
                  // no-op here once)
                  aiSearch.retry(aiLang, researchMode, "");
                }}
                onRelated={(question) => {
                  setFollowupQuery("");
                  aiSearch.followup(question, aiLang, researchMode);
                }}
                onSetTemplate={(template) => aiSearch.setTemplate(template)}
                onStop={() => {
                  aiSearch.stop();
                }}
                onSubmitClarify={(text) => {
                  aiSearch.submitClarify(text, aiLang, researchMode);
                }}
                onWrap={() => {
                  aiSearch.wrap();
                }}
                run={run}
                sourceMeta={
                  run.sources.map((source) => ({
                    favicon: source.favicon ?? "",
                    domain: source.netloc ?? "",
                    t: source.title,
                    u: source.url,
                  })) as AiSourceMeta[]
                }
              />
            ))}
            {aiSearch.phase !== "idle" && aiSearch.phase !== "error" ? (
              // Perplexica's floating follow-up, the takeover page's composer
              // in the thread page's own measure (no fog scrim -- it washed
              // out short content underneath)
              <div className="sticky bottom-6 z-10 lg:me-[22rem] xl:me-[26rem]">
                <form
                  aria-label={steering ? t("ai_steer_placeholder") : t("ai_search_followup")}
                  className={`rounded-2xl border bg-surface px-5 py-4 shadow-card transition-colors focus-within:border-accent ${
                    steering ? "border-accent/60" : "border-line"
                  }`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (steering) {
                      const value = followupQuery.trim();
                      if (!value) {
                        return;
                      }
                      setFollowupQuery("");
                      steer.send(value);
                      return;
                    }
                    submitFollowup();
                  }}
                >
                  <input
                    aria-label={steering ? t("ai_steer_placeholder") : t("ai_search_followup")}
                    autoComplete="off"
                    className="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-3"
                    dir="auto"
                    onChange={(event) => {
                      setFollowupQuery(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && event.shiftKey && steering) {
                        event.preventDefault();
                        const value = followupQuery.trim();
                        if (!value) {
                          return;
                        }
                        setFollowupQuery("");
                        steer.send(value, true);
                      }
                    }}
                    placeholder={steering ? t("ai_steer_placeholder") : t("ai_search_followup")}
                    value={followupQuery}
                  />
                  <SteerChips chips={steer.chips} onRetract={steer.retract} />
                  {followupAttachments.length ? (
                    <div className="mt-3">
                      <AttachmentPicker items={followupAttachments} onChange={setFollowupAttachments} />
                    </div>
                  ) : null}
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <Dropdown
                      ariaLabel={t("research_mode")}
                      onChange={(value) => {
                        setResearchMode(value as AiSearchMode);
                      }}
                      options={depthOptions(t)}
                      value={researchMode}
                    />
                    <div className="flex items-center gap-2">
                      <AttachmentPicker
                        disabled={aiSearch.phase !== "done"}
                        items={followupAttachments}
                        onChange={setFollowupAttachments}
                      />
                      {steering ? (
                        <button
                          aria-label={t("ai_steer_send")}
                          className="grid size-9 place-items-center rounded-full text-accent transition-colors hover:bg-accent-soft disabled:pointer-events-none disabled:opacity-40"
                          disabled={!followupQuery.trim()}
                          onClick={() => {
                            const value = followupQuery.trim();
                            if (!value) {
                              return;
                            }
                            setFollowupQuery("");
                            steer.send(value, true);
                          }}
                          title={t("ai_steer_send")}
                          type="button"
                        >
                          <Zap aria-hidden="true" className="size-4" />
                        </button>
                      ) : null}
                      <SubmitCircle
                        disabled={!followupQuery.trim() || (steering ? false : aiSearch.phase !== "done")}
                        label={steering ? t("ai_steer_send") : t("ai_search_followup")}
                        send
                      />
                    </div>
                  </div>
                </form>
              </div>
            ) : null}
          </div>
        ) : showMissing ? (
          <div className="mt-24 flex flex-col items-center text-center animate-fade-up">
            <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
              <MessageCircleQuestion aria-hidden="true" className="size-7" />
            </span>
            <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">{t("knowledge_thread_not_found")}</h1>
            <p className="mt-1.5 text-sm text-ink-2">{t("knowledge_thread_not_found_hint")}</p>
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
        ) : null}
      </main>
    </Shell>
  );
}
