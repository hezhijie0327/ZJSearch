// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { LucideIcon } from "lucide-react";
import { AlignLeft, Check, ChevronDown, CircleAlert, ListTree, LoaderCircle, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { RailHeader } from "@/features/results/aiSearch/rail/RailSection.tsx";
import {
  type ReportTemplate,
  TEMPLATE_SHAPE_ICONS,
  type TemplateShape,
  templatePresets,
} from "@/features/results/aiSearch/reportTemplates.ts";
import type { AiSearchOutline } from "@/features/results/aiSearch/runModel.ts";
import { themeLocaleTag, useLocale, useT } from "@/lib/i18n.ts";
import { listTemplates } from "@/lib/kb/templates.ts";
import { CHIP_GHOST } from "@/lib/styles.ts";
import { flashToast } from "@/lib/toast.ts";

/** Collapsed run-title preview: three lines of text-3xl/leading-tight
    (30px × 1.25 ≈ 37.5px).  Matches the boot ghost's `line-clamp-3` and the
    static skeleton's `.zjs-boot-ai-title` clamp so the handover never
    shifts; deep-research briefs pasted as prompts read as a preview +
    expand chip instead of wall-to-wall 30px text. */

type StructurePick =
  | { kind: "direct" }
  | { kind: "free"; shape: TemplateShape }
  | { kind: "template"; template: ReportTemplate };

/** The run header's delete control (hover-revealed trash; TWO-STEP like
    every destructive control here -- the first click arms a danger pill,
    the second (or the cancel) resolves it; a 4s idle disarms).  The
    storage surgery lives in deleteRunData -- this is the confirmation
    surface only. */
export function RunDeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const t = useT();
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (!arming) {
      return;
    }
    const timer = window.setTimeout(() => {
      setArming(false);
    }, 4000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [arming]);
  if (arming) {
    // the arming swap is a SANCTIONED instant swap (a two-step danger
    // state machine, not a disclosure -- the armed pill's color IS the
    // announcement, an exit animation would delay the dangerous action)
    return (
      <span className="flex shrink-0 items-center gap-1">
        <button
          className="inline-flex items-center gap-1 rounded-full bg-danger px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-danger/85"
          onClick={() => {
            setArming(false);
            onConfirm();
          }}
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
          {t("run_delete_confirm")}
        </button>
        <button
          aria-label={t("ai_delete_cancel")}
          className="grid size-7 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          onClick={() => {
            setArming(false);
          }}
          title={t("ai_delete_cancel")}
          type="button"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </span>
    );
  }
  return (
    <button
      aria-label={t("run_delete")}
      className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 transition-all hover:bg-surface-2 hover:text-danger focus-visible:opacity-100 group-hover/run:opacity-100"
      onClick={() => {
        setArming(true);
      }}
      title={t("run_delete")}
      type="button"
    >
      <Trash2 aria-hidden="true" className="size-3.5" />
    </button>
  );
}

/** The rail's output-structure control (RESEARCH phase only, every tier):
    the run-time pick rides run/control to the write boundary -- the
    write-boundary shape resolver re-mints or mints the outline from it
    before the first section streams.  ONE MERGED LIST: the two free
    options (smart report / smart deck, pinned top, each wearing its
    shape icon) lead, then every preset and user template -- report and
    deck side by side, the locked FileText|Presentation icons are the
    only shape signal (no category filter).  EVERYTHING IS TWO-STEP:
    clicking an option only PREVIEWS (the trigger + section rows mirror
    it, nothing is sent -- users clicking around to look must never fire
    a control); the explicit confirm-switch pill submits, and a pick
    whose shape differs from the run's also flips the output format (the
    server pairs the pending shape with a canonical steer notice, so the
    researcher's remaining rounds adapt).  Picking a free option
    withdraws a previously-picked template (run/control action=template
    without a payload).  THE DIRECT-ANSWER ROW is pinned first: the run's
    birth format and the face of a run that carries no shape yet -- the
    current format is always the highlighted selection, any other pick
    counts as a flip, and confirming the direct row takes the run BACK to
    a plain answer (the server withdraws every pending deliverable
    signal -- on EVERY run: a route outline dies with the intent exactly
    like the model's minted flip).  ``shape`` is the run's CURRENT
    shape -- null on a run that has none yet.  The model's own
    set_deliverable flip adopts the submitted face ONLY while the reader
    picked nothing.  The pick window closes when the WRITER takes
    over -- the outline lands (the card swaps to the active-structure
    view) or the write phase opens without one (the single-write
    fallback; both swap to the fixed identity). */
