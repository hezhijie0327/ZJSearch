// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import type { SortState } from "@/lib/tableSort.ts";

/** Sortable-table header button: label + direction arrow while the column is
    the active sort.  Pair the `<th>` with `aria-sort` on the caller side. */
export function SortHeader<K extends string>({
  label,
  columnKey,
  sort,
  onCycle,
}: {
  label: ReactNode;
  columnKey: K;
  sort: SortState<K>;
  onCycle: (key: K) => void;
}) {
  const active = sort.key === columnKey;
  return (
    <button
      className="inline-flex items-center gap-1 transition-colors hover:text-ink"
      onClick={() => {
        onCycle(columnKey);
      }}
      type="button"
    >
      {label}
      {active ? (
        <span aria-hidden="true" className="inline-flex">
          {sort.asc ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
        </span>
      ) : null}
    </button>
  );
}
