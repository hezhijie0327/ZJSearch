// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChartColumn, ChevronLeft } from "lucide-react";
import { useMemo } from "react";
import { Meter } from "@/components/Meter.tsx";
import { Link, Shell } from "@/components/Shell.tsx";
import { SortHeader } from "@/components/SortHeader.tsx";
import { round1 } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { reliabilityColor } from "@/lib/styles.ts";
import { useSortState } from "@/lib/tableSort.ts";
import type { EngineStat, StatsPageData } from "@/lib/types.ts";

type SortKey = "name" | "score" | "result_count" | "time" | "reliability";

function TimeCell({ engine, maxTime }: { engine: EngineStat; maxTime: number }) {
  const t = useT();
  if (engine.total === null) {
    return <span className="text-ink-3">–</span>;
  }
  const tooltip = [
    `${t("median")}: ${engine.total} (${t("http")} ${engine.http ?? "-"} / ${t("processing")} ${engine.processing ?? "-"})`,
    `P80: ${engine.total_p80 ?? "-"}`,
    `P95: ${engine.total_p95 ?? "-"}`,
  ].join("\n");
  return (
    <div className="flex items-center gap-2" title={tooltip}>
      <span className="w-10 text-ink-2">{round1(engine.total)}</span>
      <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
        {engine.http !== null ? (
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-accent"
            style={{ width: `${Math.min(100, (engine.http / maxTime) * 100)}%` }}
          />
        ) : null}
        {engine.processing !== null ? (
          <span
            className="absolute inset-y-0 rounded-full bg-accent/50"
            style={{
              left: `${Math.min(100, ((engine.http ?? 0) / maxTime) * 100)}%`,
              width: `${Math.min(100, (engine.processing / maxTime) * 100)}%`,
            }}
          />
        ) : null}
      </span>
    </div>
  );
}

