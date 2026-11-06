// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useCallback, useState } from "react";

export interface SortState<K extends string> {
  key: K | null;
  asc: boolean;
}

/** Shared sortable-table state.  Clicking a column header cycles
    none → ascending → descending → none, so every table keeps a way back to
    its natural order. */
export function useSortState<K extends string>(initial: SortState<K> = { key: null, asc: true }) {
  const [sort, setSort] = useState<SortState<K>>(initial);
  const cycleSort = useCallback((key: K) => {
    setSort(({ key: current, asc }) => {
      if (current !== key) {
        return { key, asc: true };
      }
      return asc ? { key, asc: false } : { key: null, asc: true };
    });
  }, []);
  return { sort, cycleSort };
}
