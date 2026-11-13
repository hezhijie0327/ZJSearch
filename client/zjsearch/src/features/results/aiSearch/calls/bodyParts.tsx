// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { useCopyToast } from "@/lib/clipboard.ts";
import type { Translate } from "@/lib/i18n.ts";
import { CHIP_HOVER, MONO_CHIP } from "@/lib/styles.ts";

/**
 * The tool-row BODY's shared parts (the search_web result-card standard
 * at body scale) -- ONE home, reused everywhere; a new list-shaped body
 * composes these instead of re-typing grounds (the drift this pass
 * closed: six views had hand-rolled the same structures).
 */

/** One item card on the body ground: the search_web result card's
    elevation at list scale -- items are OBJECTS on the box, never text
    lines on a slab. */
export function BodyRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`min-w-0 rounded-md bg-surface-2/60 px-2.5 py-2 ${className}`}>{children}</div>;
}

/** A full-precision copyable value (the hash/ip answer vocabulary): the
    mono value + one copy chip -- a computed figure or unbreakable
    payload is something the reader takes elsewhere. */
export function CopyValue({ value, t }: { value: string; t: Translate }) {
  const copyToast = useCopyToast();
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-1.5 rounded-md bg-surface-2/60 px-2.5 py-2`}>
      <span className="min-w-0 break-all font-mono text-sm text-ink" dir="auto">
        {value}
      </span>
      <button
        aria-label={t("copy")}
        className={`${MONO_CHIP} cursor-pointer ${CHIP_HOVER}`}
        onClick={() => {
          copyToast(value);
        }}
        title={t("copy")}
        type="button"
      >
        <Copy aria-hidden="true" className="size-3" />
      </button>
    </div>
  );
}

/** The inventory DIRECTORY GRID (list_engines' categories, the calendar
    terms -- one grid language for every "name [+ count] inventory"):
    each entry its own elevated cell, left-aligned, the same auto-fill
    columns; `trailing` rides the right edge (a count, a badge). */
export function DirectoryGrid({
  entries,
}: {
  entries: Array<{ key: string; label: string; title?: string; trailing?: ReactNode }>;
}) {
  return (
    <div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1">
      {entries.map((entry) => (
        <div
          className="flex min-w-0 items-baseline justify-between gap-2 rounded-md bg-surface-2/60 px-2 py-1"
          key={entry.key}
          title={entry.title}
        >
          <span className="min-w-0 truncate text-xs text-ink-2" dir="auto">
            {entry.label}
          </span>
          {entry.trailing ? <span className="shrink-0 text-xs tabular-nums text-ink-3">{entry.trailing}</span> : null}
        </div>
      ))}
    </div>
  );
}
