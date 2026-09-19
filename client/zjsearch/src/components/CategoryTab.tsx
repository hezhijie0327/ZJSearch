// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { MouseEvent } from "react";
import { CategoryIcon } from "@/components/CategoryIcon.tsx";

/** One category tab (icon + label): selected = accent text with the amber
    underline.  The results-page tab row, the hero grid, the preferences
    default-categories and the engine tabs all render through this component
    so the tab language can never drift between pages. */
export function CategoryTab({
  category,
  label,
  selected,
  onClick,
  className = "",
  title,
}: {
  category: string;
  label: string;
  selected: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  title?: string;
}) {
  return (
    <button
      aria-pressed={selected}
      className={`relative flex shrink-0 items-center gap-1.5 px-4 py-2 text-[13px] transition-colors ${
        selected ? "font-medium text-accent" : "text-ink-2 hover:text-ink"
      } ${className}`}
      onClick={onClick}
      title={title}
      type="button"
    >
      <CategoryIcon category={category} className="size-3.5 shrink-0" />
      <span>{label}</span>
      <span
        aria-hidden="true"
        className={`absolute inset-x-4 -bottom-0.5 h-0.5 rounded-full bg-accent-strong transition-opacity ${
          selected ? "opacity-100" : "opacity-0"
        }`}
      />
    </button>
  );
}
