import { type CardProps, EnginesLine, ResultArticle } from "@/features/results/cardParts.tsx";

/** Key/value table card (keyvalue.html): a captioned two-column table for
    structured data answers. */

export function KeyValueCard({ result }: CardProps) {
  return (
    <ResultArticle priority={result.priority}>
      <div className="overflow-hidden rounded-2xl border border-line">
        {/* table-fixed keeps long unbreakable cells from widening (and the
            overflow-hidden wrapper from silently clipping) the table */}
        <table className="w-full table-fixed text-sm">
          {result.caption ? (
            <caption className="bg-surface-2 px-4 py-2 text-left font-medium">{result.caption}</caption>
          ) : null}
          {result.key_title || result.value_title ? (
            <thead>
              <tr className="bg-surface-2 text-xs text-ink-2">
                <th className="px-4 py-2 text-left font-medium" scope="col">
                  {result.key_title}
                </th>
                <th className="px-4 py-2 text-left font-medium" scope="col">
                  {result.value_title}
                </th>
              </tr>
            </thead>
          ) : null}
          <tbody>
            {Object.entries(result.kvmap ?? {}).map(([key, value], index) => (
              <tr className={index % 2 === 0 ? "bg-surface" : "bg-bg/60"} key={key}>
                <th className="break-all px-4 py-1.5 text-left align-top font-medium text-ink-2" scope="row">
                  {key}
                </th>
                <td className="break-all px-4 py-1.5 align-top text-ink">{String(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <EnginesLine result={result} />
    </ResultArticle>
  );
}
