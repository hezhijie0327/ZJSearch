// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// The empty/final state's paper ground (DESIGN.md §7 + the AGENTS.md
// empty-state contract): icon disc, heading, one muted line, ONE action —
// on a torn `.paper-note` pinned by two tape corners.  The tape is a
// SIBLING of the clipped note and the micro-tilt is fixed, never random.

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Tape } from "@/components/Tape.tsx";
import { cn } from "@/lib/cn.ts";

export function PaperEmpty({
  icon: Icon,
  line,
  hint,
  title,
  children,
  className,
  headingTag = "h2",
}: {
  icon: LucideIcon;
  title: ReactNode;
  /** the one muted line under the heading */
  line?: ReactNode;
  /** a tertiary hint below the action (smaller, quieter) */
  hint?: ReactNode;
  /** the ONE action slot (buttons/links render centred) */
  children?: ReactNode;
  className?: string;
  /** "h1" for pages whose ONLY heading lives on the note (thread-not-found);
      the default h2 keeps every other empty state out of the outline race */
  headingTag?: "h1" | "h2";
}) {
  const Heading = headingTag;
  return (
    <div className={cn("mx-auto max-w-lg py-10 animate-fade-up", className)}>
      <div className="-rotate-[0.35deg]">
        <Tape className="-top-2.5 left-10 w-24 -rotate-6 bg-accent-soft/80" />
        <Tape className="-top-2.5 right-10 w-20 rotate-[5deg] bg-accent-soft/60" />
        <div className="paper-note px-6 py-8 text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
            <Icon aria-hidden="true" className="size-7" />
          </span>
          <Heading className="mt-4 text-xl font-semibold tracking-tight text-ink">{title}</Heading>
          {line ? <p className="mt-1.5 text-sm text-ink-2">{line}</p> : null}
          {children ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
          {hint ? <p className="mt-3 text-[13px] text-ink-3">{hint}</p> : null}
        </div>
      </div>
    </div>
  );
}
