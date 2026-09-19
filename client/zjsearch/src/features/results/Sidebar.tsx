// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Results right rail: knowledge (infoboxes) and diagnostics-only extras.
 * In POST mode it also offers the shareable search URL, since the query
 * never reaches the address bar there.
 */

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { ClickToCopy } from "@/components/CopyButton.tsx";
import { Infobox } from "@/features/results/Infobox.tsx";
import { useT } from "@/lib/i18n.ts";
import { shareableSearchUrl } from "@/lib/searchParams.ts";
import type { SearchPageData } from "@/lib/types.ts";

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface">
      {/* same ChevronDown disclosure language as every other collapsible in
          the app — the browser-default triangle is suppressed */}
      <details className="group">
        <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-2 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-3 transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
          {title}
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 transition-transform group-open:rotate-180" />
        </summary>
        <div className="px-4 pb-3">{children}</div>
      </details>
    </section>
  );
}

export function Sidebar({ data, onSearch }: { data: SearchPageData; onSearch: (q: string) => void }) {
  const t = useT();
  const globals = data.globals;
  const hasInfobox = data.infoboxes.length > 0;
  // POST mode keeps the query out of the address bar, so the sidebar offers
  // the shareable URL reconstructed from the current search (upstream parity)
  const searchUrl = shareableSearchUrl(data);

  return (
    <aside className="flex flex-col gap-3">
      {hasInfobox ? (
        <section aria-label={t("info")} className="flex flex-col gap-3">
          {data.infoboxes.map((infobox) => (
            <Infobox globals={globals} infobox={infobox} key={infobox.title} onSearch={onSearch} />
          ))}
        </section>
      ) : null}

      {globals.method === "POST" ? (
        <Box title={t("search_url")}>
          <ClickToCopy value={searchUrl}>
            <pre
              className="min-w-0 overflow-x-auto rounded-xl bg-surface-2 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-ink-2"
              dir="ltr"
            >
              {searchUrl}
            </pre>
          </ClickToCopy>
        </Box>
      ) : null}
    </aside>
  );
}
