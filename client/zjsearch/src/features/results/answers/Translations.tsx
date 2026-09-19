// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ArrowRight, ChevronDown } from "lucide-react";
import { useT } from "@/lib/i18n.ts";
import { CHIP, MONO_CHIP } from "@/lib/styles.ts";
import type { AnswerData } from "@/lib/types.ts";

/** Translation engines stamp the language pair into their answer URLs in
    engine-specific shapes: lingva uses /from/to/ path segments, mymemory
    uses sl/tl query parameters, libretranslate uses source/target. */
function parseLangPair(url: string): { from: string; to: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const lang = /^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?$/i;
  const [pathFrom, pathTo] = parsed.pathname.split("/").filter(Boolean);
  if (pathFrom && pathTo && lang.test(pathFrom) && lang.test(pathTo)) {
    return { from: pathFrom, to: pathTo };
  }
  const from = parsed.searchParams.get("source") ?? parsed.searchParams.get("sl") ?? parsed.searchParams.get("from");
  const to = parsed.searchParams.get("target") ?? parsed.searchParams.get("tl") ?? parsed.searchParams.get("to");
  if (from && to && lang.test(from) && lang.test(to)) {
    return { from, to };
  }
  return null;
}

/** Dictionary/translation answer.  Two layouts by payload shape:
    - translation (lingva, no definitions): language-pair chip + the translated
      text as the hero;
    - dictionary (wordnik): the queried word heads numbered definitions — the
      definition IS the answer, so nothing important hides behind a collapse. */
export function TranslationsAnswer({
  answer,
  query,
}: {
  answer: Extract<AnswerData, { template: "answer/translations.html" }>;
  query?: string;
}) {
  const t = useT();
  const first = answer.translations[0];
  if (!first) {
    return null;
  }
  const rest = answer.translations.slice(1);
  // the raw query keeps its bang tokens and the "en-de " language-pair prefix
  // of dictionary engines — both are noise everywhere it could be displayed
  const cleanQuery = query
    ?.replace(/^(\s*![^\s]+)+/, "")
    .replace(/^\s*[a-z]{2,3}-[a-zA-Z]{2,4}\s+/i, "")
    .trim();
  const langPair = parseLangPair(answer.url);
  const showExamples = (max: number) =>
    first.examples.length > 0 ? (
      <div className="mt-2 space-y-1">
        {first.examples.slice(0, max).map((example, i) => (
          <p className="text-sm italic leading-relaxed text-ink-2" dir="auto" key={i}>
            “{example}”
          </p>
        ))}
      </div>
    ) : null;
  if (first.definitions.length === 0) {
    // pure translation (lingva, mymemory): the translated text is the hero,
    // alternatives and match examples follow
    return (
      <div>
        <div className="flex flex-wrap items-center gap-2">
          {langPair ? (
            <span className={MONO_CHIP} dir="ltr">
              {langPair.from}
              <ArrowRight className="size-3 shrink-0" />
              {langPair.to}
            </span>
          ) : null}
          {cleanQuery && cleanQuery !== first.text ? (
            <span className="min-w-0 truncate text-xs text-ink-3" dir="auto">
              {cleanQuery}
            </span>
          ) : null}
        </div>
        <p className="mt-2.5 text-xl font-medium leading-snug text-ink" dir="auto">
          {first.text}
        </p>
        {showExamples(3)}
        {rest.length > 0 ? (
          <div className="mt-3 space-y-2 border-t border-line pt-3">
            {rest.map((item, index) => (
              <div key={index}>
                <p className="text-sm font-medium text-ink" dir="auto">
                  {item.text}
                </p>
                {item.definitions.map((definition, i) => (
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-2" dir="auto" key={i}>
                    {definition}
                  </p>
                ))}
              </div>
            ))}
          </div>
        ) : null}
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
          <span className={CHIP}>{answer.engine}</span>
        </div>
      </div>
    );
  }
  const hasMore =
    first.definitions.length > 4 || rest.length > 0 || first.examples.length > 0 || first.synonyms.length > 0;
  return (
    <div>
      <p className="text-lg font-semibold text-ink" dir="auto">
        {cleanQuery ?? first.text}
        {first.transliteration ? (
          <span className="ms-2 text-sm font-normal text-ink-3">{first.transliteration}</span>
        ) : null}
      </p>
      {first.definitions.length > 0 ? (
        <ol className="mt-2 space-y-1.5">
          {first.definitions.slice(0, 4).map((definition, i) => (
            <li className="flex gap-2 text-sm leading-relaxed text-ink-2" key={i}>
              <span className="shrink-0 text-ink-3">{i + 1}.</span>
              <span dir="auto">{definition}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {showExamples(2)}
      {first.synonyms.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
          <span>{t("synonyms")}:</span>
          {first.synonyms.slice(0, 6).map((synonym) => (
            <span className={CHIP} dir="auto" key={synonym}>
              {synonym}
            </span>
          ))}
        </div>
      ) : null}
      {hasMore ? (
        <details className="group/def mt-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[13px] text-ink-3 transition-colors hover:text-ink">
            {t("definitions")}
            <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open/def:rotate-180" />
          </summary>
          <div className="mt-2 space-y-3">
            {first.definitions.length > 4 ? (
              <ol className="space-y-1.5" start={5}>
                {first.definitions.slice(4).map((definition, i) => (
                  <li className="flex gap-2 text-sm leading-relaxed text-ink-2" key={i}>
                    <span className="shrink-0 text-ink-3">{i + 5}.</span>
                    <span dir="auto">{definition}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            {rest.map((item, index) => (
              <div className="text-sm" key={index}>
                <p className="font-medium text-ink" dir="auto">
                  {item.text}
                  {item.transliteration ? (
                    <span className="ms-1.5 font-normal text-ink-3">{item.transliteration}</span>
                  ) : null}
                </p>
                {item.definitions.length > 0 ? (
                  <ol className="mt-1 space-y-1.5">
                    {item.definitions.map((definition, i) => (
                      <li className="flex gap-2 text-ink-2" key={i}>
                        <span className="shrink-0 text-ink-3">{i + 1}.</span>
                        <span dir="auto">{definition}</span>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            ))}
            {first.synonyms.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                <span>{t("synonyms")}:</span>
                {first.synonyms.slice(6).map((synonym) => (
                  <span className={CHIP} dir="auto" key={synonym}>
                    {synonym}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
      {answer.engine ? <p className="mt-2 text-xs text-ink-3">{answer.engine}</p> : null}
    </div>
  );
}
