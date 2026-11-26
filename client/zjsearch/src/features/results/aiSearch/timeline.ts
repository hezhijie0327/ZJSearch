// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { AiSearchGallery } from "@/features/aiAnswer/aiOverview.ts";
import {
  completeTasks,
  learningFacts,
  learningGaps,
  mergeTaskSnapshot,
  parseClarifyPairs,
} from "@/features/results/aiSearch/ledger.ts";
import type {
  AiDecision,
  AiEngineInventory,
  AiSearchArtifact,
  AiSearchAttachment,
  AiSearchCall,
  AiSearchMode,
  AiSearchRun,
  AiSearchSource,
  AiSearchStage,
  AiSearchStep,
  AiToolMatch,
  Core,
} from "@/features/results/aiSearch/runModel.ts";
import { normalizeCalendar, normalizeCall } from "@/features/results/aiSearch/wireNormalizers.ts";
import { sessionViewport } from "@/lib/browserInput.ts";

/**
 * The AI Search timeline fold (the client half of the wire protocol v2):
 * every wire event is a closed-set timeline operation (framework/wire.py)
 * -- deltas carry their entry id and channel (`think` / `say` / `answer`),
 * calls belong to their entry, one `settle` declares the terminal state.
 * This fold APPENDS; it reconstructs nothing (the old
 * answerFrom/pending/thinkOpen heuristics are gone with the protocol that
 * required them).  Steps mirror the entries one-to-one: a research entry
 * renders as its think segment, its intent narration and its call rows.
 *
 * ONE reducer, TWO executions: the live stream folds through `applyEvent`
 * with the LIVE side effects (reader pages archive, memories persist);
 * a stored thread's evt log replays through the same function with
 * no-op persistence -- a stored run and a live run hit one renderer.
 */

export const LATE_KINDS = new Set(["related", "title", "memory", "tags", "usage", "outline", "section"]);

/** Settle every still-pending call row (abort / stream cut / error settle):
    no timeline row spins forever.  SUB ROWS join the sweep: a child
    batch in flight when the run dies sits one level down (`inner`), and
    an untouched child row would spin on a settled page forever. */
export function interruptPending(runs: AiSearchRun[]): AiSearchRun[] {
  const settleCalls = (calls: AiSearchCall[]): AiSearchCall[] =>
    calls.map((call) => (call.status === "pending" ? { ...call, status: "interrupted" as const } : call));
  const hasPending = (steps: AiSearchStep[]): boolean =>
    steps.some((step) =>
      step.kind === "calls"
        ? step.calls.some((call) => call.status === "pending")
        : step.kind === "sub"
          ? hasPending(step.inner)
          : false,
    );
  const settleSteps = (steps: AiSearchStep[]): AiSearchStep[] =>
    steps.map((step) =>
      step.kind === "calls"
        ? { ...step, calls: settleCalls(step.calls) }
        : step.kind === "sub"
          ? { ...step, inner: settleSteps(step.inner) }
          : step,
    );
  return runs.map((item) => (hasPending(item.steps) ? { ...item, steps: settleSteps(item.steps) } : item));
}

export function settle(core: Core, failed: { error: string } | null, stopped: boolean, now = Date.now()): Core {
  const runs = [...core.runs];
  const lastIdx = runs.length - 1;
  const run = runs[lastIdx];
  if (run) {
    const awaiting = !failed && run.ask !== null && !run.answer.trim() && !stopped;
    const endedAt = awaiting ? null : now;
    runs[lastIdx] = failed
      ? {
          ...run,
          status: "error",
          error: failed.error,
          endedAt,
          browser: null,
          browserSessions: {},
        }
      : {
          ...run,
          endedAt,
          status: awaiting ? "awaiting" : ("done" as const),
          // the LIVE mirror unmounts at the settle (the cookie store and
          // the strip survive in the session lane -- the card was the
          // run's live view, a frozen frame is not worth the rail space).
          // An AWAITING run keeps it: the wait_user window's mirror IS
          // the human's operation surface.
          ...(!awaiting ? { browser: null, browserSessions: {} } : {}),
        };
  }
  const interrupted = interruptPending(runs);
  const settled = interrupted.map((item) =>
    item.status === "streaming"
      ? {
          ...item,
          status: "done" as const,
          plan: completeTasks(item.plan),
          browser: null,
          browserSessions: {},
        }
      : item,
  );
  const hasContent = settled.some((item) => item.answer || item.steps.length > 0);
  const awaiting = settled[settled.length - 1]?.status === "awaiting";
  return {
    ...core,
    runs: settled,
    phase: failed && !hasContent ? "error" : awaiting ? "awaiting" : "done",
    error: failed?.error ?? core.error,
  };
}

/** A v2 wire ``memory`` event's payload (op + target fields -- the fold
    executes it against the store; legacy events without ``op`` read as
    saves). */
export interface MemoryWireEvent {
  op?: "save" | "update" | "reinforce" | "forget";
  kind?: "fact" | "procedure" | "lesson" | "gap";
  id?: string;
  content?: string;
  old?: string;
  state?: "active" | "provisional";
  /** SITE recipe binding (save): the host the recipe answers to */
  host?: string;
}

/** The fold's side-effect ports: the LIVE run archives reader pages and
    executes memory mutations as their events arrive and stamps the wall
    clock; a REPLAY no-ops the persistence (it happened live) and stamps
    the event's own arrival time (the duration displays stay truthful). */
export interface FoldFx {
  archive(url: string, title: string, text: string): void;
  memoryOp(event: MemoryWireEvent): void;
  now(): number;
}

