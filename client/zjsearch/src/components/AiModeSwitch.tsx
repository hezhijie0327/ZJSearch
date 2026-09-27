// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Sparkles } from "lucide-react";
import { useT } from "@/lib/i18n.ts";
import { SEGMENT_ACTIVE, SEGMENT_IDLE, SEGMENT_SM } from "@/lib/styles.ts";

/**
 * The [classic|AI] search-mode switch (hero + results header).  Rendered
 * only when the page-data carries the `ai_search` capability; the choice
 * rides along with every search as the `ai` URL/body flag.
 */
export function AiModeSwitch({ ai, onChange }: { ai: boolean; onChange: (ai: boolean) => void }) {
  const t = useT();
  const option = (label: string, active: boolean, onSelect: () => void, sparkle: boolean) => (
    <button
      aria-checked={active}
      className={`${SEGMENT_SM} ${active ? SEGMENT_ACTIVE : SEGMENT_IDLE}`}
      onClick={onSelect}
      role="radio"
      type="button"
    >
      {sparkle ? <Sparkles aria-hidden="true" className="size-3.5" /> : null}
      {label}
    </button>
  );
  return (
    <div
      aria-label={t("search_mode")}
      className="inline-flex items-center rounded-xl bg-surface-2/70 p-0.5"
      role="radiogroup"
    >
      {option(t("mode_classic"), !ai, () => onChange(false), false)}
      {option(t("mode_ai"), ai, () => onChange(true), true)}
    </div>
  );
}
