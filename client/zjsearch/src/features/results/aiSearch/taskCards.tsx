import { Check, ChevronDown, CircleAlert, ListTodo } from "lucide-react";
import { useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import { RailHeader } from "@/features/results/aiSearch/rail/RailSection.tsx";
import type { AiSearchRun } from "@/features/results/aiSearch/useAiSearch.ts";
import { Snippet } from "@/features/results/cardParts.tsx";
import { useT } from "@/lib/i18n.ts";
import { escapeHtml } from "@/lib/print.ts";

/** Collapsed run-title preview: three lines of text-3xl/leading-tight
    (30px × 1.25 ≈ 37.5px).  Matches the boot ghost's `line-clamp-3` and the
    static skeleton's `.zjs-boot-ai-title` clamp so the handover never
    shifts; deep-research briefs pasted as prompts read as a preview +
    expand chip instead of wall-to-wall 30px text. */

export function TaskCard({
  plan,
  live,
  onCiteN,
}: {
  plan: AiSearchRun["plan"];
  live: boolean;
  /** the citation-locate chain (chips -> expand -> scroll + flash) for a
      subtask's own source list */
  onCiteN?: (n: number) => void;
}) {
  const t = useT();
  if (plan.length === 0) {
    return null;
  }
  const done = plan.filter((task) => task.status === "done").length;
  return (
    <div className="mb-5">
      <RailHeader count={`${done}/${plan.length}`} icon={ListTodo} title={t("ai_task_card")} />
      <ul className="mt-3 space-y-1.5">
        {plan.map((task, index) => (
          <TaskItem key={`${index}-${task.title}`} live={live} onCiteN={onCiteN} task={task} />
        ))}
      </ul>
    </div>
  );
}

/** The BELIEF LEDGER card (Findings): active facts carry the accent dot,
    superseded facts stay visible (retired, struck) and retracted ones
    drop their claim (struck, warning) -- the revision history IS the
    honesty.  Each fact renders through the SAME measured clamp+expand as
    a source card's snippet, with inline [n] marks as accent chip buttons
    that locate the source in the rail.  The list reads NEWEST-FIRST and
    caps at four entries (one chip unfolds both the facts and the gaps
    partition); open gaps render under the facts: an OPEN gap is a
    colored dot (an owed question, not an achievement), a closed one
    settles as a check + its answer. */

function TaskItem({
  task,
  live,
  onCiteN,
}: {
  task: AiSearchRun["plan"][number];
  live: boolean;
  onCiteN?: (n: number) => void;
}) {
  const t = useT();
  // the subtask's own source list: the count chip toggles an inline
  // [n] chip row -- each chip rides the citation-locate chain (expand +
  // scroll + flash on the source card)
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const sourceCount = task.sources?.length ?? 0;
  return (
    <li>
      <div className="flex items-start gap-2 text-[13px]">
        <span className="sr-only">
          {t(
            task.status === "done"
              ? "ai_task_status_done"
              : task.status === "active"
                ? "ai_task_status_active"
                : task.status === "missed"
                  ? "ai_task_status_missed"
                  : "ai_task_status_pending",
          )}
        </span>
        <span className="relative mt-0.5 flex size-3 shrink-0 items-center justify-center">
          {task.status === "done" ? (
            <Check aria-hidden="true" className="size-3 text-ok" />
          ) : task.status === "active" ? (
            <>
              {/* the ping animates ONLY while the run streams: a settled
                  run's never-finished subtask must not leave a permanent
                  animation on the page (the occluded-webview jam feeder) */}
              {live ? (
                <span aria-hidden="true" className="absolute size-3 animate-ping rounded-full bg-accent/40" />
              ) : null}
              <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
            </>
          ) : task.status === "missed" ? (
            <CircleAlert aria-hidden="true" className="size-3 text-warning" />
          ) : (
            <span aria-hidden="true" className="size-1.5 rounded-full bg-ink-3/50" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <Snippet
            contentHtml={escapeHtml(task.title)}
            textClass={`text-[13px] leading-relaxed ${task.status === "done" ? "text-ink-3" : "text-ink"}`}
          />
          {task.status === "missed" ? (
            <span className="whitespace-nowrap text-xs text-warning">{t("ai_task_missed")}</span>
          ) : null}
        </div>
        {task.status === "done" && sourceCount > 0 ? (
          <button
            aria-expanded={sourcesOpen}
            className="flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-ink-3 transition-colors hover:text-accent"
            onClick={() => {
              setSourcesOpen(!sourcesOpen);
            }}
            type="button"
          >
            {t(sourceCount === 1 ? "ai_task_source_one" : "ai_task_sources", {
              n: String(sourceCount),
            })}
            <ChevronDown
              aria-hidden="true"
              className={`size-3 transition-transform ${sourcesOpen ? "rotate-180" : ""}`}
            />
          </button>
        ) : null}
      </div>
      <Collapse className={sourcesOpen && sourceCount > 0 ? "mt-1" : ""} open={sourcesOpen && sourceCount > 0}>
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 ps-5">
          {(task.sources ?? []).map((n) => (
            <button
              className="rounded-md border border-line bg-surface-2/50 px-1.5 py-px text-xs leading-4 text-ink-2 transition-colors hover:border-accent/50 hover:text-accent"
              key={n}
              onClick={() => {
                onCiteN?.(n);
              }}
              type="button"
            >
              #{n}
            </button>
          ))}
        </div>
      </Collapse>
    </li>
  );
}

/** One collapsible reasoning segment: the header carries the Brain icon,
    the label and the segment's streaming duration; the raw think stream
    stays inside.  Open while THIS segment is the one streaming (unless
    the user toggled), folded once later steps take over. */
