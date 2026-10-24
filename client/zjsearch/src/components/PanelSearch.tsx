// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Search, X } from "lucide-react";
import type { KeyboardEvent } from "react";

/** The panel-scale filter box: the knowledge drawer's and the tag graph's
    search inputs share this exact anatomy (13px input in a bordered
    surface chip) -- one component so the sizing can never drift apart
    again (the 16px regression was the knowledge search reading a tier
    above its own panel).  Controlled: value + onChange from the caller. */
export function PanelSearch({
  ariaLabel,
  clearLabel,
  onChange,
  onClear,
  onKeyDown,
  placeholder,
  value,
}: {
  ariaLabel: string;
  /** the X button's label -- rendering it also REQUIRES onClear */
  clearLabel?: string;
  onChange: (value: string) => void;
  /** the caller's extra key handling (Escape clears, Enter focuses) -- the
      filter box forwards every key so the consumer owns its own semantics */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** the one-tap clear: renders the X inside the box when provided */
  onClear?: () => void;
  placeholder: string;
  value: string;
}) {
  const showClear = onClear !== undefined && value.length > 0;
  return (
    <div className="relative flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 transition-colors focus-within:border-accent">
      <Search aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
      <input
        aria-label={ariaLabel}
        className="h-6 w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        value={value}
      />
      {showClear ? (
        <button
          aria-label={clearLabel}
          className="absolute end-2 grid size-5 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          onClick={() => onClear?.()}
          title={clearLabel}
          type="button"
        >
          <X aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
