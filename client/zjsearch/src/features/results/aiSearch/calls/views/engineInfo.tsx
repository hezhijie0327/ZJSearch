// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { DatabaseSearch } from "lucide-react";
import { CAP_CHIP_CLASS, CapChip } from "@/components/CapChip.tsx";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";
import type { AiEngineInventory } from "@/features/results/aiSearch/timeline.ts";
import { useT } from "@/lib/i18n.ts";
import { useCapExpand } from "@/lib/useCapExpand.ts";

const BANG_CELLS_CAP = 8;

/** The engine_info view: the row's expansion renders the STRUCTURED
    deployment listing as two calm DIRECTORY BOARDS -- a uniform category
    grid (name + right-aligned engine count, heaviest verticals first)
    and a held-back-engines grid (name over its bang + categories, one
    cell each, cap-and-expand).  No chip cloud, no ragged rows.  The
    summary line carries the totals; pre-inventory replays keep the
    plain-text reading-pane fallback. */
export const engineInfoView: ToolView = {
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
  const shown = bangs.expanded ? inv.disabled : inv.disabled.slice(0, BANG_CELLS_CAP);
  return (
    <div className="min-w-0">
      <p className="text-xs text-ink-3">
        {t("ai_engine_info_summary", { n: String(inv.total), m: String(categories.length) })}
      </p>
      <div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1">
        {categories.map((category) => (
          <div className={`flex items-baseline justify-between gap-2 ${CELL}`} key={category.name}>
            <span className="truncate text-xs text-ink-2">{category.name}</span>
            <span className="text-xs tabular-nums text-ink-3">{category.count}</span>
          </div>
        ))}
      </div>
      {inv.disabled.length > 0 ? (
        <>
          <p className="mt-2.5 text-xs text-ink-3">{t("ai_engine_info_bang", { n: String(inv.disabled.length) })}</p>
          <div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-1">
            {shown.map((engine) => (
              <div className={`${CELL} py-1.5`} key={engine.name} title={engine.cats.join(", ")}>
                <div className="truncate text-xs text-ink-2">{engine.name}</div>
                <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
                  <span className="shrink-0 font-mono text-xs text-ink-2">!{engine.bang}</span>
                  {engine.cats.length > 0 ? (
                    <span className="truncate text-[11px] text-ink-3">{engine.cats.join(", ")}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <CapChip className={CAP_CHIP_CLASS} expanded={bangs.expanded} hidden={bangs.hidden} onToggle={bangs.toggle} />
        </>
      ) : null}
    </div>
  );
}
