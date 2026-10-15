// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { lazy, Suspense } from "react";
import { Shell } from "@/components/Shell.tsx";
import type { AiOverviewDebugPageData } from "@/lib/types.ts";

// the stage lazy-loads with its fixture catalog (QA-only data that must
// not ride any real page's chunk)
const AiOverviewDebugStage = lazy(() =>
  import("@/features/results/aiSearch/AiDebugStage.tsx").then((m) => ({ default: m.AiOverviewDebugStage })),
);

/** The AI Overview debug stage's host (`/zjsearch/ai/overview/debug`):
    the card's real habitat is the results column, so the main keeps the
    results page's reading measure while the fixture streams replay
    through the real renderer. */
export function OverviewDebugPage({ data }: { data: AiOverviewDebugPageData }) {
  return (
    <Shell globals={data.globals}>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-6 sm:px-6">
        <Suspense
          fallback={
            <div aria-busy="true" className="mt-4 space-y-5">
              <span className="zjs-skeleton block h-9 w-72 max-w-full" />
              <span className="zjs-skeleton block h-24 w-full" />
            </div>
          }
        >
          <AiOverviewDebugStage />
        </Suspense>
      </main>
    </Shell>
  );
}
