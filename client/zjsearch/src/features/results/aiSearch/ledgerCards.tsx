// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Check, CircleAlert, CircleHelp, NotebookPen, Swords } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { CAP_CHIP_CLASS, CapChip } from "@/components/CapChip.tsx";
import { Collapse } from "@/components/Collapse.tsx";
import type { LedgerFact, LedgerGap } from "@/features/results/aiSearch/ledger.ts";
import { RailHeader } from "@/features/results/aiSearch/rail/RailSection.tsx";
import { Snippet } from "@/features/results/cardParts.tsx";
import { useT } from "@/lib/i18n.ts";
import { inlineMdHtml } from "@/lib/markdownParts.ts";
import { CHIP } from "@/lib/styles.ts";

/** Collapsed run-title preview: three lines of text-3xl/leading-tight
    (30px × 1.25 ≈ 37.5px).  Matches the boot ghost's `line-clamp-3` and the
    static skeleton's `.zjs-boot-ai-title` clamp so the handover never
    shifts; deep-research briefs pasted as prompts read as a preview +
    expand chip instead of wall-to-wall 30px text. */

function factHtml(text: string): string {
  return inlineMdHtml(text).replace(/\[(\d{1,3})\]/g, (_mark, n: string) => {
    const num = Number(n);
    if (!(num > 0)) {
      return `[${n}]`;
    }
    return (
      `<button type="button" data-cite-n="${num}" title="Source [${num}]"` +
      ` class="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-accent-soft px-1 align-baseline text-xs font-medium leading-4 text-accent transition-colors hover:text-accent-hover">[${num}]</button>`
    );
  });
}

/** One fact's meta tail: a retracted/superseded fact's status label, an
    active fact's CONFLICT FLAG as a warning chip with visible text (the
    old icon-only badge hid its meaning behind a hover tooltip), then the
    fact's concept tags (the findings tool's tags field) — one wrapping
    meta row at the 12px chip tier, identical in both list partitions. */
