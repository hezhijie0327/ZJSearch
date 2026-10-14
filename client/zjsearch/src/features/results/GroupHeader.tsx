// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChevronDown } from "lucide-react";
import { CategoryIcon } from "@/components/CategoryIcon.tsx";

/** Collapsible block header: category icon + translated label + result
    count; the whole header toggles the block. */
export function GroupHeader({
  category,
  label,
  count,
  collapsed,
  onToggle,
}: {
  category: string;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <h2 className="group flex items-center gap-1 pb-1 pt-2">
      <button
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-base font-semibold text-ink"
        onClick={onToggle}
        type="button"
      >
        <CategoryIcon category={category} className="size-3.5 shrink-0 text-accent" />
        {label}
        <span className="font-normal text-ink-3">{count}</span>
        <ChevronDown className={`size-3.5 shrink-0 text-ink-3 transition-transform ${collapsed ? "rotate-180" : ""}`} />
      </button>
    </h2>
  );
}
