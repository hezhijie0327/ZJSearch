// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronLeft, MapPin } from "lucide-react";
import { cap } from "@/lib/format.ts";
import { useLocale, useT } from "@/lib/i18n.ts";
import { CHIP, CHIP_HOVER, SCROLLBAR_NONE } from "@/lib/styles.ts";
import type { AnswerData, WeatherItem } from "@/lib/types.ts";
import { useCapExpand } from "@/lib/useCapExpand.ts";

const MAX_SOURCES_SHOWN = 3;

/** zh labels for the upstream weather condition ids (WeatherConditionType in
    searx/weather.py); other locales render the prettified id.  The theme owns
    these — the server ships the raw id only. */
const WEATHER_CONDITION_ZH: Record<string, string> = {
  "clear sky": "晴",
  fair: "晴朗",
  "partly cloudy": "局部多云",
  cloudy: "多云",
  fog: "雾",
  "light rain": "小雨",
  rain: "雨",
  "heavy rain": "大雨",
  "light rain showers": "小阵雨",
  "rain showers": "阵雨",
  "heavy rain showers": "强阵雨",
  "light rain and thunder": "小雨有雷",
  "rain and thunder": "雷雨",
  "heavy rain and thunder": "大雨有雷",
  "light rain showers and thunder": "小阵雨有雷",
  "rain showers and thunder": "雷阵雨",
  "heavy rain showers and thunder": "强雷阵雨",
  "light sleet": "小雨夹雪",
  sleet: "雨夹雪",
  "heavy sleet": "大雨夹雪",
  "light sleet showers": "小阵雨夹雪",
  "sleet showers": "阵雨夹雪",
  "heavy sleet showers": "强阵雨夹雪",
  "light sleet and thunder": "小雨夹雪有雷",
  "sleet and thunder": "雨夹雪有雷",
  "heavy sleet and thunder": "大雨夹雪有雷",
  "light sleet showers and thunder": "小阵雨夹雪有雷",
  "sleet showers and thunder": "雷阵雨夹雪",
  "heavy sleet showers and thunder": "强阵雨夹雪有雷",
  "light snow": "小雪",
  snow: "雪",
  "heavy snow": "大雪",
  "light snow showers": "小阵雪",
  "snow showers": "阵雪",
  "heavy snow showers": "强阵雪",
  "light snow and thunder": "小雪有雷",
  "snow and thunder": "雪有雷",
  "heavy snow and thunder": "大雪有雷",
  "light snow showers and thunder": "小阵雪有雷",
  "snow showers and thunder": "雷阵雪",
  "heavy snow showers and thunder": "强阵雪有雷",
};

function conditionLabel(condition: string, locale: string): string {
  if (locale.startsWith("zh")) {
    return WEATHER_CONDITION_ZH[condition] ?? condition;
  }
  return cap(condition);
}

/** The server datetime is location wall-clock (no offset): HH:mm is a plain
    substring, the weekday comes from the date part. */
function formatSlotTime(item: WeatherItem): string {
  if (!item.datetime_iso) {
    return "";
  }
  return item.datetime_iso.slice(11, 16);
}

function formatWeekday(item: WeatherItem, locale: string): string {
  const fallback = item.date_iso ?? "";
  if (!item.datetime_iso) {
    return fallback;
  }
  const [y = NaN, m = NaN, d = NaN] = item.datetime_iso.slice(0, 10).split("-").map(Number);
  if (![y, m, d].every(Number.isFinite)) {
    return fallback;
  }
  const formatter = new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", { weekday: "short" });
  try {
    return formatter.format(new Date(y, m - 1, d));
  } catch {
    return fallback;
  }
}

/** SVG temperature trend over the next hourly slots (accent area line with
    temp / time labels every third slot), horizontally scrollable. */