function ErrorTable({ errors, title }: { errors: StatsPageData["errors"]; title: string }) {
  const t = useT();
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-lg font-semibold text-ink">{title}</h2>
      <div className="space-y-3">
        {errors.map((error, index) => (
          <div className="overflow-x-auto rounded-2xl border border-line" key={index}>
            <table className="w-full text-left text-xs">
              <tbody>
                <tr className="border-b border-line">
                  <th className="w-28 bg-surface-2 px-3 py-1.5 font-medium text-ink-3" scope="row">
                    {error.exception_classname ? t("exception") : t("message")}
                  </th>
                  <td className="break-all px-3 py-1.5 font-medium text-ink">
                    {error.exception_classname || error.log_message}
                  </td>
                  <th className="w-28 bg-surface-2 px-3 py-1.5 font-medium text-ink-3" scope="row">
                    {t("percentage")}
                  </th>
                  <td className="px-3 py-1.5 text-ink">{error.percentage}%</td>
                </tr>
                {error.log_parameters.length > 0 ? (
                  <tr className="border-b border-line">
                    <th className="bg-surface-2 px-3 py-1.5 font-medium text-ink-3" scope="row">
                      {t("parameter")}
                    </th>
                    <td className="px-3 py-1.5 font-mono break-all text-ink-2" colSpan={3}>
                      {error.log_parameters.join(" ")}
                    </td>
                  </tr>
                ) : null}
                <tr>
                  <th className="bg-surface-2 px-3 py-1.5 font-medium text-ink-3" scope="row">
                    {t("filename")}
                  </th>
                  <td className="px-3 py-1.5 font-mono text-ink-2" dir="ltr">
                    {error.filename}:{error.line_no}
                  </td>
                  <th className="bg-surface-2 px-3 py-1.5 font-medium text-ink-3" scope="row">
                    {t("function")}
                  </th>
                  <td className="px-3 py-1.5 font-mono text-ink-2">{error.function}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}

export function StatsPage({ data, embedded = false }: { data: StatsPageData; embedded?: boolean }) {
  const t = useT();
  const globals = data.globals;
  const { sort, cycleSort } = useSortState<SortKey>();

  const engines = useMemo(() => {
    if (!sort.key) {
      return data.engines;
    }
    const dir = sort.asc ? 1 : -1;
    const key = sort.key === "time" ? "total" : sort.key;
    return [...data.engines].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * dir;
      }
      const an = av ?? (key === "name" ? "" : -1);
      const bn = bv ?? (key === "name" ? "" : -1);
      return (Number(an) - Number(bn)) * dir;
    });
  }, [data.engines, sort]);

  const selectedErrors = data.errors.filter((error) => !error.secondary);
  const warnings = data.errors.filter((error) => error.secondary);

  return (
    <Shell embedded={embedded} globals={globals}>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-16 sm:px-6">
        {embedded ? null : (
          <h1 className="flex items-center gap-2.5 py-5 text-2xl font-semibold tracking-tight text-ink">
            <ChartColumn aria-hidden="true" className="size-5 shrink-0 text-accent" />
            {data.selected_engine_name ? (
              <>
                <Link className="hover:text-accent" href="/stats">
                  {t("engine_stats")}
                </Link>{" "}
                - {data.selected_engine_name}
              </>
            ) : (
              t("engine_stats")
            )}
          </h1>
        )}
        {embedded && data.selected_engine_name ? (
          <div className="pt-5">
            <Link
              className="inline-flex items-center gap-1 text-xs text-ink-3 transition-colors hover:text-accent"
              href="/stats"
            >
              <ChevronLeft className="size-3.5" />
              {t("engine_stats")}
            </Link>
            <h2 className="mt-2 text-lg font-semibold tracking-tight text-ink" dir="auto">
              {data.selected_engine_name}
            </h2>
          </div>
        ) : null}

        {engines.length === 0 ? (
          <p className="text-sm text-ink-2">{t("no_data_available")}</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="bg-surface-2 text-xs text-ink-3">
                <tr>
                  <th
                    aria-sort={sort.key === "name" ? (sort.asc ? "ascending" : "descending") : undefined}
                    className="px-4 py-2.5 font-medium"
                  >
                    <SortHeader columnKey="name" label={t("engine_name")} onCycle={cycleSort} sort={sort} />
                  </th>
                  <th
                    aria-sort={sort.key === "score" ? (sort.asc ? "ascending" : "descending") : undefined}
                    className="px-4 py-2.5 font-medium"
                  >
                    <SortHeader columnKey="score" label={t("scores")} onCycle={cycleSort} sort={sort} />
                  </th>
                  <th
                    aria-sort={sort.key === "result_count" ? (sort.asc ? "ascending" : "descending") : undefined}
                    className="px-4 py-2.5 font-medium"
                  >
                    <SortHeader columnKey="result_count" label={t("result_count")} onCycle={cycleSort} sort={sort} />
                  </th>
                  <th
                    aria-sort={sort.key === "time" ? (sort.asc ? "ascending" : "descending") : undefined}
                    className="px-4 py-2.5 font-medium"
                  >
                    <SortHeader columnKey="time" label={t("response_time")} onCycle={cycleSort} sort={sort} />
                  </th>
                  <th
                    aria-sort={sort.key === "reliability" ? (sort.asc ? "ascending" : "descending") : undefined}
                    className="px-4 py-2.5 font-medium"
                  >
                    <SortHeader columnKey="reliability" label={t("reliability")} onCycle={cycleSort} sort={sort} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {engines.map((engine) => (
                  <tr className="border-t border-line hover:bg-surface-2/50" key={engine.name}>
                    <td className="px-4 py-2.5">
                      <Link
                        className="font-medium text-ink hover:text-accent"
                        href={`/stats?engine=${encodeURIComponent(engine.name)}`}
                      >
                        {engine.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-ink-2">
                      {engine.score_per_result !== null ? round1(engine.score_per_result) : "–"}
                    </td>
                    <td className="px-4 py-2.5">
                      {engine.result_count ? (
                        <div className="flex items-center gap-2">
                          <span className="w-10 text-ink-2">{engine.result_count}</span>
                          <Meter max={data.max_result_count} value={engine.result_count} />
                        </div>
                      ) : (
                        <span className="text-ink-3">–</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <TimeCell engine={engine} maxTime={data.max_time} />
                    </td>
                    <td className={`px-4 py-2.5 font-medium ${reliabilityColor(engine.reliability)}`}>
                      {engine.reliability ?? "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data.selected_engine_name ? (
          <>
            {selectedErrors.length > 0 ? (
              <ErrorTable errors={selectedErrors} title={t("errors_and_exceptions")} />
            ) : null}
            {warnings.length > 0 ? <ErrorTable errors={warnings} title={t("warnings")} /> : null}
          </>
        ) : null}
      </main>
    </Shell>
  );
}
