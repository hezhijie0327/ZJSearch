// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { type ReactNode, useState } from "react";
import { CAP_CHIP_CLASS, CapChip } from "@/components/CapChip.tsx";
import { Collapse } from "@/components/Collapse.tsx";

/**
 * The CAP-AND-EXPAND list, ONE component: the head items render, the
 * OLDER tail sits inside a Collapse (the +N reveal is a height
 * animation, never a swap -- the rail's contract) and the CapChip rides
 * below.  Eight views hand-wired the slice + Collapse + CapChip trio
 * before this; a new capped list composes it instead.
 *
 * The cap STATE stays the CALLER's where a citation click must force
 * the list open (the run section owns the rail's states) -- pass
 * `expanded` + `onToggle(next)`; pass only `onToggle` (or neither) and
 * the list owns a plain boolean.  `reverse` renders the NEWEST-first
 * convention (head = the last `cap` items) without the caller slicing.
 */
export function CapList<T>({
  items,
  renderItem,
  cap = 4,
  expanded,
  onToggle,
  reverse = false,
  headClassName = "",
  tailClassName = "",
  chipClassName = CAP_CHIP_CLASS,
}: {
  items: T[];
  /** the second arg is the item's index in the ORIGINAL array */
  renderItem: (item: T, index: number) => ReactNode;
  cap?: number;
  expanded?: boolean;
  onToggle?: (next: boolean) => void;
  /** newest-first: the head shows the LAST `cap` items, the tail the rest */
  reverse?: boolean;
  headClassName?: string;
  tailClassName?: string;
  chipClassName?: string;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const isControlled = onToggle !== undefined;
  const open = isControlled ? Boolean(expanded) : ownOpen;
  const setOpen = (next: boolean) => (isControlled ? onToggle?.(next) : setOwnOpen(next));
  const hidden = Math.max(0, items.length - cap);
  const ordered = reverse ? [...items].reverse() : items;
  const shown = ordered.slice(0, cap);
  const tail = ordered.slice(cap);
  // the ORIGINAL index (the keyed/open-state consumers' identity -- a
  // reversed VIEW must not renumber the items)
  const origin = (item: T) => items.indexOf(item);
  return (
    <>
      <div className={headClassName}>{shown.map((item) => renderItem(item, origin(item)))}</div>
      <Collapse className={open && tail.length > 0 ? tailClassName : ""} open={open} unmountAfterHide>
        <div className={tailClassName}>{tail.map((item) => renderItem(item, origin(item)))}</div>
      </Collapse>
      {hidden > 0 ? (
        <CapChip className={chipClassName} expanded={open} hidden={hidden} onToggle={() => setOpen(!open)} />
      ) : null}
    </>
  );
}
