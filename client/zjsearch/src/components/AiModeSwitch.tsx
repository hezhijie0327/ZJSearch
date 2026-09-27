// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Search, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n.ts";

/**
 * The [classic|AI] search-mode switch (hero + results header), morphic's
 * icon-only circles: the active mode is a raised surface circle with an
 * accent icon, the inactive one a muted icon.  Rendered only when the
 * page-data carries the `ai_search` capability; the choice rides along
 * with every search as the `ai` URL/body flag.
 */
export function AiModeSwitch({ ai, onChange }: { ai: boolean; onChange: (ai: boolean) => void }) {
  const t = useT();
  const option = (label: string, active: boolean, onSelect: () => void, icon: ReactNode) => (
    <button
      aria-checked={active}
      aria-label={label}
      className={`grid size-9 place-items-center rounded-full transition-colors ${
        active ? "bg-surface text-accent shadow-card" : "text-ink-3 hover:text-ink"
      }`}
      onClick={onSelect}
      role="radio"
      title={label}
      type="button"
    >
      {icon}
    </button>
  );
  return (
    <div
      aria-label={t("search_mode")}
      className="inline-flex items-center gap-1 rounded-full bg-surface-2/70 p-1"
      role="radiogroup"
    >
      {option(t("mode_classic"), !ai, () => onChange(false), <Search aria-hidden="true" className="size-4" />)}
      {option(t("mode_ai"), ai, () => onChange(true), <Sparkles aria-hidden="true" className="size-4" />)}
    </div>
  );
}
