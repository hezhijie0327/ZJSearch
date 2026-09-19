// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useMemo } from "react";
import { LegacyAnswer } from "@/features/results/answers/Legacy.tsx";
import { StockAnswer } from "@/features/results/answers/Stock.tsx";
import { TranslationsAnswer } from "@/features/results/answers/Translations.tsx";
import { WeatherAnswer } from "@/features/results/answers/Weather.tsx";
import { useT } from "@/lib/i18n.ts";
import type { AnswerData } from "@/lib/types.ts";

/** Answer tiering (see AGENTS.md): rich widgets (weather, translations) and
    the interactive converter keep the accent card; every other legacy answer
    (calculator, time, ip, hash, random, stats, tor — none has a source url)
    renders uncarded with a border-b divider, Google-style. */
function isCarded(answer: AnswerData): boolean {
  return answer.template !== "answer/legacy.html" || answer.data?.kind === "unit_conversion";
}

/** Content-identity key: stateful widgets (weather source list expansion)
    must not inherit their state from a different answer after a new search
    the way index keys let them. The index suffix keeps duplicates safe. */
function answerKey(answer: AnswerData, index: number): string {
  switch (answer.template) {
    case "answer/translations.html":
      return `translations-${answer.translations[0]?.text ?? ""}-${index}`;
    case "answer/weather.html":
      return `weather-${answer.service}-${index}`;
    case "answer/stock.html":
      return `stock-${answer.data.symbol}-${index}`;
    default:
      return `legacy-${answer.engine}-${index}`;
  }
}

export function Answers({ answers, query }: { answers: AnswerData[]; query?: string }) {
  const t = useT();
  const visible = useMemo(() => {
    if (answers.length === 0) {
      return [];
    }
    // several weather engines may answer the same query with the same data
    // at different coverage (duckduckgo ~10 days hourly, open-meteo ~2.7
    // days, wttr.in 3 days 3-hourly): render the longest coverage as one
    // card and credit every answering engine as its source
    const weatherAnswers = answers
      .filter(
        (answer): answer is Extract<AnswerData, { template: "answer/weather.html" }> =>
          answer.template === "answer/weather.html",
      )
      .sort((a, b) => b.forecasts.length - a.forecasts.length);
    const longest = weatherAnswers[0];
    const merged: Array<{ answer: AnswerData; key: string }> = [];
    let weatherInserted = false;
    answers.forEach((answer, index) => {
      if (answer.template === "answer/weather.html") {
        if (!weatherInserted && longest !== undefined) {
          merged.push({ answer: longest, key: answerKey(longest, index) });
          weatherInserted = true;
        }
        return;
      }
      merged.push({ answer, key: answerKey(answer, index) });
    });
    return merged;
  }, [answers]);
  const weatherSources = useMemo(
    () =>
      answers
        .filter(
          (answer): answer is Extract<AnswerData, { template: "answer/weather.html" }> =>
            answer.template === "answer/weather.html",
        )
        .map((a) => ({ service: a.service, url: a.url })),
    [answers],
  );

  if (answers.length === 0) {
    return null;
  }

  return (
    <section aria-label={t("answers")} className="space-y-2">
      {visible.map(({ answer, key }) => {
        const carded = isCarded(answer);
        return (
          <div
            className={
              carded
                ? "animate-fade-up rounded-2xl border border-accent/25 bg-accent-soft/50 px-4 py-3"
                : "animate-fade-up border-b border-line px-4 pb-3 last:border-b-0"
            }
            key={key}
          >
            {answer.template === "answer/translations.html" ? (
              <TranslationsAnswer answer={answer} query={query} />
            ) : answer.template === "answer/weather.html" ? (
              <WeatherAnswer answer={answer} sources={weatherSources} />
            ) : answer.template === "answer/stock.html" ? (
              <StockAnswer answer={answer} />
            ) : (
              <LegacyAnswer answer={answer} />
            )}
          </div>
        );
      })}
    </section>
  );
}