function FactMeta({ fact }: { fact: LedgerFact }) {
  const t = useT();
  const conflict = fact.status === "active" && fact.conflict_with != null;
  return (
    <>
      {fact.status !== "active" ? (
        <span className="ms-1.5 whitespace-nowrap text-xs text-ink-3">
          {fact.status === "retracted" ? t("ai_finding_retracted") : t("ai_finding_superseded")}
        </span>
      ) : null}
      {conflict || fact.tags?.length ? (
        <span className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink-3">
          {conflict ? (
            <span className={`${CHIP} bg-warning/10 font-medium text-warning`}>
              <Swords aria-hidden="true" className="size-3" />
              {t("ai_finding_conflict")}
            </span>
          ) : null}
          {fact.tags?.map((tag) => (
            <span className={CHIP} key={tag}>
              {tag}
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}

/** One gap's snippet html: the question, and a CLOSED gap's settlement as
    a muted tail -- both with the same [n] chip rendering as a fact. */
function gapHtml(gap: LedgerGap): string {
  const tail =
    gap.status === "closed" && gap.close_as ? ` <span class="text-ink-3">${factHtml(gap.close_as)}</span>` : "";
  return factHtml(gap.q) + tail;
}

/** The [n]-chip click delegation shared by every ledger row (the chips
    live INSIDE the snippet html, so the wrapper catches them). */
function citeHandlers(onCiteN: (n: number) => void) {
  const locate = (event: { target: EventTarget | null }) => {
    const chip = (event.target as HTMLElement).closest("[data-cite-n]");
    if (chip) {
      onCiteN(Number(chip.getAttribute("data-cite-n")));
    }
  };
  return {
    onClick: locate,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter") {
        locate(event);
      }
    },
  };
}

/** The BELIEF LEDGER card (Findings): what the sources ESTABLISHED --
    active facts carry the accent dot, superseded stay struck, retracted
    ones drop their claim; each fact renders through the SAME measured
    clamp-and-reveal with inline [n] chip buttons, NEWEST-FIRST, capped
    at four. */
export function FindingsCard({
  findings,
  expanded,
  onToggleExpanded,
  onCiteN,
}: {
  findings: LedgerFact[];
  /** CONTROLLED cap state (a [n] click expands it; the chip may fold) */
  expanded: boolean;
  onToggleExpanded: (next: boolean) => void;
  onCiteN: (n: number) => void;
}) {
  const t = useT();
  if (findings.length === 0) {
    return null;
  }
  const active = findings.filter((fact) => fact.status === "active");
  const factsHidden = Math.max(0, findings.length - 4);
  // the newest four lead; the OLDER tail sits inside a Collapse so the
  // +N reveal (and the collapse) plays as a height animation
  const factView = [...findings.slice(-4)].reverse();
  const factExtra = [...findings.slice(0, Math.max(0, findings.length - 4))].reverse();
  return (
    <div className="mb-5">
      <RailHeader count={active.length} icon={NotebookPen} title={t("ai_findings_card")} />
      <ul className="mt-3 space-y-1.5">
        {factView.map((fact) => (
          <li className="flex items-start gap-2" key={fact.id}>
            {fact.status === "active" ? (
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent/70" />
            ) : fact.status === "retracted" ? (
              <CircleAlert aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-warning" />
            ) : (
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-3/40" />
            )}
            <div className="min-w-0 flex-1">
              <div {...citeHandlers(onCiteN)}>
                <Snippet
                  className={fact.status === "active" ? "" : "text-ink-3 line-through decoration-ink-3/60"}
                  contentHtml={factHtml(fact.text)}
                  textClass="text-[13px] leading-relaxed text-ink-2"
                />
              </div>
              <FactMeta fact={fact} />
            </div>
          </li>
        ))}
      </ul>
      <Collapse className={expanded && factExtra.length > 0 ? "mt-1.5" : ""} open={expanded && factExtra.length > 0}>
        <ul className="space-y-1.5">
          {factExtra.map((fact) => (
            <li className="flex items-start gap-2" key={fact.id}>
              {fact.status === "active" ? (
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent/70" />
              ) : fact.status === "retracted" ? (
                <CircleAlert aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-warning" />
              ) : (
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-3/40" />
              )}
              <div className="min-w-0 flex-1">
                <div {...citeHandlers(onCiteN)}>
                  <Snippet
                    className={fact.status === "active" ? "" : "text-ink-3 line-through decoration-ink-3/60"}
                    contentHtml={factHtml(fact.text)}
                    textClass="text-[13px] leading-relaxed text-ink-2"
                  />
                </div>
                <FactMeta fact={fact} />
              </div>
            </li>
          ))}
        </ul>
      </Collapse>
      <CapChip
        className={CAP_CHIP_CLASS}
        expanded={expanded}
        hidden={factsHidden}
        onToggle={() => {
          onToggleExpanded(!expanded);
        }}
      />
    </div>
  );
}

/** The OPEN QUESTIONS card (open gaps): the ledger's gap partition as its
    own section beside the findings -- an open gap is a colored dot (an
    owed question, not an achievement), a closed one settles as a check
    with its answer as a muted tail.  The SAME row machinery as a fact:
    [n] chip buttons + the measured clamp-and-reveal, newest first,
    capped at four; the header counts the CARD'S rows (the per-row dot /
    check already tells open from settled). */
export function GapsCard({
  gaps,
  expanded,
  onToggleExpanded,
  onCiteN,
  onFollowup,
}: {
  gaps: LedgerGap[];
  expanded: boolean;
  onToggleExpanded: (next: boolean) => void;
  onCiteN: (n: number) => void;
  /** the gap-driven follow-up: launch a research run on the open gaps
      (the host composes the message; absent on surfaces without a
      composer) */
  onFollowup?: (gaps: { q: string }[]) => void;
}) {
  const t = useT();
  if (gaps.length === 0) {
    return null;
  }
  const openGaps = gaps.filter((gap) => gap.status === "open" && gap.q);
  const gapsHidden = Math.max(0, gaps.length - 4);
  const gapView = [...gaps.slice(-4)].reverse();
  const gapExtra = [...gaps.slice(0, Math.max(0, gaps.length - 4))].reverse();
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <RailHeader count={gaps.length} icon={CircleHelp} title={t("ai_findings_gaps")} />
        </div>
        {onFollowup && openGaps.length > 0 ? (
          <button
            className={`shrink-0 rounded-full border border-accent-strong/40 bg-accent-soft px-2.5 py-1 text-[13px] font-medium text-accent transition-colors hover:text-accent-hover`}
            onClick={() => {
              onFollowup(openGaps.slice(-5).map((gap) => ({ q: gap.q })));
            }}
            title={t("ai_gaps_followup")}
            type="button"
          >
            {t("ai_gaps_followup")}
          </button>
        ) : null}
      </div>
      <ul className="mt-3 space-y-1.5">
        {gapView.map((gap) => (
          <li className="flex items-start gap-2" key={gap.id}>
            {gap.status === "open" ? (
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
            ) : (
              <Check aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-ok" />
            )}
            <div className="min-w-0 flex-1" {...citeHandlers(onCiteN)}>
              <Snippet
                contentHtml={gapHtml(gap)}
                textClass={`text-[13px] leading-relaxed ${gap.status === "open" ? "text-ink" : "text-ink-3"}`}
              />
            </div>
          </li>
        ))}
      </ul>
      <Collapse className={expanded && gapExtra.length > 0 ? "mt-1.5" : ""} open={expanded && gapExtra.length > 0}>
        <ul className="space-y-1.5">
          {gapExtra.map((gap) => (
            <li className="flex items-start gap-2" key={gap.id}>
              {gap.status === "open" ? (
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
              ) : (
                <Check aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-ok" />
              )}
              <div className="min-w-0 flex-1" {...citeHandlers(onCiteN)}>
                <Snippet
                  contentHtml={gapHtml(gap)}
                  textClass={`text-[13px] leading-relaxed ${gap.status === "open" ? "text-ink" : "text-ink-3"}`}
                />
              </div>
            </li>
          ))}
        </ul>
      </Collapse>
      <CapChip
        className={CAP_CHIP_CLASS}
        expanded={expanded}
        hidden={gapsHidden}
        onToggle={() => {
          onToggleExpanded(!expanded);
        }}
      />
    </div>
  );
}

/** One task row: the colored status mark + the subtask title (+ its source
    count once covered).  Not interactive -- the process lives in the
    research timeline. */
