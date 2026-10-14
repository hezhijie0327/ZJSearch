// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { AlertTriangle, Check, Minus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Meter } from "@/components/Meter.tsx";
import { SortHeader } from "@/components/SortHeader.tsx";
import { engineGroupLabel } from "@/lib/categories.ts";
import { loadEngineDescriptions } from "@/lib/engineDescriptions.ts";
import { useT } from "@/lib/i18n.ts";
import { CODE_CHIP, reliabilityColor } from "@/lib/styles.ts";
import { type SortState, useSortState } from "@/lib/tableSort.ts";
import type { EngineEntry, PreferencesPageData } from "@/lib/types.ts";
import { EngineTooltip, Switch } from "@/pages/preferences/parts.tsx";

type EngineSortKey = "allow" | "name" | "safesearch" | "time_range" | "weight" | "time" | "timeout" | "reliability";

function sortValue(
  engine: EngineEntry,
  key: EngineSortKey,
  enabled: Record<string, boolean>,
  category: string,
): number | null {
  switch (key) {
    case "allow":
      return enabled[`${engine.name}__${category}`] ? 1 : 0;
    case "safesearch":
      return engine.supports_safesearch ? 1 : 0;
    case "time_range":
      return engine.supports_time_range ? 1 : 0;
    case "weight":
      return engine.weight;
    case "time":
      return engine.stats_time;
    case "timeout":
      return engine.timeout;
    case "reliability":
      return engine.reliability;
    case "name":
      return null;
  }
}

function compareEngines(
  a: EngineEntry,
  b: EngineEntry,
  sort: SortState<EngineSortKey>,
  enabled: Record<string, boolean>,
  category: string,
): number {
  if (sort.key === "name") {
    return a.name.localeCompare(b.name) * (sort.asc ? 1 : -1);
  }
  if (!sort.key) {
    return 0;
  }
  const dir = sort.asc ? 1 : -1;
  const av = sortValue(a, sort.key, enabled, category);
  const bv = sortValue(b, sort.key, enabled, category);
  // engines without a metric always sink to the bottom
  if (av === null && bv === null) {
    return a.name.localeCompare(b.name);
  }
  if (av === null) {
    return 1;
  }
  if (bv === null) {
    return -1;
  }
  return (av - bv) * dir;
}

/** One engine row; owns the pinned state of its info tooltip (click pins —
    touch users cannot hover). */
function EngineRow({
  engine,
  engineKey,
  enabled,
  toggleEngine,
  showMetrics,
}: {
  engine: EngineEntry;
  engineKey: string;
  enabled: boolean;
  toggleEngine: (key: string, value: boolean) => void;
  showMetrics: boolean;
}) {
  const t = useT();
  const [pinned, setPinned] = useState(false);
  return (
    <tr className="border-t border-line transition-colors hover:bg-surface-2/40" key={engineKey}>
      <td className="px-3 py-3">
        <Switch
          checked={enabled}
          label={`${t("allow")} ${engine.name}`}
          onChange={(value) => {
            toggleEngine(engineKey, value);
          }}
        />
      </td>
      <td className="max-w-52 px-4 py-3">
        {/* hover, keyboard focus, or a click (pins it — touch users cannot
              hover) reveals the tooltip */}
        <div className="group/engine relative">
          <button
            aria-expanded={pinned}
            aria-label={`${t("show_engine_info")}: ${engine.name}`}
            className="flex items-center gap-1 truncate font-medium text-ink"
            onClick={() => {
              setPinned((value) => !value);
            }}
            onMouseEnter={() => void loadEngineDescriptions()}
            type="button"
          >
            {engine.enable_http ? <AlertTriangle className="size-3.5 shrink-0 text-warning" /> : null}
            <span className="truncate">
              {engine.name}
              {engine.language ? ` (${engine.language})` : ""}
            </span>
          </button>
          <EngineTooltip engine={engine} pinned={pinned} />
        </div>
      </td>
      <td className="px-4 py-3">
        <code className={CODE_CHIP}>!{engine.shortcut}</code>
      </td>
      <td className="px-4 py-3">
        {engine.supports_safesearch ? (
          <Check className="size-3.5 text-ok" />
        ) : (
          <Minus className="size-3.5 text-ink-3" />
        )}
      </td>
      <td className="px-4 py-3">
        {engine.supports_time_range ? (
          <Check className="size-3.5 text-ok" />
        ) : (
          <Minus className="size-3.5 text-ink-3" />
        )}
      </td>
      <td className="px-4 py-3">{engine.weight}</td>
      {showMetrics ? (
        <td className="px-4 py-3">
          {engine.stats_time !== null ? (
            <div className="flex items-center gap-2">
              <span className="w-10 text-ink-2">{engine.stats_time}</span>
              {/* the metric is a percentage already: value = its own scale */}
              <Meter fillClassName="bg-accent-strong" max={100} trackClassName="h-1.5 w-24" value={engine.stats_time} />
            </div>
          ) : (
            <span className="text-ink-3">–</span>
          )}
        </td>
      ) : null}
      <td className={`px-4 py-3 ${engine.warn_timeout ? "font-medium text-danger" : "text-ink-2"}`}>
        {engine.timeout}s
      </td>
      {showMetrics ? (
        <td className={`px-4 py-3 font-medium ${reliabilityColor(engine.reliability)}`}>{engine.reliability ?? "–"}</td>
      ) : null}
    </tr>
  );
}

