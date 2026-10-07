// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronLeft, ChevronRight, FlaskConical, Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AiSourceMeta } from "@/features/results/aiOverview.ts";
import { AiSearchRunSection } from "@/features/results/aiSearch/AiSearchRunSection.tsx";
import { DEBUG_SCENARIOS, type DebugScenario } from "@/features/results/aiSearch/debugFixtures.ts";
import { applyEvent, type Core, emptyRun } from "@/features/results/aiSearch/timeline.ts";
import { useT } from "@/lib/i18n.ts";

/**
 * The AI debug stage (`/zjsearch/ai/thread/<uuid>?aidebug`) -- the AI
 * features' UNIVERSAL SIMULATOR.  Each scenario is a wire-event SCRIPT
 * replayed through the REAL fold (`applyEvent`) and rendered by the REAL
 * run section; the transport controls scrub the event timeline: drag to
 * any moment, step event-by-event, pause anywhere -- every intermediate
 * state (pending rows, mid-stream sections, the outline growing) is a
 * freezable QA surface.  A new tool row, wire event or state ships with
 * a fixture here; if the simulator can't show it, the UI can't render it.
 */

const NO_FX = { archive: () => {}, saveMemory: () => {}, now: () => Date.now() };
const TICK_MS = 220;

function fold(scenario: DebugScenario, events: Array<Record<string, unknown>>, upto: number): Core {
  let core: Core = {
    phase: "streaming",
    runs: [emptyRun(1, scenario.q, scenario.mode)],
    sources: [],
    error: null,
    threadId: "debug",
  };
  events.slice(0, upto).forEach((event) => {
    core = applyEvent(core, event, NO_FX);
  });
  return core;
}

