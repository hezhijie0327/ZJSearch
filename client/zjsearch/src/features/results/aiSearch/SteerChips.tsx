// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { X } from "lucide-react";
import type { AiSteerChip } from "@/features/results/aiSearch/useAiSteer.ts";
import { useT } from "@/lib/i18n.ts";

/** The pending-steer chips under the AI composer (drained chips retire
    from `useAiSteer` on their own; what renders here is what is still
    queued or failed).  This block lived byte-for-byte in BOTH AI entry
    points (ResultsPage + AiThreadPage) and the dismiss glyph had already
    drifted to a literal `×` against the icon law -- one component owns
    it now. */
export function SteerChips({ chips, onRetract }: { chips: AiSteerChip[]; onRetract: (text: string) => void }) {
  const t = useT();
  if (!chips.length) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span
          className={`inline-flex max-w-[18rem] items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
            chip.state === "failed" ? "border-danger/50 text-danger" : "border-line bg-surface-2/50 text-ink-2"
          }`}
          key={chip.text}
        >
          <span className="truncate" dir="auto">
            {chip.text}
          </span>
          {chip.state === "failed" ? <span>{t("ai_steer_failed")}</span> : null}
          <button
            aria-label={t("remove")}
            className="text-ink-3 transition-colors hover:text-danger"
            onClick={() => {
              onRetract(chip.text);
            }}
            type="button"
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