export function EngineTable({
  tab,
  enabled,
  toggleEngine,
  showMetrics,
}: {
  tab: PreferencesPageData["engine_tabs"][number];
  enabled: Record<string, boolean>;
  toggleEngine: (key: string, value: boolean) => void;
  showMetrics: boolean;
}) {
  const t = useT();
  const { sort, cycleSort } = useSortState<EngineSortKey>();

  const engineRow = (engine: EngineEntry): ReactNode => (
    <EngineRow
      enabled={Boolean(enabled[`${engine.name}__${tab.category}`])}
      engine={engine}
      engineKey={`${engine.name}__${tab.category}`}
      showMetrics={showMetrics}
      toggleEngine={toggleEngine}
    />
  );

  const rows: ReactNode[] = [];
  if (!sort.key) {
    // natural order: grouped by engine group with group header rows
    for (const group of tab.groups) {
      if (group.engines.length > 1) {
        rows.push(
          <tr className="bg-surface-2/60" key={`group-${group.group}`}>
            <td className="px-3 py-1.5 font-medium text-ink-2" colSpan={2}>
              {engineGroupLabel(group.group, t)}
            </td>
            <td className="px-3 py-1.5" colSpan={showMetrics ? 7 : 5}>
              {group.group_bang ? <code className={CODE_CHIP}>{group.group_bang}</code> : null}
            </td>
          </tr>,
        );
      }
      for (const engine of group.engines) {
        rows.push(engineRow(engine));
      }
    }
  } else {
    // sorted: one flat, fully ordered list
    for (const engine of [...tab.groups.flatMap((group) => group.engines)].sort((a, b) =>
      compareEngines(a, b, sort, enabled, tab.category),
    )) {
      rows.push(engineRow(engine));
    }
  }

  const ariaSort = (key: EngineSortKey) => (sort.key === key ? (sort.asc ? "ascending" : "descending") : undefined);

  return (
    /* no own border — the enclosing preferences Card frames the table */
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-left text-xs">
        <thead className="bg-surface-2 text-ink-3">
          <tr>
            <th aria-sort={ariaSort("allow")} className="px-4 py-3 font-medium">
              <SortHeader columnKey="allow" label={t("allow")} onCycle={cycleSort} sort={sort} />
            </th>
            <th aria-sort={ariaSort("name")} className="px-4 py-3 font-medium">
              <SortHeader columnKey="name" label={t("engine_name")} onCycle={cycleSort} sort={sort} />
            </th>
            <th className="px-4 py-3 font-medium">{t("bang")}</th>
            <th aria-sort={ariaSort("safesearch")} className="px-4 py-3 font-medium">
              <SortHeader columnKey="safesearch" label={t("safesearch")} onCycle={cycleSort} sort={sort} />
            </th>
            <th aria-sort={ariaSort("time_range")} className="px-4 py-3 font-medium">
              <SortHeader columnKey="time_range" label={t("time_range")} onCycle={cycleSort} sort={sort} />
            </th>
            <th aria-sort={ariaSort("weight")} className="px-4 py-3 font-medium">
              <SortHeader columnKey="weight" label={t("weight")} onCycle={cycleSort} sort={sort} />
            </th>
            {showMetrics ? (
              <th aria-sort={ariaSort("time")} className="px-4 py-3 font-medium">
                <SortHeader columnKey="time" label={t("response_time")} onCycle={cycleSort} sort={sort} />
              </th>
            ) : null}
            <th aria-sort={ariaSort("timeout")} className="px-4 py-3 font-medium">
              <SortHeader columnKey="timeout" label={t("max_time")} onCycle={cycleSort} sort={sort} />
            </th>
            {showMetrics ? (
              <th aria-sort={ariaSort("reliability")} className="px-4 py-3 font-medium">
                <SortHeader columnKey="reliability" label={t("reliability")} onCycle={cycleSort} sort={sort} />
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