export function OutputStructureCard({
  onPick,
  onClearTemplate,
  onSetShape,
  shape,
}: {
  onPick: (template: ReportTemplate) => Promise<boolean>;
  onClearTemplate: () => Promise<boolean>;
  onSetShape?: (shape: TemplateShape | null) => Promise<boolean>;
  shape: TemplateShape | null;
}) {
  const t = useT();
  const locale = useLocale();
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  // the SUBMITTED pick's id ("direct", free:<shape> or a template id) --
  // the direct answer is every run's birth format
  const [current, setCurrent] = useState(() => (shape ? `free:${shape}` : "direct"));
  // the reader's OWN direct submit happened ("direct" doubles as the
  // never-picked face, so the model's late flip must not overwrite it)
  const [directPicked, setDirectPicked] = useState(false);
  const [open, setOpen] = useState(false);
  // the PREVIEW pick (unconfirmed) and the submitted shape flip (drives
  // the submitted note -- only a shape flip steers the researcher)
  const [chosen, setChosen] = useState<StructurePick | null>(null);
  const [flipped, setFlipped] = useState<TemplateShape | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listTemplates().then((rows) => {
      if (!cancelled) {
        setTemplates(rows);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // the model's own set_deliverable flip folds run.mode -- adopt it as
  // the submitted face ONLY while the reader has picked nothing (an
  // explicit reader pick outranks the model's flip at the write boundary,
  // and the card must keep telling that truth)
  useEffect(() => {
    setCurrent((prev) => (prev === "direct" && !directPicked && shape ? `free:${shape}` : prev));
  }, [shape, directPicked]);
  const all: ReportTemplate[] = [...templatePresets(themeLocaleTag(locale)), ...templates];
  const options: Array<{
    id: string;
    label: string;
    sub: string;
    count: number;
    icon: LucideIcon;
  }> = [
    {
      id: "direct",
      label: t("ai_output_structure_direct"),
      sub: t("ai_output_structure_direct_sub"),
      count: 0,
      icon: AlignLeft,
    },
    {
      id: "free:report",
      label: t("report_template_free"),
      sub: t("ai_output_structure_free"),
      count: 0,
      icon: TEMPLATE_SHAPE_ICONS.report,
    },
    {
      id: "free:deck",
      label: t("template_free_deck"),
      sub: t("template_deck_hint"),
      count: 0,
      icon: TEMPLATE_SHAPE_ICONS.deck,
    },
    ...all.map((template) => ({
      id: template.id,
      label: template.name,
      sub: template.sections.map((section) => section.title).join(" / "),
      count: template.sections.length,
      icon: TEMPLATE_SHAPE_ICONS[template.shape ?? "report"],
    })),
  ];
  const pickId = (pick: StructurePick): string =>
    pick.kind === "direct" ? "direct" : pick.kind === "free" ? `free:${pick.shape}` : pick.template.id;
  const pickOf = (id: string): StructurePick | null => {
    if (id === "direct") {
      return { kind: "direct" };
    }
    if (id.startsWith("free:")) {
      return { kind: "free", shape: id === "free:deck" ? "deck" : "report" };
    }
    const template = all.find((item) => item.id === id);
    return template ? { kind: "template", template } : null;
  };
  const submitted = pickOf(current);
  const shown = chosen ?? submitted;
  const shownOption = options.find((option) => option.id === (shown ? pickId(shown) : current));
  const effective: TemplateShape | null = flipped ?? shape;
  const previewing = chosen !== null && (!submitted || pickId(chosen) !== pickId(submitted));
  const confirm = () => {
    if (!chosen) {
      return;
    }
    const nextId = pickId(chosen);
    if (submitted && nextId === pickId(submitted)) {
      setChosen(null);
      return;
    }
    if (chosen.kind === "direct") {
      // the back-to-the-direct-answer pick: every pending deliverable
      // signal withdraws server-side (template + shape + the model's
      // minted flip -- a route outline included).  A failed call (the
      // transport, never the server's verdict now) reverts the face.
      const prevId = current;
      const prevFlipped = flipped;
      setDirectPicked(true);
      setCurrent("direct");
      setFlipped(null);
      setChosen(null);
      setOpen(false);
      if (onSetShape) {
        void onSetShape(null).then((ok) => {
          if (!ok) {
            setCurrent(prevId);
            setFlipped(prevFlipped);
            flashToast(t("ai_steer_failed"), { tone: "danger" });
          }
        });
      }
      return;
    }
    const shapeChanged =
      effective === null ||
      (chosen.kind === "free" ? chosen.shape !== effective : (chosen.template.shape ?? "report") !== effective);
    if (chosen.kind === "free") {
      // a free option withdraws any picked template (harmless no-op when
      // none was pending)
      void onClearTemplate();
    } else {
      void onPick(chosen.template);
    }
    if (shapeChanged && onSetShape) {
      setFlipped(chosen.kind === "free" ? chosen.shape : (chosen.template.shape ?? "report"));
      void onSetShape(chosen.kind === "free" ? chosen.shape : (chosen.template.shape ?? "report"));
    }
    setCurrent(nextId);
    setChosen(null);
    setOpen(false);
  };
  const choose = (id: string) => {
    // clicking the submitted option cancels the preview; anything else
    // only PREVIEWS -- the confirm pill is the one send button
    const pick = pickOf(id);
    setChosen(pick && (!submitted || pickId(pick) !== pickId(submitted)) ? pick : null);
    setOpen(false);
  };
  return (
    <section aria-label={t("ai_output_structure")} className="mb-5">
      <RailHeader icon={ListTree} title={t("ai_output_structure")} />
      <div className="relative mt-3">
        <button
          aria-expanded={open}
          aria-haspopup="listbox"
          className="flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-start transition-colors hover:bg-surface-2/40"
          onClick={() => {
            setOpen((value) => !value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          type="button"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-ink">
              <span className="me-1.5 inline-flex items-center align-[-3px] text-ink-3">
                {shownOption ? <shownOption.icon aria-hidden="true" className="size-3.5" /> : null}
              </span>
              {shownOption?.label}
            </span>
            <span className="mt-0.5 block truncate text-xs text-ink-3">{shownOption?.sub}</span>
          </span>
          {shownOption && shownOption.count > 0 ? (
            <span className="shrink-0 text-xs tabular-nums text-ink-3">
              {shownOption.count} {t("knowledge_tab_sections")}
            </span>
          ) : null}
          <ChevronDown
            aria-hidden="true"
            className={`size-3.5 shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {/* the ONE send button: visible while a preview is pending (it
            fades in like every conditional surface) */}
        {previewing ? (
          <div className="mt-1.5 flex animate-fade-in items-center gap-2">
            <button
              className="inline-flex items-center gap-1 rounded-full bg-accent-strong px-3 py-1.5 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
              onClick={confirm}
              type="button"
            >
              <Check aria-hidden="true" className="size-3.5" />
              {t("template_shape_confirm", { name: shownOption?.label ?? "" })}
            </button>
            <button
              className={CHIP_GHOST}
              onClick={() => {
                setChosen(null);
              }}
              type="button"
            >
              {t("ai_delete_cancel")}
            </button>
          </div>
        ) : flipped !== null && flipped !== shape ? (
          <p className="mt-1.5 text-xs text-ink-3">{t("template_shape_pending")}</p>
        ) : null}
        {!open && (chosen?.kind === "template" || (!chosen && submitted?.kind === "template")) ? (
          <ol className="mt-2 space-y-1 px-1">
            {(chosen?.kind === "template"
              ? chosen.template
              : submitted?.kind === "template"
                ? submitted.template
                : undefined
            )?.sections.map((section, index) => (
              <li className="flex items-start gap-2 text-[13px]" key={`${index}-${section.title}`}>
                <span className="w-3 shrink-0 pt-0.5 text-center font-mono text-xs tabular-nums text-ink-3">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 leading-relaxed text-ink">{section.title}</span>
                {section.optional ? (
                  <span className="shrink-0 text-xs text-ink-3">{t("template_optional_short")}</span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        {open ? (
          <div
            aria-label={t("ai_output_structure")}
            className="absolute inset-x-0 top-full z-20 mt-1.5 max-h-72 animate-fade-in space-y-1 overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-pop"
            role="listbox"
          >
            {options.map((option) => {
              const isSelected = option.id === (shown ? pickId(shown) : current);
              return (
                <button
                  aria-selected={isSelected}
                  className={`w-full rounded-md px-2.5 py-2 text-start transition-colors ${
                    isSelected ? "border border-accent-strong bg-accent-soft" : "hover:bg-surface-2/40"
                  }`}
                  key={option.id}
                  onClick={() => {
                    choose(option.id);
                  }}
                  role="option"
                  type="button"
                >
                  <span
                    className={`flex items-center justify-between gap-2 text-[13px] ${
                      isSelected ? "font-medium text-accent" : "text-ink"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 text-ink-3">
                        <option.icon aria-hidden="true" className="size-3.5" />
                      </span>
                      <span className="min-w-0 truncate">{option.label}</span>
                    </span>
                    {option.count > 0 ? (
                      <span className="shrink-0 text-xs font-normal tabular-nums text-ink-3">
                        {option.count} {t("knowledge_tab_sections")}
                      </span>
                    ) : null}
                  </span>
                  <span className={`mt-0.5 block truncate text-xs ${isSelected ? "text-accent/70" : "text-ink-3"}`}>
                    {option.sub}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The structure's FIXED identity face -- icon + what this run's output
    structure IS (the template's own name, the free smart-report/smart-deck
    shape, or the direct answer a plain run kept) with its one-line
    description.  Non-interactive by design: the pick lane is consumed
    ONCE at the write boundary, so a structure change past it is a new
    run, not a hidden control.  Shared by the active card (outline
    landed) and the no-outline record -- the card NEVER vanishes once the
    writer has taken over or the run settled. */
function StructureFace({ deck, direct, templateName }: { deck: boolean; direct?: boolean; templateName?: string }) {
  const t = useT();
  const Icon = direct ? AlignLeft : deck ? TEMPLATE_SHAPE_ICONS.deck : TEMPLATE_SHAPE_ICONS.report;
  const label = direct
    ? t("ai_output_structure_direct")
    : (templateName ?? (deck ? t("template_free_deck") : t("report_template_free")));
  const sub = direct
    ? t("ai_output_structure_direct_sub")
    : templateName
      ? t("template_fixed_sub")
      : deck
        ? t("template_deck_hint")
        : t("ai_output_structure_free");
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2">
      <span className="shrink-0 text-ink-3">
        <Icon aria-hidden="true" className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{label}</span>
        <span className="mt-0.5 block truncate text-xs text-ink-3">{sub}</span>
      </span>
    </div>
  );
}

/** The rail's output-structure card AFTER the outline landed -- the run's ACTIVE
    structure: the fixed identity face (what it is) over the numbered
    rows (what it looks like), living through the write phase (per-
    section status marks) and the settled record alike.  READ-ONLY by
    design: the template pick lane is consumed ONCE at the write
    boundary, so a post-outline pick could only re-mint nothing -- a
    structure change past that point is a new run, not a hidden control.
    The one exception is a FAILED section's row: its rewrite chip is the
    repair affordance (the section re-streams through the run host's
    rewrite lane), not a structure change. */
export function ActiveStructureCard({ deck, outline }: { deck: boolean; outline: AiSearchOutline }) {
  const t = useT();
  if (outline.sections.length === 0) {
    return null;
  }
  return (
    <section aria-label={t("ai_output_structure")} className="mb-5">
      <RailHeader count={outline.sections.length} icon={ListTree} title={t("ai_output_structure")} />
      <div className="mt-3">
        <StructureFace deck={deck} templateName={outline.template} />
      </div>
      <ol className="mt-2 space-y-1 px-1">
        {outline.sections.map((section, index) => {
          return (
            <li className="flex items-start gap-2 text-[13px]" key={section.id || index}>
              <span className="w-3 shrink-0 pt-0.5 text-center font-mono text-xs tabular-nums text-ink-3">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 leading-relaxed text-ink" dir="auto">
                {section.title}
              </span>
              <span className="grid w-3.5 shrink-0 place-items-center pt-0.5">
                {section.status === "done" ? (
                  <Check aria-hidden="true" className="size-3 text-ok" />
                ) : section.status === "writing" ? (
                  <LoaderCircle aria-hidden="true" className="size-3 animate-spin text-accent" />
                ) : section.status === "failed" ? (
                  <CircleAlert aria-hidden="true" className="size-3 text-warning" />
                ) : (
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-line" />
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The rail's output-structure card for a run WITHOUT a minted skeleton:
    a report/deck run whose writer answered WITHOUT one (the outline gate
    fell back to the single write), an interrupted research -- and the
    PLAIN run's own settled record (``direct``: the run kept its birth
    format, the face says so).  While the run still researches (or awaits
    clarify) the PICKER occupies this slot instead; the write phase swaps
    to this fixed face. */
export function StructureIdentityCard({ deck, direct }: { deck: boolean; direct?: boolean }) {
  const t = useT();
  return (
    <section aria-label={t("ai_output_structure")} className="mb-5">
      <RailHeader icon={ListTree} title={t("ai_output_structure")} />
      <div className="mt-3">
        <StructureFace deck={deck} direct={direct} />
      </div>
    </section>
  );
}
