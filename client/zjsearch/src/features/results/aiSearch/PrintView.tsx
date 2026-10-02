// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useEffect } from "react";
import type { AiSearchRun } from "@/features/results/aiSearch/useAiSearch.ts";
import { printDocument } from "@/lib/print.ts";

/** The dedicated print view: clicking 📄 IMMEDIATELY builds the print
    document (the wordmark, the question, the rendered answer with the
    research box and chrome stripped, the numbered sources expanded at the
    tail) and opens the browser's print dialog — the whole pipeline lives
    in lib/print.ts; this wrapper only points it at the run's rendered
    section. */
export function PrintView({ onClose, run }: { onClose: () => void; run: AiSearchRun }) {
  useEffect(() => {
    const source = document.getElementById(`ai-run-${run.runNo}`);
    if (!source) {
      onClose();
      return undefined;
    }
    const dispose = printDocument({
      title: run.q || "thread",
      fileTag: (/\/ai\/thread\/([\w-]+)/.exec(window.location.pathname)?.[1] ?? "").slice(0, 8),
      source,
      sources: run.sources.slice(0, 30).map((item, index) => ({
        n: item.n || index + 1,
        title: item.title || item.url,
        netloc: item.netloc || item.url,
      })),
    });
    return dispose;
    // onClose is stable (a useCallback in the section); run identifies the view
  }, [run, onClose]);

  return null;
}