export function AiDebugStage() {
  const t = useT();
  const [scenarioId, setScenarioId] = useState(DEBUG_SCENARIOS[0]?.id ?? "full");
  /** how many events are applied; Infinity = the settled final state */
  const [count, setCount] = useState<number>(Number.POSITIVE_INFINITY);
  const [playing, setPlaying] = useState(false);
  const scenario: DebugScenario =
    DEBUG_SCENARIOS.find((item) => item.id === scenarioId) ?? (DEBUG_SCENARIOS[0] as DebugScenario);
  /** null = the clarify gate has not been answered yet; "" = skipped */
  const [clarifyTranscript, setClarifyTranscript] = useState<string | null>(null);
  const events = useMemo(
    () => [
      ...scenario.events,
      ...(scenario.clarifyTail && clarifyTranscript !== null ? scenario.clarifyTail(clarifyTranscript) : []),
    ],
    [scenario, clarifyTranscript],
  );
  const total = events.length;
  const at = Math.min(Number.isFinite(count) ? count : total, total);
  const core = useMemo(() => fold(scenario, events, count), [scenario, events, count]);

  // the replay resumes from the scrubber's position; pressing play on the
  // final state restarts from the top
  // biome-ignore lint/correctness/useExhaustiveDependencies: at/count are read ONCE at effect start (the resume point); the interval owns the ticking, re-running on every tick would restart it
  useEffect(() => {
    if (!playing) {
      return;
    }
    let i = at >= total ? 0 : at;
    setCount(i);
    const timer = window.setInterval(() => {
      i += 1;
      setCount(i);
      if (i >= total) {
        window.clearInterval(timer);
        setPlaying(false);
      }
    }, TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- at/count are read ONCE at effect start (the resume point); the interval owns the rest
  }, [playing, events, total]);

  const seek = useCallback(
    (next: number) => {
      setPlaying(false);
      setCount(Math.max(0, Math.min(next, total)));
    },
    [total],
  );
  const step = useCallback(
    (delta: number) => {
      setPlaying(false);
      setCount(Math.max(0, Math.min((Number.isFinite(count) ? count : total) + delta, total)));
    },
    [count, total],
  );
  const pick = useCallback((id: string) => {
    setScenarioId(id);
    setCount(Number.POSITIVE_INFINITY);
    setPlaying(false);
    setClarifyTranscript(null);
  }, []);
  /** the clarify card's submit/skip: apply the transcript and replay the
      continuation (real semantics -- a new research pass on the SAME run) */
  const answerClarify = useCallback(
    (transcript: string) => {
      if (!scenario.clarifyTail) {
        return;
      }
      setClarifyTranscript(transcript);
      setCount(scenario.events.length);
      setPlaying(true);
    },
    [scenario],
  );

  const run = core.runs[core.runs.length - 1];
  const meta: AiSourceMeta[] = useMemo(
    () =>
      core.sources.map((source) => ({
        favicon: source.favicon,
        domain: source.netloc,
        t: source.title,
        u: source.url,
      })),
    [core.sources],
  );
  const lastKind = at > 0 ? String(scenario.events[at - 1]?.e ?? "") : "—";

  if (!run) {
    return null;
  }
  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
      <div className="sticky top-14 z-10 -mx-4 mb-5 border-b border-line bg-bg/90 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <FlaskConical aria-hidden="true" className="size-4 text-accent" />
            {t("ai_debug_stage")}
          </span>
          {DEBUG_SCENARIOS.map((item) => (
            <button
              aria-pressed={item.id === scenarioId}
              className={`rounded-full border px-3 py-1 text-[13px] transition-colors ${
                item.id === scenarioId
                  ? "border-accent-strong bg-accent-soft font-medium text-accent"
                  : "border-line text-ink-3 hover:text-ink"
              }`}
              key={item.id}
              onClick={() => {
                pick(item.id);
              }}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        {/* the EVENT TRANSPORT: scrub the wire timeline like a video -- any
            intermediate state is a freezable QA surface */}
        <div className="mt-2.5 flex items-center gap-2">
          <button
            aria-label={t("ai_debug_restart")}
            className={`grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2/50 hover:text-ink ${playing ? "text-accent" : ""}`}
            onClick={() => {
              pick(scenario.id);
            }}
            title={t("ai_debug_restart")}
            type="button"
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
          </button>
          <button
            aria-label={t("ai_debug_step_back")}
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2/50 hover:text-ink"
            onClick={() => {
              step(-1);
            }}
            title={t("ai_debug_step_back")}
            type="button"
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
          </button>
          <button
            aria-label={playing ? t("ai_debug_pause") : t("ai_debug_play")}
            className={`grid size-8 shrink-0 place-items-center rounded-full transition-colors ${
              playing ? "bg-accent-soft text-accent" : "border border-line text-ink-2 hover:text-ink"
            }`}
            onClick={() => {
              setPlaying(!playing);
            }}
            title={playing ? t("ai_debug_pause") : t("ai_debug_play")}
            type="button"
          >
            {playing ? (
              <Pause aria-hidden="true" className="size-3.5" />
            ) : (
              <Play aria-hidden="true" className="size-3.5" />
            )}
          </button>
          <button
            aria-label={t("ai_debug_step_fwd")}
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2/50 hover:text-ink"
            onClick={() => {
              step(1);
            }}
            title={t("ai_debug_step_fwd")}
            type="button"
          >
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
          <input
            aria-label={t("ai_debug_timeline")}
            className="zjs-range min-w-0 flex-1"
            max={total}
            min={0}
            onChange={(event) => {
              seek(Number(event.target.value));
            }}
            type="range"
            value={at}
          />
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-3">
            {at}/{total} · {lastKind}
          </span>
        </div>
      </div>
      <AiSearchRunSection
        isFirst
        isLast
        live={core.phase === "streaming"}
        onContinue={() => {
          pick(scenario.id);
        }}
        onRegenerate={() => {
          pick(scenario.id);
        }}
        onSubmitClarify={(text) => answerClarify(text ?? "")}
        run={run}
        sourceMeta={meta}
      />
    </div>
  );
}