function WeatherTrend({ forecasts }: { forecasts: WeatherItem[] }) {
  const t = useT();
  const slots = forecasts.slice(0, 24);
  if (slots.length < 3) {
    return null;
  }
  const step = 38;
  const top = 22;
  const chartH = 46;
  const height = top + chartH + 22;
  const vals = slots.map((f) => f.temp_c);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const points = slots.map((f, i) => ({
    x: i * step + step / 2,
    y: top + chartH * (1 - (f.temp_c - min) / span),
  }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const endX = (points.length - 1) * step + step / 2;
  const area = `${line} L${endX.toFixed(1)} ${top + chartH} L${(step / 2).toFixed(1)} ${top + chartH} Z`;
  const labels: Array<{ x: number; y: number; temp: number; time: string }> = [];
  points.forEach((p, i) => {
    const slot = slots[i];
    if (slot && i % 3 === 0) {
      labels.push({ x: p.x, y: p.y, temp: slot.temp_c, time: formatSlotTime(slot) });
    }
  });
  return (
    <div className={`mt-4 overflow-x-auto pb-1 ${SCROLLBAR_NONE}`}>
      <svg className="block" height={height} role="img" width={slots.length * step}>
        <title>{t("weather_trend")}</title>
        <path className="fill-accent/15" d={area} />
        <path className="stroke-accent-strong" d={line} fill="none" strokeLinecap="round" strokeWidth={2} />
        {labels.map((label) => (
          <g key={label.x}>
            <text className="fill-ink text-[10px] font-semibold" textAnchor="middle" x={label.x} y={label.y - 7}>
              {Math.round(label.temp)}°
            </text>
            <text className="fill-ink-3 text-[10px]" textAnchor="middle" x={label.x} y={top + chartH + 14}>
              {label.time}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/** Daily strip grouped from the hourly slots: weekday, mid-day symbol and
    the day's high/low temperature (Google weather style). */
function WeatherDaily({ forecasts }: { forecasts: WeatherItem[] }) {
  const locale = useLocale();
  const days: Array<{
    date: string;
    weekday: string;
    symbol: string;
    hi: number;
    lo: number;
    bestHour: number;
  }> = [];
  const byDate = new Map<string, (typeof days)[number]>();
  for (const f of forecasts) {
    if (!f.date_iso) {
      continue;
    }
    let day = byDate.get(f.date_iso);
    if (!day) {
      day = {
        date: f.date_iso,
        weekday: formatWeekday(f, locale),
        symbol: f.symbol,
        hi: f.temp_c,
        lo: f.temp_c,
        bestHour: f.hour ?? 12,
      };
      byDate.set(f.date_iso, day);
      days.push(day);
      continue;
    }
    if (f.temp_c > day.hi) {
      day.hi = f.temp_c;
    }
    if (f.temp_c < day.lo) {
      day.lo = f.temp_c;
    }
    const hour = f.hour ?? 12;
    if (f.symbol && Math.abs(hour - 13) < Math.abs(day.bestHour - 13)) {
      day.bestHour = hour;
      day.symbol = f.symbol;
    }
  }
  if (days.length < 2) {
    return null;
  }
  return (
    <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
      {days.map((day, index) => (
        <div
          className={`w-20 shrink-0 rounded-2xl border px-2 py-2.5 text-center ${
            index === 0 ? "border-accent/40 bg-accent-soft/40" : "border-line bg-surface"
          }`}
          key={day.date}
        >
          <p className="text-xs font-medium text-ink">{day.weekday}</p>
          {day.symbol ? (
            <img alt="" className="mx-auto mt-1.5 size-8" decoding="async" loading="lazy" src={day.symbol} />
          ) : null}
          <p className="mt-1.5 whitespace-nowrap text-xs">
            <span className="font-semibold text-ink">{Math.round(day.hi)}°</span>{" "}
            <span className="text-ink-3">{Math.round(day.lo)}°</span>
          </p>
        </div>
      ))}
    </div>
  );
}

export function WeatherAnswer({
  answer,
  sources,
}: {
  answer: Extract<AnswerData, { template: "answer/weather.html" }>;
  sources: Array<{ service: string; url: string }>;
}) {
  const t = useT();
  const locale = useLocale();
  // same cap-and-expand contract as EnginesLine: 3 pills + "+N"
  const {
    expanded: sourcesExpanded,
    toggle: toggleSources,
    hidden: hiddenSources,
  } = useCapExpand(sources.length, MAX_SOURCES_SHOWN);
  const shownSources = sourcesExpanded ? sources : sources.slice(0, MAX_SOURCES_SHOWN);
  const current = answer.current;
  const heroC = Math.round(current.temp_c);
  const heroF = Math.round(current.temp_f);
  const meta: Array<[string, string]> = [];
  if (current.feels_like !== undefined) {
    meta.push([t("feels_like"), `${Math.round(current.feels_like)} °C`]);
  }
  if (current.wind) {
    meta.push([
      t("wind"),
      current.wind_speed !== undefined ? `${current.wind} ${Math.round(current.wind_speed)} km/h` : current.wind,
    ]);
  }
  if (current.humidity !== undefined) {
    meta.push([t("humidity"), `${Math.round(current.humidity)}%`]);
  }
  if (current.pressure !== undefined) {
    meta.push([t("pressure"), `${Math.round(current.pressure)} hPa`]);
  }
  return (
    <div>
      <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
        <MapPin className="size-3.5 shrink-0 text-ink-3" />
        {current.location_name}
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-10 gap-y-3">
        <div className="flex items-center gap-4">
          {current.symbol ? (
            <img alt="" className="size-16" decoding="async" loading="lazy" src={current.symbol} />
          ) : null}
          <div>
            <p className="flex items-start gap-2">
              <span className="text-4xl font-semibold leading-none text-ink">
                {heroC}
                <span className="ms-0.5 align-top text-lg font-medium text-ink-3">°C</span>
              </span>
              <span className="mt-1 border-s border-line ps-2 text-sm text-ink-3">{heroF} °F</span>
            </p>
            <p className="mt-2 text-sm text-ink-2">{conditionLabel(current.condition, locale)}</p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-10 gap-y-1 text-xs">
          {meta.map(([label, value]) => (
            <div key={label}>
              <span className="text-ink-3">{label}: </span>
              <span className="font-medium text-ink">{value}</span>
            </div>
          ))}
        </dl>
      </div>
      <WeatherTrend forecasts={answer.forecasts} />
      <WeatherDaily forecasts={answer.forecasts} />
      {sources.length > 0 ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
          {shownSources.map((source) =>
            source.url ? (
              <a
                className={`${CHIP} ${CHIP_HOVER} text-ink-2`}
                href={source.url}
                key={source.service}
                rel="noreferrer"
                target="_blank"
              >
                {source.service}
              </a>
            ) : (
              <span className={CHIP} key={source.service}>
                {source.service}
              </span>
            ),
          )}
          {!sourcesExpanded && hiddenSources > 0 ? (
            <button
              aria-label={t("more")}
              className={`${CHIP} ${CHIP_HOVER}`}
              onClick={toggleSources}
              title={sources.map((source) => source.service).join(", ")}
              type="button"
            >
              +{hiddenSources}
            </button>
          ) : null}
          {sourcesExpanded && hiddenSources > 0 ? (
            <button
              className="inline-flex items-center gap-1 transition-colors hover:text-ink"
              onClick={toggleSources}
              type="button"
            >
              <ChevronLeft className="size-3 shrink-0" />
              {t("show_less")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
