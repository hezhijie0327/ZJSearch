import { Check, Compass, MessageCircleQuestion } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";
import { createPortal } from "react-dom";
import { Tape } from "@/components/Tape.tsx";
import { parseClarifyPairs } from "@/features/results/aiSearch/ledger.ts";
import { RailHeader } from "@/features/results/aiSearch/rail/RailSection.tsx";
import type { AiAskQuestion, AiSearchRun } from "@/features/results/aiSearch/useAiSearch.ts";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { useT } from "@/lib/i18n.ts";
import { CHIP_OUTLINE, CHIP_OUTLINE_ACTIVE, CHIP_OUTLINE_IDLE, PAPER_STRIP } from "@/lib/styles.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";

/** Collapsed run-title preview: three lines of text-3xl/leading-tight
    (30px × 1.25 ≈ 37.5px).  Matches the boot ghost's `line-clamp-3` and the
    static skeleton's `.zjs-boot-ai-title` clamp so the handover never
    shifts; deep-research briefs pasted as prompts read as a preview +
    expand chip instead of wall-to-wall 30px text. */

function AskCard({
  ask,
  onSubmit,
}: {
  ask: { intro: string; questions: AiAskQuestion[] };
  onSubmit: (text: string | null) => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [note, setNote] = useState("");
  // the run BLOCKS on this card: full modal semantics -- focus moves to
  // the card on mount (tabIndex -1), Tab is trapped, focus returns to the
  // page on answer; Escape is handled by the portal wrapper (skip)
  const dialogRef = useDialogFocus<HTMLDivElement>();
  // Escape means skip: the run proceeds on the user's best interpretation
  const onCardKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      onSubmit(null);
    }
  };
  const toggle = (qi: number, option: string, type: "single" | "multi") => {
    setPicked((prev) => {
      const current = prev[qi] ?? [];
      const next =
        type === "single"
          ? current.includes(option)
            ? []
            : [option]
          : current.includes(option)
            ? current.filter((o) => o !== option)
            : [...current, option];
      return { ...prev, [qi]: next };
    });
  };
  const submit = () => {
    // the transcript travels to the model AND is replayed in the
    // ClarifySegment -- the punctuation comes from the catalog so an
    // English session reads as English (full-width marks in zh-CN)
    const join = t("ai_clarify_options_join");
    const lines = ask.questions.map((q, i) =>
      t("ai_clarify_answer_line", {
        n: String(i + 1),
        q: q.q,
        a: (picked[i] ?? []).join(join) || t("ai_clarify_none"),
      }),
    );
    if (note.trim()) {
      lines.push(t("ai_clarify_more_line", { label: t("ai_clarify_more"), text: note.trim() }));
    }
    // confirmed with NOTHING picked and nothing typed: the "answers" would
    // reach the model as a string of "—" placeholders -- degrade to the
    // skip path (research without a clarified direction) instead
    const hasInput = ask.questions.some((_, qi) => (picked[qi] ?? []).length > 0) || note.trim().length > 0;
    onSubmit(hasInput ? lines.join("\n") : null);
  };
  return (
    // The gate rides the family notice-paper ground (DESIGN.md §7): a BLANK
    // torn slip (no ruled lines — the question rows scroll, fixed lines
    // would drift under moving text) pinned by two tape corners, with the
    // deterministic micro-tilt of the PaperEmpty family.  The tapes are
    // SIBLINGS of the clipped note (§7 physics) and the dialog semantics
    // (role/ref/focus trap) stay on the note itself.
    <div className="relative w-full -rotate-[0.35deg]">
      <Tape className="w-24 bg-accent-soft/80" corner="start" seed="clarify-gate-a" />
      <Tape className="w-20 bg-accent-soft/60" corner="end" seed="clarify-gate-b" />
      <div
        aria-label={t("ai_clarify_title")}
        aria-modal="true"
        className="paper-note--blank flex max-h-full min-h-0 w-full flex-col overflow-hidden p-4"
        onKeyDown={onCardKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex shrink-0 items-center gap-2">
          <Compass aria-hidden="true" className="size-5 shrink-0 text-ink-3" />
          <h3 className="text-lg font-semibold text-ink">{t("ai_clarify_title")}</h3>
        </div>
        {ask.intro ? (
          <p className="mt-2 shrink-0 text-sm leading-relaxed text-ink-2" dir="auto">
            {ask.intro}
          </p>
        ) : null}
        <div className="mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto">
          {ask.questions.map((question, qi) => (
            <div key={qi}>
              <p className="text-[13px] font-medium text-ink" dir="auto">
                {question.q}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {question.options.map((option) => {
                  const on = (picked[qi] ?? []).includes(option);
                  return (
                    <button
                      aria-pressed={on}
                      className={`${CHIP_OUTLINE} ${on ? CHIP_OUTLINE_ACTIVE : CHIP_OUTLINE_IDLE}`}
                      key={option}
                      onClick={() => {
                        toggle(qi, option, question.type);
                      }}
                      type="button"
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <input
          aria-label={t("ai_clarify_more")}
          className="mt-3 h-9 w-full shrink-0 rounded-lg border border-line bg-transparent px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent"
          dir="auto"
          onChange={(event) => {
            setNote(event.target.value);
          }}
          placeholder={t("ai_clarify_more")}
          value={note}
        />
        <div className="mt-3 flex shrink-0 items-center justify-between gap-2">
          <button
            className="text-[13px] text-ink-3 transition-colors hover:text-ink hover:underline underline-offset-2"
            onClick={() => {
              onSubmit(null);
            }}
            type="button"
          >
            {t("ai_clarify_skip")}
          </button>
          <button
            className={`${PAPER_STRIP} -rotate-1 px-4 py-1.5 text-accent-contrast [--strip:var(--accent-strong)] hover:[--strip:var(--accent-strong-hover)]`}
            onClick={submit}
            type="button"
          >
            {t("ai_clarify_confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The clarify gate's MOUNT: the exit-presence wrapper keeps the slip
    mounted for its -out animation once the answers travel (the dismiss
    doctrine -- a gate that fades in must not vanish in a pop), with
    `closing` short-circuiting the submit and inerting the card. */
export function ClarifyGate({
  ask,
  onSubmit,
  open,
}: {
  ask: AiSearchRun["ask"];
  onSubmit?: (text: string | null) => void;
  open: boolean;
}) {
  const { render, closing } = useExitPresence(open);
  if (!render || !ask) {
    return null;
  }
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        aria-hidden="true"
        className={`absolute inset-0 ${closing ? "animate-fade-out" : "animate-fade-in"} bg-black/30`}
      />
      <div
        className={`relative z-10 flex max-h-full w-full max-w-lg ${closing ? "animate-fade-out" : "animate-fade-up"}`}
        inert={closing}
      >
        <AskCard ask={ask} onSubmit={closing ? () => {} : (onSubmit ?? (() => {}))} />
      </div>
    </div>,
    document.body,
  );
}

/** The clarify round-trip archive (confirmed direction): the confirmed direction
    (or the skip) the research below is built on.  The SAME section
    language as every rail card -- icon + title + count header, one
    settled row per answered question (check + answer + the question in
    muted) -- newest first, capped at four. */
export function AskArchiveCard({ clarify }: { clarify: string }) {
  const t = useT();
  // the shared clarify grammar (ledger.parseClarifyPairs); a trailing
  // free-text note (no separator) parses as a label-less pair and renders
  // under its own label line
  const text = clarify.trim();
  if (!text) {
    return null;
  }
  const parsed = parseClarifyPairs(text);
  const items: Array<{ q: string; a: string }> = [...parsed];
  // the grammar's trailing label-less pair IS the free-text note
  const notePair = parsed.length > 0 ? parsed[parsed.length - 1] : undefined;
  if (notePair && notePair.q === "") {
    items.splice(items.length - 1, 1, { q: t("ai_clarify_more"), a: notePair.a });
  }
  const view = [...items].reverse().slice(0, 4);
  return (
    <section aria-label={t("ai_clarify_summary")} className="mb-5">
      <RailHeader count={items.length} icon={MessageCircleQuestion} title={t("ai_clarify_summary")} />
      {/* the confirmed direction pinned as a torn note (DESIGN.md §7): two
          tape corners as SIBLINGS of the clipped note (a child would be cut
          by the torn edge), the micro-tilt is fixed, never random */}
      <div className="relative mt-5 -rotate-[0.35deg]">
        <Tape className="w-16 bg-accent-soft/80" corner="start" seed={`${items[0]?.q ?? "archive"}-a`} />
        <Tape className="w-14 bg-accent-soft/60" corner="end" seed={`${items[0]?.q ?? "archive"}-b`} />
        <ul className="paper-note space-y-1.5 px-4 py-3">
          {view.map((item) => (
            <li className="flex items-start gap-2 text-[13px]" key={`${item.q}-${item.a}`}>
              <Check aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-ok" />
              <span className="min-w-0 flex-1 break-words">
                <span className="block text-ink-3" dir="auto">
                  {item.q}
                </span>
                <span className="block text-ink" dir="auto">
                  {item.a}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
