// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { ReactNode } from "react";

/** The panel furniture shared by the slide-in panels (preferences,
    knowledge, stats): sectioned cards, section bands and the icon-tile
    setting rows.  One source of truth -- tuning a radius or a hover tint
    here retunes every panel at once. */

export function IconTile({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">{children}</span>
  );
}

/** One settings row: icon tile + title/description on the left, control on the right. */
export function SettingRow({
  icon,
  title,
  description,
  children,
  stacked,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="px-5 py-5 transition-colors hover:bg-surface-2/40 sm:px-6">
        <div className="flex items-center gap-4">
          <IconTile>{icon}</IconTile>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{title}</p>
            {description ? <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{description}</p> : null}
          </div>
        </div>
        {children ? <div className="mt-4 sm:pl-14">{children}</div> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 px-5 py-5 transition-colors hover:bg-surface-2/40 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:px-6">
      <div className="flex min-w-0 items-center gap-4">
        <IconTile>{icon}</IconTile>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{title}</p>
          {description ? <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{description}</p> : null}
        </div>
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface animate-fade-up">
      {children}
    </div>
  );
}

/** Section header inside a Card — Card's divide-y draws the separators, so a
    Fragment of header + rows works as one group. */
export function SectionLabel({ label }: { label: string }) {
  return <p className="bg-surface-2/60 px-5 py-2.5 text-xs font-medium text-ink-3 sm:px-6">{label}</p>;
}
