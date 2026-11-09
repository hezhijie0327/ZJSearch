// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { ComponentType, ReactNode } from "react";

/**
 * The AI run rail's ONE section language: icon + title + count header
 * over a body.  Six cards were hand-rolling this chrome (one of them
 * with a drifted flex-wrap) -- the header lives here now, so the rail's
 * sections can only drift in their bodies.
 */

export function RailHeader({
  icon: Icon,
  title,
  count,
  trailing,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  title: string;
  count?: string | number;
  /** extra live content pinned to the row's end (the browser card's
      countdown + done chip ride it) */
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-1">
      <Icon aria-hidden="true" className="size-4.5 shrink-0 text-ink-3" />
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {count !== undefined && count !== "" ? (
        <span className="shrink-0 text-xs tabular-nums text-ink-3">{count}</span>
      ) : null}
      {trailing}
    </div>
  );
}
