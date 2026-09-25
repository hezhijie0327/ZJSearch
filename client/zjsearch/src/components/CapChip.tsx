// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronLeft } from "lucide-react";
import { useT } from "@/lib/i18n.ts";

/**
 * The one "+N ⇄ ‹ show less" chip for cap-and-expand rows (EnginesLine,
 * package/paper tags, weather sources) — pairs with `useCapExpand`, which
 * owns the visibility state machine while callers render their own chips.
 * Pass the chip classes; the expanded branch keeps them so the toggle never
 * changes shape mid-row.
 */
export function CapChip({
  className,
  expanded,
  hidden,
  onToggle,
  title,
}: {
  className: string;
  expanded: boolean;
  /** how many entries the cap hides — the chip renders nothing at 0 */
  hidden: number;
  onToggle: () => void;
  title?: string;
}) {
  const t = useT();
  if (hidden <= 0) {
    return null;
  }
  return (
    <button aria-expanded={expanded} className={className} onClick={onToggle} title={title} type="button">
      {expanded ? (
        <>
          <ChevronLeft className="size-3 shrink-0" />
          {t("show_less")}
        </>
      ) : (
        `+${hidden}`
      )}
    </button>
  );
}
