// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Stock quote card (stock_quote plugin, eastmoney data), DDG/Yahoo style:
    name + exchange:ticker header, price hero, range pills (1D..MAX), a chart
    with y/x axes, a hover crosshair with a data tooltip (date/OHLC/volume),
    prev-close reference and a last-price tag, plus a statistics grid.
    Red/green follows the locale convention: zh-CN reads red = up / green =
    down, international markets read the opposite. */

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { useContext, useState } from "react";
import { I18nContext, useT } from "@/lib/i18n.ts";
import type { AnswerData, StockAnswerPayload, StockSeries } from "@/lib/types.ts";

type RangeKey = "1D" | "5D" | "1M" | "YTD" | "1Y" | "5Y" | "MAX";

const RANGES: RangeKey[] = ["1D", "5D", "1M", "YTD", "1Y", "5Y", "MAX"];

function fmtNum(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

function fmtCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function rangeLabel(range: RangeKey, t: ReturnType<typeof useT>): string {
  const keys: Record<RangeKey, Parameters<typeof t>[0]> = {
    "1D": "range_1d",
    "5D": "range_5d",
    "1M": "range_1m",
    YTD: "range_ytd",
    "1Y": "range_1y",
    "5Y": "range_5y",
    MAX: "range_max",
  };
  return t(keys[range]);
}

/** Shared 0–100 SVG projection for the stock charts: min→max mapped with an
    8% bleed so strokes and endpoint labels never clip.  `extra` values join
    the domain (the previous close) so reference lines and polylines agree. */
function makeScale(values: number[], extra: number[] = []) {
  const all = [...values, ...extra];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  return {
    xPct: (idx: number) => (values.length < 2 ? 0 : (idx / (values.length - 1)) * 100),
    yPct: (value: number) => ((max + span * 0.08 - value) / (span * 1.16)) * 100,
  };
}

/** Intraday line colored per segment against the previous close (Yahoo
    style): runs above the reference stroke in the bullish color, below in
    the bearish one. */
function SegmentLine({
  bearStroke,
  bullStroke,
  prevClose,
  series,
}: {
  bearStroke: string;
  bullStroke: string;
  prevClose: number;
  series: number[];
}) {
  const { xPct, yPct } = makeScale(series, [prevClose]);

  const runs: Array<{ above: boolean; points: string[] }> = [];
  let current: { above: boolean; points: string[] } | null = null;
  series.forEach((v, i) => {
    const above = v >= prevClose;
    const point = `${xPct(i).toFixed(2)},${yPct(v).toFixed(2)}`;
    if (current && current.above === above) {
      current.points.push(point);
      return;
    }
    // start the new run from the previous run's last point so the line
    // stays connected across the reference
    const previous = current?.points[current.points.length - 1];
    current = { above, points: previous ? [previous, point] : [point] };
    runs.push(current);
  });

  return (
    <svg aria-hidden="true" className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
      {runs.map((run, index) => (
        <polyline
          className={run.above ? bullStroke : bearStroke}
          fill="none"
          key={index}
          points={run.points.join(" ")}
          strokeWidth="1.25"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

function RangeLine({ areaClass, series, strokeClass }: { areaClass: string; series: number[]; strokeClass: string }) {
  const first = series[0];
  const last = series[series.length - 1];
  if (first === undefined || last === undefined || series.length < 2) {
    return null;
  }
  const { xPct, yPct } = makeScale(series);
  const line = series.map((v, i) => `${xPct(i).toFixed(2)},${yPct(v).toFixed(2)}`).join(" ");
  const firstY = yPct(first).toFixed(2);
  const lastY = yPct(last).toFixed(2);
  return (
    <svg aria-hidden="true" className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
      <path className={areaClass} d={`M0 ${firstY} L${line} L100 ${lastY} L100 100 L0 100 Z`} />
      <polyline className={strokeClass} fill="none" points={line} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function xAxisLabels(labels: string[]): string[] {
  const n = labels.length;
  if (n <= 5) {
    return labels;
  }
  return [0, 1, 2, 3, 4].map((k) => labels[Math.round((k / 4) * (n - 1))] ?? "");
}

export function StockAnswer({ answer }: { answer: Extract<AnswerData, { template: "answer/stock.html" }> }) {
  const t = useT();
  const locale = useContext(I18nContext);
  const redUp = locale.startsWith("zh");
  const d: StockAnswerPayload = answer.data;
  const up = d.change >= 0;
  const bullText = redUp ? "text-danger" : "text-ok";
  const bearText = redUp ? "text-ok" : "text-danger";
  const bullStroke = redUp ? "stroke-danger" : "stroke-ok";
  const bearStroke = redUp ? "stroke-ok" : "stroke-danger";
  const tone = up ? bullText : bearText;
  const sign = up ? "+" : "";

  const [range, setRange] = useState<RangeKey>("1D");
  const [hover, setHover] = useState<number | null>(null);
  const active: StockSeries = d.ranges[range] ?? d.ranges["1D"] ?? { labels: [], candles: [] };
  const candles = active.candles;
  const closes = candles.map((c) => c[3]);
  const hoverClose = hover !== null ? closes[hover] : undefined;
  // one shared projection for the 1D segments and every overlay: the
  // previous-close reference joins the domain so the dashed line, the
  // polyline and the hover dot all agree on the vertical mapping
  const scale = makeScale(closes, range === "1D" ? [d.previous_close] : []);

  const stats: Array<[string, string]> = (
    [
      [t("stat_open"), d.open, "num"],
      [t("stat_high"), d.high, "num"],
      [t("stat_low"), d.low, "num"],
      [t("stat_prev_close"), d.previous_close, "num"],
      [t("stat_52w_high"), d.week52_high, "num"],
      [t("stat_52w_low"), d.week52_low, "num"],
      [t("stat_pe"), d.pe, "num"],
      [t("stat_mcap"), d.market_cap, "compact"],
      [t("stat_avg_volume"), d.avg_volume, "compact"],
    ] as Array<[string, number | null, "num" | "compact"]>
  )
    .filter(([, value]) => value !== null)
    .map(([label, value, style]) => [
      label,
      style === "compact" ? fmtCompact(value as number, locale) : fmtNum(value as number, locale),
    ]);

  return (
    <div>
      {/* header: company name primary, exchange:ticker as the quiet identity */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-xl font-semibold text-ink">{d.name}</h3>
        <span className="font-mono text-sm text-ink-2">
          {d.exchange}:{d.symbol}
        </span>
      </div>
      {d.as_of_date ? (
        <p className="mt-0.5 text-xs text-ink-3">
          {t("stock_asof")} {d.as_of_date}
          {d.as_of_time ? ` · ${d.as_of_time}` : ""}
        </p>
      ) : null}

      {/* price hero */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-4xl font-semibold tabular-nums text-ink">{d.price}</span>
        <span className="text-sm text-ink-3">{d.currency}</span>
        <span className={`inline-flex items-center gap-0.5 text-sm font-medium tabular-nums ${tone}`}>
          {up ? <ArrowUpRight className="size-4" /> : <ArrowDownRight className="size-4" />}
          {sign}
          {d.change.toFixed(2)} ({sign}
          {d.change_percent.toFixed(2)}%)
        </span>
      </div>

      {/* range pills */}
      {Object.keys(d.ranges).length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {RANGES.filter((key) => (d.ranges[key]?.candles.length ?? 0) > 1).map((key) => (
            <button
              className={`rounded-full px-3 py-1 text-[13px] transition-colors ${
                key === range
                  ? "bg-accent-strong font-medium text-accent-contrast"
                  : "bg-surface-2 text-ink-2 hover:text-ink"
              }`}
              key={key}
              onClick={() => {
                setRange(key);
                setHover(null);
              }}
              type="button"
            >
              {rangeLabel(key, t)}
            </button>
          ))}
        </div>
      ) : null}

      {/* chart with hover crosshair (skipped entirely when the kline fetch
          failed but the quote succeeded -- the price hero above still works) */}
      {candles.length > 0 ? (
        <div className="mt-3">
          <div
            className="relative h-52"
            onPointerLeave={() => {
              setHover(null);
            }}
            onPointerMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = (e.clientX - rect.left) / rect.width;
              setHover(Math.max(0, Math.min(candles.length - 1, Math.round(ratio * (candles.length - 1)))));
            }}
          >
            <div aria-hidden="true" className="absolute inset-0 flex flex-col justify-between">
              {[0, 1, 2].map((row) => (
                <div aria-hidden="true" className="border-t border-line/40" key={row} />
              ))}
            </div>
            {range === "1D" ? (
              <div
                aria-hidden="true"
                className="absolute inset-x-0 border-t border-dashed border-danger/60"
                style={{ top: `${scale.yPct(d.previous_close)}%` }}
              />
            ) : null}
            {range === "1D" ? (
              <SegmentLine
                bearStroke={bearStroke}
                bullStroke={bullStroke}
                prevClose={d.previous_close}
                series={closes}
              />
            ) : (
              <RangeLine
                areaClass={up ? "fill-ok/15" : "fill-danger/15"}
                series={closes}
                strokeClass={up ? bullStroke : bearStroke}
              />
            )}
            {/* hover crosshair + marker dot */}
            {hover !== null && hoverClose !== undefined ? (
              <>
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 border-l border-dashed border-ink-3/60"
                  style={{ left: `${scale.xPct(hover)}%` }}
                />
                <div
                  aria-hidden="true"
                  className={`absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line bg-surface ${tone}`}
                  style={{ left: `${scale.xPct(hover)}%`, top: `${scale.yPct(hoverClose)}%` }}
                />
              </>
            ) : null}
            {/* y labels */}
            {closes.length > 1 ? (
              <>
                <span
                  aria-hidden="true"
                  className="absolute right-0 top-0 -translate-y-1/2 rounded bg-surface px-1 text-[10px] text-ink-3"
                >
                  {fmtNum(Math.max(...closes), "en")}
                </span>
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 right-0 translate-y-1/2 rounded bg-surface px-1 text-[10px] text-ink-3"
                >
                  {fmtNum(Math.min(...closes), "en")}
                </span>
              </>
            ) : null}
            {/* price tag: hovered close, else the last one */}
            <div className="absolute right-0 -translate-y-1/2" style={{ top: `${scale.yPct(hoverClose ?? d.price)}%` }}>
              <span
                className={`rounded border border-line bg-surface px-1 py-0.5 text-[10px] font-medium tabular-nums ${
                  hover !== null && hoverClose !== undefined ? tone : "text-ink"
                }`}
              >
                {fmtNum(hoverClose ?? d.price, "en")}
              </span>
            </div>
            {/* hover tooltip */}
            {hover !== null && candles[hover] ? (
              <div
                className={`pointer-events-none absolute top-1 z-10 w-44 rounded-lg border border-line bg-surface p-2 text-xs shadow-pop ${
                  scale.xPct(hover) > 55 ? "right-1/2 mr-3" : "left-1/2 ml-3"
                }`}
              >
                <div className="mb-1 font-medium text-ink">{active.labels[hover]}</div>
                <TooltipRow label={t("tip_close")} value={fmtNum(candles[hover][3], locale)} />
                <TooltipRow label={t("tip_open")} value={fmtNum(candles[hover][0], locale)} />
                <TooltipRow label={t("tip_high")} value={fmtNum(candles[hover][1], locale)} />
                <TooltipRow label={t("tip_low")} value={fmtNum(candles[hover][2], locale)} />
                <TooltipRow label={t("tip_volume")} value={fmtCompact(candles[hover][4], locale)} />
              </div>
            ) : null}
          </div>
          {/* x axis labels: five evenly spaced bars */}
          <div aria-hidden="true" className="mt-1 flex justify-between text-[10px] text-ink-3">
            {xAxisLabels(active.labels).map((label, index) => (
              <span key={index}>{label}</span>
            ))}
          </div>
        </div>
      ) : null}

      {/* statistics grid */}
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {stats.map(([label, value]) => (
          <div className="flex items-baseline justify-between gap-2 border-b border-line/60 pb-1" key={label}>
            <span className="text-xs text-ink-3">{label}</span>
            <span className="text-sm tabular-nums text-ink">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-3">{label}</span>
      <span className="tabular-nums text-ink">{value}</span>
    </div>
  );
}
