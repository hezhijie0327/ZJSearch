import { type CardProps, EnginesLine, PrettyUrl, ResultArticle, Title } from "@/features/results/cardParts.tsx";
import { useT } from "@/lib/i18n.ts";

export function CodeCard({ result, globals }: CardProps) {
  const t = useT();
  return (
    <ResultArticle priority={result.priority}>
      <PrettyUrl globals={globals} result={result} />
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
        <Title globals={globals} result={result} />
        {result.filename ? (
          <span className="text-xs text-ink-3">
            {t("filename")}: <code className="break-all font-mono">{result.filename}</code>
          </span>
        ) : null}
      </div>
      {result.repository ? (
        <p className="mt-1 text-xs text-ink-3">
          {t("repository")}:{" "}
          <a
            className="break-all text-accent hover:underline"
            href={result.repository}
            rel="noreferrer"
            target="_blank"
          >
            {result.repository}
          </a>
        </p>
      ) : null}
      {result.content_html ? (
        <p
          className="mt-1.5 line-clamp-2 max-w-prose text-sm leading-relaxed text-ink-2"
          dangerouslySetInnerHTML={{ __html: result.content_html }}
          dir="auto"
        />
      ) : null}
      {result.code_html ? (
        <pre
          className="mt-2 max-h-96 overflow-auto rounded-xl border border-line bg-surface-2 p-4 font-mono text-xs leading-relaxed"
          dangerouslySetInnerHTML={{ __html: result.code_html }}
          dir="ltr"
        />
      ) : null}
      <EnginesLine result={result} />
    </ResultArticle>
  );
}
