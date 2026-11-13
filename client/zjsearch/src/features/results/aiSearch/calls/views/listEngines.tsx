// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { CircleDollarSign, DatabaseSearch } from "lucide-react";
import { CAP_CHIP_CLASS, CapChip } from "@/components/CapChip.tsx";
import { Collapse } from "@/components/Collapse.tsx";
import { DirectoryGrid } from "@/features/results/aiSearch/calls/bodyParts.tsx";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";
import type { AiEngineInventory } from "@/features/results/aiSearch/timeline.ts";
import { useT } from "@/lib/i18n.ts";
import { useCapExpand } from "@/lib/useCapExpand.ts";

const BANG_CELLS_CAP = 8;

/** The list_engines view: the row's expansion renders the STRUCTURED
    deployment listing as two calm DIRECTORY BOARDS -- a uniform category
    grid (name + right-aligned engine count, heaviest verticals first)
    and a held-back-engines grid (name over its bang + categories, one
    cell each, cap-and-expand).  No chip cloud, no ragged rows.  The
    summary line carries the totals; pre-inventory replays keep the
    plain-text reading-pane fallback. */
export const listEnginesView: ToolView = {
  Icon: DatabaseSearch,
  label: ({ t }) => t("ai_engine_info_row"),
  metric: ({ call, t }) =>
    call.status === "pending"
      ? t("ai_engine_info_running")
      : call.status === "ok"
        ? t("ai_engine_info_done", { n: String(call.n ?? 0) })
        : null,
  Content: ({ call }) => {
    const inv = call.inventory;
    if (!inv) {
      return null;
    }
    return <InventoryBody inv={inv} />;
  },
};

const CELL = "min-w-0 rounded-md bg-surface-2/60 px-2 py-1";

function InventoryBody({ inv }: { inv: AiEngineInventory }) {
  const t = useT();
  const categories = [...inv.categories].sort((a, b) => b.count - a.count);
  const bangs = useCapExpand(inv.disabled.length, BANG_CELLS_CAP);
  const shown = inv.disabled.slice(0, BANG_CELLS_CAP);
  const tail = inv.disabled.slice(BANG_CELLS_CAP);
  return (
    <div className="min-w-0">
      <p className="text-xs text-ink-3">
        {t("ai_engine_info_summary", { n: String(inv.total), m: String(categories.length) })}
      </p>
      <DirectoryGrid
        entries={categories.map((category) => ({ key: category.name, label: category.name, trailing: category.count }))}
      />
      {inv.disabled.length > 0 ? (
        <>
          <p className="mt-2.5 text-xs text-ink-3">{t("ai_engine_info_bang", { n: String(inv.disabled.length) })}</p>
          <div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-1">
            {shown.map((engine) => (
              <div
                className={`${CELL} py-1.5`}
                key={engine.name}
                title={engine.cats.join(", ") + (engine.paid ? ` · ${t("ai_engine_info_paid")}` : "")}
              >
                <div className="truncate text-xs text-ink-2">{engine.name}</div>
                <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
                  <span className="shrink-0 font-mono text-xs text-ink-2">!{engine.bang}</span>
                  {engine.cats.length > 0 ? (
                    <span className="truncate text-xs text-ink-3">{engine.cats.join(", ")}</span>
                  ) : null}
                  {engine.paid ? (
                    <CircleDollarSign
                      aria-label={t("ai_engine_info_paid")}
                      className="size-3 shrink-0 self-center text-accent"
                      role="img"
                    />
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          {/* the +N reveal is a HEIGHT animation (the rail's cap-and-expand
              contract) -- the tail rides one Collapse over its own grid (a
              0fr wrapper INSIDE the grid would leave an empty gap row) */}
          <Collapse className={bangs.expanded && tail.length > 0 ? "mt-1" : ""} open={bangs.expanded}>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-1">
              {tail.map((engine) => (
                <div
                  className={`${CELL} py-1.5`}
                  key={engine.name}
                  title={engine.cats.join(", ") + (engine.paid ? ` · ${t("ai_engine_info_paid")}` : "")}
                >
                  <div className="truncate text-xs text-ink-2">{engine.name}</div>
                  <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
                    <span className="shrink-0 font-mono text-xs text-ink-2">!{engine.bang}</span>
                    {engine.cats.length > 0 ? (
                      <span className="truncate text-xs text-ink-3">{engine.cats.join(", ")}</span>
                    ) : null}
                    {engine.paid ? (
                      <CircleDollarSign
                        aria-label={t("ai_engine_info_paid")}
                        className="size-3 shrink-0 self-center text-accent"
                        role="img"
                      />
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </Collapse>
          <CapChip className={CAP_CHIP_CLASS} expanded={bangs.expanded} hidden={bangs.hidden} onToggle={bangs.toggle} />
        </>
      ) : null}
    </div>
  );
}
