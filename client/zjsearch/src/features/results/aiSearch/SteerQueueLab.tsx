// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ArrowRight, RotateCcw } from "lucide-react";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { SteerChips } from "@/features/results/aiSearch/SteerChips.tsx";
import type { AiSearchState } from "@/features/results/aiSearch/useAiSearch.ts";
import { useAiSteer } from "@/features/results/aiSearch/useAiSteer.ts";
import { useT } from "@/lib/i18n.ts";

/** The steer queue's zero-token QA surface (the thread debug stage's
    bottom card): the REAL `useAiSteer` + REAL `SteerChips` over a SIMULATED
    run host -- queue semantics mirror `host.ControlBox` exactly (FIFO,
    cap 3, multiset-validated reorder), so the drag order, the rank
    badges, the cap rejection and the settle retirement are all QA-able
    without a live run, a model call or a network.  "Drain at next
    boundary" is the round boundary: the head hits the timeline and the
    chip retires through the hook's own effect -- the delivery order the
    readout shows is the order the real host would deliver. */

/** mirrors host.py's MAX_PENDING_STEERS */
const QUEUE_CAP = 3;

type LabNote = "" | "full" | "stale";

export function SteerQueueLab() {
  const t = useT();
  const [phase, setPhase] = useState<"streaming" | "done">("streaming");
  /** the wire's steer steps: what the timeline received, in order */
  const [delivered, setDelivered] = useState<string[]>([]);
  /** the host queue's visible mirror (delivery order) */
  const [queueView, setQueueView] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<LabNote>("");
  // the simulated ControlBox._steers (string-only: the lab never sends meta)
  const hostQueue = useRef<string[]>([]);

  // the stub the hook sees: only `phase`, `runs[].steps` and the two
  // control calls are read (useAiSteer's contract) -- memoized on the
  // changing inputs so the hook's retirement effect does not re-run on
  // every render
  const host = useMemo(
    () =>
      ({
        phase,
        runs: [{ steps: delivered.map((text) => ({ kind: "steer", text })) }],
        steer: async (text: string) => {
          if (hostQueue.current.length >= QUEUE_CAP) {
            setNote("full");
            return false;
          }
          hostQueue.current.push(text.trim());
          setQueueView([...hostQueue.current]);
          setNote("");
          return true;
        },
        reorderSteer: async (texts: string[]) => {
          const current = hostQueue.current;
          if (
            texts.length !== current.length ||
            [...texts].sort().join("\u0000") !== [...current].sort().join("\u0000")
          ) {
            setNote("stale");
            return false;
          }
          hostQueue.current = texts;
          setQueueView([...texts]);
          setNote("");
          return true;
        },
      }) as unknown as AiSearchState,
    [delivered, phase],
  );
  const steer = useAiSteer(host);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value) {
      return;
    }
    steer.send(value);
    setDraft("");
  };

  /** the round boundary: the head of the host queue reaches the timeline */
  const boundary = () => {
    const head = hostQueue.current.shift();
    if (head === undefined) {
      return;
    }
    setQueueView([...hostQueue.current]);
    setDelivered((prev) => [...prev, head]);
  };

  const reset = () => {
    hostQueue.current = [];
    setQueueView([]);
    setDelivered([]);
    setPhase("streaming");
    setDraft("");
    setNote("");
  };

  return (
    <section className="mt-6 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">{t("ai_debug_steer_lab")}</span>
        <span className="ms-auto flex flex-wrap items-center gap-1.5">
          <button
            className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-1 text-[13px] text-ink-2 transition-colors hover:text-ink"
            onClick={boundary}
            type="button"
          >
            <ArrowRight aria-hidden="true" className="size-3.5" />
            {t("ai_debug_steer_boundary")}
          </button>
          <button
            className="rounded-full border border-line px-3 py-1 text-[13px] text-ink-2 transition-colors hover:text-ink"
            disabled={phase === "done"}
            onClick={() => {
              // the real host's box dies with the run: the pending queue
              // goes with it (only the delivered record stays)
              hostQueue.current = [];
              setQueueView([]);
              setPhase("done");
            }}
            type="button"
          >
            {t("ai_debug_steer_settle")}
          </button>
          <button
            aria-label={t("ai_debug_steer_reset")}
            className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            onClick={reset}
            title={t("ai_debug_steer_reset")}
            type="button"
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      </div>
      <form className="mt-3 flex items-center gap-2" onSubmit={send}>
        <input
          aria-label={t("ai_debug_steer_add")}
          className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          placeholder={t("ai_debug_steer_add")}
          value={draft}
        />
      </form>
      <SteerChips chips={steer.chips} onReorder={steer.reorder} onRetract={steer.retract} />
      {note ? (
        <p className="mt-1 text-xs text-danger">
          {t(note === "full" ? "ai_debug_steer_full" : "ai_debug_steer_stale")}
        </p>
      ) : null}
      <p className="mt-3 break-words text-xs text-ink-3" dir="auto">
        {t("ai_debug_steer_host")}:{" "}
        <span className="font-mono text-ink-2">
          {queueView.length ? queueView.map((text, i) => `[${i + 1}] ${text}`).join("  ·  ") : "—"}
        </span>
      </p>
      {delivered.length ? (
        <p className="mt-1 break-words text-xs text-ink-3" dir="auto">
          {t("ai_debug_steer_delivered")}:{" "}
          <span className="font-mono text-ink-2">{delivered.map((text, i) => `[${i + 1}] ${text}`).join("  ·  ")}</span>
        </p>
      ) : null}
    </section>
  );
}