/** The wire-event fold: one timeline operation in, the next state out.
    Exported for the knowledge page's replay (see the module doc).
    ``targetRunNo`` retargets the fold at THAT run instead of the thread's
    last -- outline/section events for a run that is no longer the last
    fold into their own run; everything else (the live stream, replays)
    omits it and keeps the last-run contract. */
export function applyEvent(
  core: Core,
  event: Record<string, unknown>,
  fx: FoldFx,
  pastRefCounts?: Map<string, number>,
  targetRunNo?: number,
): Core {
  const kind = event.e as string;
  // the bootstrap event CREATES the run -- it must pass before the
  // last-run guard (there is no run to fold into yet, that's the point)
  if (kind === "client.start") {
    const fresh = emptyRun(Number(event.runNo) || 1, String(event.q ?? ""), (event.mode as AiSearchMode) ?? "balanced");
    fresh.startedAt = Number(event.startedAt) || fresh.startedAt;
    // attachment METADATA rides the bootstrap event (the bytes live in the
    // browser's attachment table, never in the event log)
    const rawAttach = (Array.isArray(event.attachments) ? event.attachments : []) as Array<Record<string, unknown>>;
    if (rawAttach.length) {
      // the simulator's fixtures inline the bytes (no attachment table in
      // the debug stage); the live wire event carries metadata only
      fresh.attachments = rawAttach.map((raw) => ({
        kind: (raw.kind === "file" ? "file" : "image") as AiSearchAttachment["kind"],
        mime: String(raw.mime ?? ""),
        name: String(raw.name ?? "") || undefined,
        bytes: Number(raw.bytes) || 0,
        data: String(raw.data ?? "") || undefined,
      }));
    }
    return { ...core, runs: [...core.runs, fresh], phase: "streaming" };
  }
  const runs = [...core.runs];
  let lastIdx = runs.length - 1;
  if (targetRunNo !== undefined && !kind.startsWith("client.")) {
    const idx = runs.findIndex((item) => item.runNo === targetRunNo);
    if (idx >= 0) {
      lastIdx = idx;
    }
  }
  const run = runs[lastIdx];
  if (!run) {
    return core;
  }
  const entryId = Number(event.id) || 0;
  const stepIndexFor = (kind2: "think" | "intent" | "calls"): number =>
    run.steps.findIndex((step) => step.kind === kind2 && (step as { entry?: number }).entry === entryId);
  // a SUBAGENT's entry (base 10000): its think/say/call events route into
  // the sub row's inner timeline instead of the lead's flat steps
  const subIndexOf = run.steps.findIndex((step) => step.kind === "sub" && step.entry === entryId);
  const inSub = run.steps[subIndexOf];
  const patchSub = (patch: (sub: Extract<AiSearchStep, { kind: "sub" }>) => Extract<AiSearchStep, { kind: "sub" }>) => {
    const steps = [...run.steps];
    steps[subIndexOf] = patch(steps[subIndexOf] as Extract<AiSearchStep, { kind: "sub" }>);
    runs[lastIdx] = { ...run, steps };
    return { ...core, runs };
  };

  switch (kind) {
    case "client.clarify": {
      // the user answered the clarify gate: the run restarts on the SAME
      // run id (the asking record survives, the answer resets)
      runs[lastIdx] = {
        ...run,
        status: "streaming",
        answer: "",
        clarify: String(event.text ?? ""),
        ask: null,
        browser: null,
        // the session map dies with the live card -- a stale entry's last
        // frame must never resurface as the mirror's fallback
        browserSessions: {},
        wrappingUp: false,
        startedAt: Number(event.startedAt) || run.startedAt,
        endedAt: null,
        mode: (event.mode as AiSearchMode) ?? run.mode,
        mode0: (event.mode as AiSearchMode) ?? run.mode0,
      };
      return { ...core, runs, phase: "streaming" };
    }
    case "client.retry": {
      const clarifyText = typeof event.clarify === "string" && event.clarify ? event.clarify : undefined;
      runs[lastIdx] = {
        ...run,
        status: "streaming",
        // the retry keeps its confirmed direction: the clarify step
        // re-opens the rebuilt timeline.  The LEDGER resets with the
        // attempt: the server built a fresh Searches (empty findings, a
        // fresh task list) -- showing the dead attempt's findings card,
        // task states or decision verdicts would present state the
        // writer never received
        findings: [],
        plan: [],
        decisions: [],
        steps: (clarifyText
          ? [{ kind: "clarify" as const, pairs: parseClarifyPairs(clarifyText) }]
          : []) as AiSearchStep[],
        answer: "",
        galleries: [],
        related: [],
        ask: null,
        error: null,
        wrappingUp: false,
        startedAt: Number(event.startedAt) || run.startedAt,
        endedAt: null,
        mode: (event.mode as AiSearchMode) ?? run.mode,
        mode0: (event.mode as AiSearchMode) ?? run.mode0,
      };
      return { ...core, runs, phase: "streaming", error: null };
    }
    case "client.stop": {
      if (core.phase !== "streaming") {
        return core;
      }
      const flagged = runs.map((item, index) => (index === lastIdx ? { ...item, stopped: true } : item));
      return { ...settle({ ...core, runs: flagged }, null, true, fx.now()), phase: "done" };
    }
    case "client.reattach": {
      // the SAME run RE-SUBSCRIBES to its live server handle (the attach
      // probe of the continue path succeeded -- the run never stopped):
      // only the failure marks revert; unlike client.resume the stage
      // spine STAYS -- the replayed tail continues the run's own history
      // (no plan/research/write events re-fire on an attach), so a
      // mid-write reattach keeps the report document as the focus.
      runs[lastIdx] = {
        ...run,
        status: "streaming",
        error: null,
        ask: null,
        browser: null,
        // the session map dies with the live card -- a stale entry's last
        // frame must never resurface as the mirror's fallback
        browserSessions: {},
        wrappingUp: false,
        endedAt: null,
      };
      return { ...core, runs, phase: "streaming" };
    }
    case "client.resume": {
      // the SAME run continues in place (the dead attempt's conversation
      // rides the request back as the replayed context): steps, sources,
      // ledger and cards all survive -- only the failure state resets.
      // The server-side ledgers restart empty and refill as the model
      // re-affirms them (the resume note instructs exactly that), so the
      // visible cards never flash empty.  The stage spine RESTARTS with
      // the resumed stream (plan -> research -> write re-fire): keeping
      // the old stages would append echo duplicates ([plan, research,
      // plan, research]) -- the phases are one-directional, so the fresh
      // sequence IS the run's history from here.
      runs[lastIdx] = {
        ...run,
        status: "streaming",
        error: null,
        ask: null,
        browser: null,
        // the session map dies with the live card -- a stale entry's last
        // frame must never resurface as the mirror's fallback
        browserSessions: {},
        wrappingUp: false,
        endedAt: null,
        stages: [],
        mode: (event.mode as AiSearchMode) ?? run.mode,
        mode0: (event.mode as AiSearchMode) ?? run.mode0,
      };
      return { ...core, runs, phase: "streaming" };
    }
    case "ctx": {
      // storage-only wire event (the resume checkpoint): intercepted
      // BEFORE the fold on the live path -- this case only proves the
      // reducer tolerates one (a fixture, a future path)
      return core;
    }
    case "phase": {
      // the macro-stage spine: one value active, the history kept (the
      // run_summary record replays it); unknown names ignore
      const name = String(event.name ?? "") as AiSearchStage;
      if (!["ideate", "plan", "research", "write"].includes(name)) {
        return core;
      }
      const stages = run.stages[run.stages.length - 1] === name ? run.stages : [...run.stages, name];
      runs[lastIdx] = { ...run, stage: name, stages };
      return { ...core, runs };
    }
    case "open": {
      if (String(event.kind) === "sub") {
        // a delegation's sub row opens: the live mini-timeline container.
        // The child RE-OPENS per round (same id) -- an existing row just
        // goes back to active, never duplicates
        const existing = run.steps.findIndex((step) => step.kind === "sub" && step.entry === entryId);
        if (existing >= 0) {
          return patchSub((sub) => ({ ...sub, status: "active" }));
        }
        runs[lastIdx] = {
          ...run,
          steps: [
            ...run.steps,
            {
              kind: "sub",
              entry: entryId,
              agent: String(event.agent ?? "") || undefined,
              title: String(event.title ?? ""),
              objective: String(event.objective ?? ""),
              status: "active",
              inner: [],
            },
          ],
        };
        return { ...core, runs };
      }
      if (String(event.kind) === "write") {
        // the writer phase opened: the write line covers its silence
        runs[lastIdx] = { ...run, wrappingUp: true };
        return { ...core, runs };
      }
      return core;
    }
    case "client.delete_run": {
      // the run-delete control: the section folds out of the timeline
      // (the storage rows left via deleteRunData -- this fold is the
      // in-memory mirror only)
      const runNo = Number(event.runNo) || 0;
      const runs = core.runs.filter((run) => run.runNo !== runNo);
      return { ...core, runs, phase: runs.length > 0 ? core.phase : "done" };
    }
    case "think": {
      // a research/write entry's reasoning: its own think segment
      const text = String(event.t ?? "");
      if (inSub) {
        // the child's reasoning STREAMS in deltas: merge into the entry's
        // open segment (the top-level path's stepIndexFor rule) -- one
        // inner row per delta once shredded a child's think into
        // one-word think-process toggles
        return patchSub((sub) => {
          const inner = [...sub.inner];
          const last = inner[inner.length - 1];
          if (last && last.kind === "think" && last.entry === entryId) {
            inner[inner.length - 1] = { ...last, text: last.text + text };
          } else {
            inner.push({ kind: "think", text, entry: entryId });
          }
          return { ...sub, inner };
        });
      }
      const steps = [...run.steps];
      const idx = stepIndexFor("think");
      if (idx >= 0) {
        const step = steps[idx] as Extract<AiSearchStep, { kind: "think" }>;
        steps[idx] = { ...step, text: step.text + text };
      } else {
        steps.push({ kind: "think", text, entry: entryId });
      }
      runs[lastIdx] = { ...run, steps };
      return { ...core, runs };
    }
    case "say": {
      // a research entry's narration: its intent line
      const text = String(event.t ?? "");
      if (inSub) {
        // the same delta-merge rule as the sub think path: the child's
        // narration streams too
        return patchSub((sub) => {
          const inner = [...sub.inner];
          const last = inner[inner.length - 1];
          if (last && last.kind === "intent" && last.entry === entryId) {
            inner[inner.length - 1] = { ...last, text: last.text + text };
          } else {
            inner.push({ kind: "intent", text, entry: entryId });
          }
          return { ...sub, inner };
        });
      }
      const steps = [...run.steps];
      const idx = stepIndexFor("intent");
      if (idx >= 0) {
        const step = steps[idx] as Extract<AiSearchStep, { kind: "intent" }>;
        steps[idx] = { ...step, text: step.text + text };
      } else {
        steps.push({ kind: "intent", text, entry: entryId });
      }
      runs[lastIdx] = { ...run, steps };
      return { ...core, runs };
    }
    case "steer": {
      // a user steering of the live run: the quoted-steer line rides the
      // timeline
      // (the record shows WHERE the course changed)
      const steps = [...run.steps];
      steps.push({
        kind: "steer",
        text: String(event.text ?? ""),
        delivery: String(event.delivery ?? "guide") === "preempt" ? "preempt" : "guide",
        status: String(event.status ?? "drained") === "discarded" ? "discarded" : "drained",
      });
      const next = { ...run, steps };
      // the direct-answer pick's structured steer: the run's output shape
      // folds back to its PLAIN depth -- the model's settled
      // set_deliverable row folded run.mode FORWARD, the reader's
      // withdrawal folds it BACK (the event is journaled, replays re-derive
      // the same reversal; the settled record keeps the OUTPUT STRUCTURE
      // card as its format record -- the direct face, never a hole).  A
      // report/deck birth is a FORMAT on the deep tier -- withdrawing it
      // lands on the tier's plain depth.
      if (String((event as { shape?: unknown }).shape ?? "") === "direct") {
        next.mode = run.mode0 === "report" || run.mode0 === "deck" ? "deep" : run.mode0;
      }
      runs[lastIdx] = next;
      return { ...core, runs };
    }
    case "compact": {
      // the research conversation was compacted at the round boundary:
      // a separator line between the steps (the context gauge moment)
      const rawTrigger = String(event.trigger ?? "auto");
      const steps = [
        ...run.steps,
        {
          kind: "compact" as const,
          trigger: (["micro", "auto", "reactive"].includes(rawTrigger) ? rawTrigger : "auto") as
            | "micro"
            | "auto"
            | "reactive",
          pre: Number(event.pre) || 0,
          post: Number(event.post) || 0,
          summarized: Number(event.summarized) || 0,
          kept: Number(event.kept) || 0,
        },
      ];
      runs[lastIdx] = { ...run, steps };
      return { ...core, runs };
    }
    case "calls": {
      const items = (event.items as Array<Record<string, unknown>>) ?? [];
      if (inSub) {
        // the batch's address is the child's per-turn id (``turn``, kept
        // by the delegation pump) -- every inner batch shares the sub
        // row's gid, which only ROUTES the event.  ``round`` is the
        // child's own counter -- the exact join key its sources items
        // carry (the count fallback covers pre-turn replays).
        const turn = Number(event.turn) || entryId;
        return patchSub((sub) => ({
          ...sub,
          inner: [
            ...sub.inner,
            {
              kind: "calls",
              entry: turn,
              round: Number(event.round) || sub.inner.filter((step) => step.kind === "calls").length + 1,
              calls: items.map((item) => normalizeCall(item)),
            },
          ],
        }));
      }
      // the in-round display index: max existing + 1 (a resumed run's
      // steps keep their stored rounds -- a count would restart at 1)
      const round = run.steps.reduce((max, step) => Math.max(max, step.kind === "calls" ? step.round : 0), 0) + 1;
      runs[lastIdx] = {
        ...run,
        steps: [
          ...run.steps,
          {
            kind: "calls",
            entry: entryId,
            round,
            calls: items.map((item) => normalizeCall(item)),
          },
        ],
      };
      return { ...core, runs };
    }
    case "call": {
      // ONE call settled (the entry id + in-round position address the row).
      // ONE settlement shape for the lead AND the subagent timelines: the
      // old copy had drifted (the sub path dropped result/answers/text/
      // dupes/preview/action and the corpus archive -- a subagent's
      // calculate verdicts and reading panes silently vanished).
      const callId = Number(event.call) || 0;
      const settled = (call: AiSearchCall): AiSearchCall =>
        call.id === callId
          ? {
              ...call,
              status: (event.status as AiSearchCall["status"]) ?? "error",
              ...(event.n !== undefined ? { n: Number(event.n) || 0 } : {}),
              ...(event.ms !== undefined ? { ms: Number(event.ms) || 0 } : {}),
              ...(event.feed !== undefined ? { feed: String(event.feed ?? "") || undefined } : {}),
              ...(event.raw !== undefined ? { raw: String(event.raw ?? "") || undefined } : {}),
              ...(event.chars !== undefined ? { chars: Number(event.chars) || 0 } : {}),
              ...(event.result !== undefined ? { result: String(event.result ?? "") } : {}),
              ...(event.answers !== undefined && event.answers !== null
                ? { answers: event.answers as Record<string, unknown> }
                : {}),
              ...(event.inventory !== undefined && event.inventory !== null
                ? {
                    inventory: {
                      total: Number((event.inventory as AiEngineInventory).total) || 0,
                      categories: Array.isArray((event.inventory as AiEngineInventory).categories)
                        ? (event.inventory as AiEngineInventory).categories
                        : [],
                      disabled: Array.isArray((event.inventory as AiEngineInventory).disabled)
                        ? (event.inventory as AiEngineInventory).disabled
                        : [],
                    },
                  }
                : {}),
              ...(event.tools !== undefined && event.tools !== null
                ? { tools: (event.tools as AiToolMatch[]).filter((m) => m?.name) }
                : {}),
              ...(event.text !== undefined ? { text: String(event.text ?? "") || undefined } : {}),
              ...(event.dupes !== undefined
                ? {
                    dupes: (Array.isArray(event.dupes) ? event.dupes : [])
                      .map((n) => Number(n) || 0)
                      .filter((n) => n > 0),
                  }
                : {}),
              ...(event.preview !== undefined ? { text: String(event.preview ?? "") || undefined } : {}),
              ...(event.label !== undefined ? { label: String(event.label ?? "") || undefined } : {}),
              ...(event.action !== undefined ? { name: String(event.action ?? "") } : {}),
              // browse settlements: the page state, the volatile frame
              // jpeg and the fresh outline (img stripped from the persisted
              // copy by the stream consumer)
              ...(event.page !== undefined && event.page !== null
                ? {
                    page: {
                      url: String((event.page as Record<string, unknown>).url ?? ""),
                      title: String((event.page as Record<string, unknown>).title ?? ""),
                    },
                  }
                : {}),
              ...(event.img !== undefined ? { img: String(event.img ?? "") || undefined } : {}),
              ...(event.shot !== undefined ? { shot: event.shot === true || undefined } : {}),
              ...(event.snapshot !== undefined ? { snapshot: String(event.snapshot ?? "") || undefined } : {}),
              ...(Array.isArray(event.tabs)
                ? {
                    tabs: (event.tabs as Array<Record<string, unknown>>).map((t) => ({
                      index: Number(t.index) || 0,
                      url: String(t.url ?? ""),
                      title: String(t.title ?? ""),
                      active: t.active === true,
                    })),
                  }
                : {}),
              ...(Array.isArray(event.steps)
                ? {
                    steps: (event.steps as Array<Record<string, unknown>>).map((s) => ({
                      action: String(s.action ?? ""),
                      status: String(s.status ?? ""),
                      label: String(s.label ?? ""),
                      url: s.url ? String(s.url) : undefined,
                      title: s.title ? String(s.title) : undefined,
                      chars: typeof s.chars === "number" ? s.chars : undefined,
                      text: typeof s.text === "string" && s.text ? s.text : undefined,
                      sections: Array.isArray(s.sections)
                        ? (s.sections as Array<Record<string, unknown>>)
                            .map((sec) => ({
                              url: String(sec.url ?? ""),
                              title: String(sec.title ?? ""),
                              chars: typeof sec.chars === "number" ? sec.chars : undefined,
                              text: String(sec.text ?? ""),
                            }))
                            .filter((sec) => sec.text)
                        : undefined,
                      errors: Array.isArray(s.errors)
                        ? (s.errors as Array<Record<string, unknown>>)
                            .map((failure) => ({
                              index: String(failure.index ?? ""),
                              url: String(failure.url ?? ""),
                              error: String(failure.error ?? ""),
                            }))
                            .filter((failure) => failure.error)
                        : undefined,
                    })),
                  }
                : {}),
              ...(event.calendar !== undefined && event.calendar !== null
                ? { calendar: normalizeCalendar(event.calendar) }
                : {}),
            }
          : call;
      // a page read's extracted text persists as a document row (the
      // url-identity full-text store the recall pages from)
      const text = typeof event.text === "string" ? event.text : "";
      const archive = () => {
        if (text) {
          const url = String(event.url ?? "");
          fx.archive(url, run.sources.find((source) => source.url === url)?.title ?? "", text);
        }
        // a multi batch's read steps carry their OWN document (the
        // wire-only per-step text): the same url-identity archive a
        // standalone read joins -- the recall pages from the batch's
        // reads exactly like it pages from a single read.  A multi-INDEX
        // read's sections archive PER TAB (the step's own text/url would
        // file every tab's body under the last tab's identity)
        for (const step of Array.isArray(event.steps) ? (event.steps as Array<Record<string, unknown>>) : []) {
          const sections = Array.isArray(step.sections) ? (step.sections as Array<Record<string, unknown>>) : [];
          if (sections.length) {
            for (const section of sections) {
              const secUrl = String(section.url ?? "");
              const secText = String(section.text ?? "");
              if (secText && secUrl.startsWith("http")) {
                fx.archive(
                  secUrl,
                  run.sources.find((source) => source.url === secUrl)?.title ?? String(section.title ?? ""),
                  secText,
                );
              }
            }
            continue;
          }
          const stepText = typeof step.text === "string" ? step.text : "";
          const stepUrl = String(step.url ?? "");
          if (stepText && stepUrl.startsWith("http")) {
            fx.archive(
              stepUrl,
              run.sources.find((source) => source.url === stepUrl)?.title ?? String(step.title ?? ""),
              stepText,
            );
          }
        }
      };
      if (inSub) {
        // the settlement lands on ONE batch: the pump's ``turn`` stamp
        // names it (absent on pre-turn replays -- the gid fallback keeps
        // the old cross-round bleed there, historical rows only)
        const turn = Number(event.turn) || entryId;
        const next = patchSub((sub) => ({
          ...sub,
          inner: sub.inner.map((step) => {
            if (step.kind !== "calls" || step.entry !== turn) {
              return step;
            }
            return { ...step, calls: step.calls.map(settled) };
          }),
        }));
        archive();
        return next;
      }
      const steps = run.steps.map((step) => {
        if (step.kind !== "calls" || step.entry !== entryId) {
          return step;
        }
        return { ...step, calls: step.calls.map(settled) };
      });
      // THE DELIVERABLE FLIP's client surface: a settled set_deliverable
      // row re-shapes the run -- run.mode drives the rail's structure card
      // and stays a pure event fold, so journal replays re-derive it.
      const flipped = run.steps
        .filter((step) => step.kind === "calls" && step.entry === entryId)
        .flatMap((step) => (step.kind === "calls" ? step.calls : []))
        .find((call) => call.id === callId);
      const flipShape =
        flipped?.tool === "set_deliverable" && event.status === "ok"
          ? String(flipped.q || (flipped.args as Record<string, unknown> | undefined)?.shape || "")
          : "";
      runs[lastIdx] = {
        ...run,
        steps,
        ...(flipShape === "report" || flipShape === "deck" ? { mode: flipShape as AiSearchMode } : {}),
      };
      archive();
      return { ...core, runs };
    }
    case "browser": {
      // the interactive session's mirror frame: replaces wholesale (img
      // stripped before persisting -- the event log keeps meta only).
      // R3B: the frames carry their session id (agent) -- the lead's
      // frame also rides run.browser (the takeover's auto-open watch)
      const sid = String(event.agent || "lead");
      const view = {
        url: String(event.url ?? ""),
        title: String(event.title ?? ""),
        img: String(event.img ?? ""),
        w: Number(event.w) || sessionViewport().w,
        h: Number(event.h) || sessionViewport().h,
        ...(event.wait_left !== undefined ? { waitLeft: Number(event.wait_left) || 0 } : {}),
        ...(event.px !== undefined && event.py !== undefined
          ? { px: Number(event.px), py: Number(event.py), pk: String(event.pk ?? "") }
          : {}),
        ...(Array.isArray(event.box) ? { box: event.box.map(Number) } : {}),
        ...(event.x2 !== undefined && event.y2 !== undefined ? { x2: Number(event.x2), y2: Number(event.y2) } : {}),
        ...(event.name !== undefined ? { name: String(event.name) } : {}),
        ...(Array.isArray(event.tabs)
          ? {
              tabs: (event.tabs as Array<Record<string, unknown>>).map((t) => ({
                index: Number(t.index) || 0,
                url: String(t.url ?? ""),
                title: String(t.title ?? ""),
                active: t.active === true,
              })),
            }
          : {}),
      };
      runs[lastIdx] = {
        ...run,
        ...(sid === "lead" ? { browser: view } : {}),
        browserSessions: { ...(run.browserSessions ?? {}), [sid]: view },
      };
      return { ...core, runs };
    }
    case "close":
      if (inSub) {
        // the subagent settled: its row flips to done (the digest arrived
        // as the delegation call's tool result)
        return patchSub((sub) => ({ ...sub, status: "done" }));
      }
      return core;
    case "plan": {
      const items = (event.items as Array<Record<string, unknown>>) ?? [];
      runs[lastIdx] = { ...run, plan: mergeTaskSnapshot(run.plan, items) };
      return { ...core, runs };
    }
    case "decisions": {
      // the run's decision results (framework gates + model evaluate): the
      // rail's decisions card reads them -- raw answers included
      const items = (Array.isArray(event.items) ? event.items : []).map((row) => {
        const record = row as Record<string, unknown>;
        return {
          purpose: String(record.purpose ?? ""),
          question: typeof record.question === "string" ? record.question : undefined,
          target: typeof record.target === "string" ? record.target : undefined,
          // the evaluate tool's verdict key is `verdicts` (the others ride
          // `answers`)
          answer: record.answer ?? record.answers ?? undefined,
          // record_questions (name→question text) folds into the record;
          // the generic renderer's label resolution chain reads it here
          ...(Array.isArray(record.record_questions)
            ? { record_questions: record.record_questions as AiDecision["record_questions"] }
            : {}),
          ms: typeof record.ms === "number" ? record.ms : undefined,
          record,
        };
      });
      runs[lastIdx] = { ...run, decisions: [...(run.decisions ?? []), ...items] };
      return { ...core, runs };
    }
    case "findings": {
      // the BELIEF LEDGER's AUTHORITATIVE snapshot -- replace, never
      // merge (the server's list is the truth, the writer read the same)
      runs[lastIdx] = {
        ...run,
        findings: learningFacts(event.items),
        gaps: learningGaps(event.gaps),
      };
      return { ...core, runs };
    }
    case "sources": {
      // the global [n] registry of the cited feed -- new entries append, a
      // crawled re-emission upgrades the existing card in place, an
      // img-bearing entry back-fills a missing thumbnail.  The producing
      // turn rides the event (`turn` on a delegation-pumped child's
      // event, the executor's `entry` stamp on a lead's) -- it becomes
      // each item's row-join key.
      const items = (event.items as Array<Record<string, unknown>>) ?? [];
      const turn = Number(event.turn ?? event.entry) || undefined;
      const fresh: AiSearchSource[] = [];
      for (const item of items) {
        const url = String(item.url ?? "");
        if (!url) {
          continue;
        }
        fresh.push({
          n: Number(item.n) || 0,
          runNo: run.runNo,
          round: Number(item.round) || 0,
          callId: Number(item.id) || 0,
          agent: String(item.agent ?? "") || undefined,
          turn,
          title: String(item.title ?? ""),
          url,
          netloc: String(item.netloc ?? ""),
          favicon: String(item.favicon ?? ""),
          browser: item.browser === true,
          img: String(item.img ?? "") || undefined,
          category: String(item.category ?? "") || undefined,
          crawled: Boolean(item.crawled),
          content: String(item.content ?? "") || undefined,
          history: Boolean(item.history),
          // the cross-session badge: how many PAST runs referenced this
          // url, captured at the pre-run recall (never the run's own
          // ref-count increment -- the map is read-only after beginRun)
          pastRefs: pastRefCounts?.get(url) || undefined,
          engines: Array.isArray(item.engines) ? item.engines.map((e) => String(e)).slice(0, 4) : undefined,
          score: typeof item.score === "number" ? item.score : undefined,
          meta: String(item.meta ?? "") || undefined,
        });
      }
      if (!fresh.length) {
        return core;
      }
      const merged = [...run.sources];
      for (const source of fresh) {
        const at = merged.findIndex((candidate) => candidate.n === source.n);
        const existing = at >= 0 ? merged[at] : undefined;
        if (existing) {
          // REPLACEMENT, not mutation: the array copy alone shares the
          // previous snapshot's row objects -- writing their fields would
          // rewrite history a replay holds elsewhere
          merged[at] = {
            ...existing,
            crawled: existing.crawled || source.crawled,
            browser: existing.browser || source.browser,
            img: existing.img ?? source.img,
          };
        } else {
          merged.push(source);
        }
      }
      merged.sort((a, b) => a.n - b.n);
      const flat = [...core.sources];
      for (const source of merged) {
        const at = flat.findIndex((existing) => existing.n === source.n);
        if (at < 0) {
          flat.push(source);
        }
      }
      runs[lastIdx] = { ...run, sources: merged };
      return { ...core, runs, sources: flat };
    }
    case "outline": {
      // the REPORT/DECK mode's authoritative snapshot -- replace, never merge
      const rawSections = (Array.isArray(event.sections) ? event.sections : []) as Array<Record<string, unknown>>;
      if (!rawSections.length) {
        return core;
      }
      runs[lastIdx] = {
        ...run,
        deck: String(event.shape ?? "") === "deck",
        outline: {
          title: String(event.title ?? ""),
          subtitle: String(event.subtitle ?? "") || undefined,
          template: String(event.template ?? "").trim() || undefined,
          sections: rawSections.map((raw) => ({
            id: String(raw.id ?? ""),
            title: String(raw.title ?? ""),
            brief: String(raw.brief ?? "") || undefined,
            status: (["pending", "writing", "done", "failed"].includes(String(raw.status))
              ? String(raw.status)
              : "pending") as "pending" | "writing" | "done" | "failed",
          })),
        },
        sections: run.sections ?? {},
        artifacts: run.artifacts ?? {},
      };
      return { ...core, runs };
    }
    case "artifact": {
      // ONE recorded table -- snapshot-replace per id
      const id = Number(event.id) || 0;
      const item = event.item as Record<string, unknown> | undefined;
      if (!id || !item) {
        return core;
      }
      const artifact: AiSearchArtifact = {
        id,
        title: String(item.title ?? ""),
        columns: ((item.columns as unknown[]) ?? []).map(String),
        rows: ((item.rows as Array<Record<string, unknown>>) ?? []).map((row) => ({
          cells: ((row.cells as unknown[]) ?? []).map(String),
          refs: ((row.refs as unknown[]) ?? []).map((ref) => Number(ref) || 0).filter((ref) => ref > 0),
        })),
        note: String(item.note ?? "") || undefined,
      };
      runs[lastIdx] = { ...run, artifacts: { ...(run.artifacts ?? {}), [id]: artifact } };
      return { ...core, runs };
    }
    case "section": {
      // the report's per-section markdown delta -- the section buffer AND
      // the answer document grow together (the answer field stays the one
      // full-text the knowledge projection and the copy path read)
      const id = String(event.id ?? "");
      const delta = String(event.t ?? "");
      if (!id || !delta) {
        return core;
      }
      // the think-marked delta is the section's REASONING (the writer
      // relays its working turn): its own buffer, never the body --
      // reset-tracked per channel, so a rewritten section's fresh
      // reasoning replaces the buffer while the body reset stays the
      // body's own contract
      if (event.think === true) {
        const thinkPrev = run.sectionThink?.[id] ?? "";
        const think = event.reset === true ? delta : thinkPrev + delta;
        runs[lastIdx] = { ...run, sectionThink: { ...(run.sectionThink ?? {}), [id]: think } };
        return { ...core, runs };
      }
      // the wire's RESET contract: a stream whose first delta carries
      // `reset: true` REPLACES whatever the section already buffers.
      // No producer remains (the per-section synthesis retired), but
      // stored records' replays still carry the mark -- the fold keeps
      // honoring it.
      const replace = event.reset === true;
      const prev = run.sections?.[id] ?? "";
      const sections = { ...(run.sections ?? {}), [id]: replace ? delta : prev + delta };
      if (run.outline) {
        // REPORT runs keep `answer` as the DERIVED document glue in outline
        // order -- a replacement splices out cleanly instead of string-
        // hunting through the glued text (this is also the replay-safe
        // path: the same events fold to the same answer every time)
        const answer = run.outline.sections
          .map((section) => sections[section.id] ?? "")
          .filter(Boolean)
          .join("\n\n");
        runs[lastIdx] = { ...run, sections, answer };
        return { ...core, runs };
      }
      // a markdown block boundary BETWEEN SECTIONS (not between deltas --
      // the check used to run per delta, prepending \n\n to EVERY streamed
      // chunk and shattering the glued document into one-paragraph-per-
      // delta fragments in the knowledge projection while the per-section
      // panes looked fine): a NEW section id's first delta glues with the
      // separator, a section's own deltas append raw
      const fresh = !prev;
      const sep = fresh && run.answer && !run.answer.endsWith("\n") ? "\n\n" : "";
      runs[lastIdx] = { ...run, sections, answer: run.answer + sep + delta };
      return { ...core, runs };
    }
    case "answer": {
      // the writer's answer buffer -- ITS OWN channel, never narration
      runs[lastIdx] = { ...run, answer: run.answer + String(event.t ?? "") };
      return { ...core, runs };
    }
    case "ask": {
      runs[lastIdx] = {
        ...run,
        ask: {
          intro: String(event.intro ?? ""),
          questions: ((event.questions as Array<Record<string, unknown>>) ?? []).map((raw) => ({
            q: String(raw.q ?? ""),
            type: String(raw.type ?? "single") === "multi" ? ("multi" as const) : ("single" as const),
            options: ((raw.options as unknown[]) ?? []).map(String),
          })),
        },
      };
      return { ...core, runs };
    }
    case "gallery": {
      const items = (event.items as Array<Record<string, unknown>>) ?? [];
      const fresh: AiSearchGallery[] = [];
      for (const item of items) {
        const url = String(item.u ?? "");
        if (!url) {
          continue;
        }
        const n = Number(item.n) || 0;
        fresh.push({ url, n, title: run.sources.find((source) => source.n === n)?.title ?? "" });
      }
      if (!fresh.length) {
        return core;
      }
      runs[lastIdx] = { ...run, galleries: [...run.galleries, fresh] };
      return { ...core, runs };
    }
    case "title":
      runs[lastIdx] = { ...run, title: String(event.text ?? "").slice(0, 60) };
      return { ...core, runs };
    case "related":
      runs[lastIdx] = { ...run, related: ((event.items as string[]) ?? []).map(String).slice(0, 3) };
      return { ...core, runs };
    case "usage": {
      // LATE: the trailing completions' (related fallback / memory
      // extraction) updated gates account -- ABSOLUTE values, the client
      // sets the bucket (idempotent)
      const gates = event.gates as NonNullable<AiSearchRun["usage"]>["gates"];
      if (gates && typeof gates === "object") {
        const base = run.usage ?? { input: 0, output: 0, thoughts: null, cached: 0, cache_write: 0 };
        runs[lastIdx] = { ...run, usage: { ...base, gates } };
        return { ...core, runs };
      }
      return core;
    }
    case "memory":
      // a memory mutation (op=save/update/reinforce/forget -- legacy
      // events without op read as saves): the client's store executes
      // it (no timeline rendering -- a silent background maintenance)
      if (typeof event.content === "string" && event.content) {
        fx.memoryOp(event as MemoryWireEvent);
      }
      return core;
    case "tags": {
      // LATE: the extractor's concept tags for this run -- parked on the
      // run so settleRun writes them into the projections (and the evt
      // log carries them for replay)
      const items = ((event.items as string[]) ?? []).map(String).filter(Boolean).slice(0, 12);
      if (items.length) {
        runs[lastIdx] = { ...run, tags: items };
        return { ...core, runs };
      }
      return core;
    }
    case "settle": {
      // the SERVER-DECLARED terminal state (status: done | awaiting |
      // error) -- no client inference
      const status = String(event.status ?? "done");
      const usage = event.usage as AiSearchRun["usage"];
      const halt = typeof event.halt === "string" && event.halt ? event.halt : null;
      const haltReason = typeof event.halt_reason === "string" && event.halt_reason ? event.halt_reason : null;
      let next: AiSearchRun = {
        ...run,
        browser: null,
        finish: event.finish ? String(event.finish) : (run.finish ?? null),
        model: typeof event.model === "string" && event.model ? event.model : (run.model ?? null),
        usage: usage
          ? {
              input: Number(usage.input) || 0,
              output: Number(usage.output) || 0,
              thoughts: typeof usage.thoughts === "number" ? usage.thoughts : null,
              cached: Number(usage.cached) || 0,
              cache_write: Number(usage.cache_write) || 0,
              research: usage.research ?? null,
              write: usage.write ?? null,
              gates: usage.gates ?? null,
              rerank: usage.rerank,
              decision: usage.decision,
              embedding: usage.embedding,
            }
          : (run.usage ?? null),
        halt,
        haltReason,
      };
      if (status === "awaiting") {
        next = { ...next, status: "awaiting", endedAt: null };
        runs[lastIdx] = next;
        return { ...core, runs, phase: "awaiting" };
      }
      if (next.outline) {
        // THE SPINNING-FOREVER GUARD: outline statuses ride snapshots, and
        // a section whose stream died mid-write may never see its terminal
        // snapshot (a dead process, a replay whose tail is simply absent).
        // A SECTION-STREAMED record's settle with a section still
        // pending/writing means that section is DEAD -- coalesce it to
        // failed so the TOC tells the truth.  A single-write document (no
        // section events at all -- the unified architecture) delivered its
        // whole outline as ONE answer: pending coalesces to done.
        const streamed = Object.keys(run.sections ?? {}).length > 0;
        const sections = next.outline.sections.map((section) =>
          section.status === "done" || section.status === "failed"
            ? section
            : { ...section, status: streamed ? ("failed" as const) : ("done" as const) },
        );
        next = { ...next, outline: { ...next.outline, sections } };
      }
      if (status === "error") {
        const reason = halt ?? "error";
        next = { ...next, status: "error", error: reason, endedAt: fx.now() };
        runs[lastIdx] = next;
        const withInterrupted = interruptPending(runs);
        const hasContent = withInterrupted.some((item) => item.answer || item.steps.length > 0);
        return {
          ...core,
          runs: withInterrupted,
          phase: hasContent ? "done" : "error",
          error: hasContent ? core.error : reason,
        };
      }
      runs[lastIdx] = next;
      return settle({ ...core, runs }, null, false, fx.now());
    }
    default:
      return core;
  }
}

export function emptyRun(runNo: number, q: string, mode: AiSearchMode): AiSearchRun {
  return {
    runNo,
    q,
    status: "streaming",
    error: null,
    steps: [],
    answer: "",
    sources: [],
    galleries: [],
    related: [],
    ask: null,
    plan: [],
    clarify: undefined,
    wrappingUp: false,
    startedAt: Date.now(),
    endedAt: null,
    mode,
    mode0: mode,
    stages: [],
    gaps: [],
    decisions: [],
    sections: {},
    artifacts: {},
    browser: null,
  };
}
