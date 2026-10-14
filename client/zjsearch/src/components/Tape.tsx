// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// Tape (DESIGN.md §7 family paper language): a translucent rectangle pressed
// over a torn-paper edge.  The decoration iron rules (aria-hidden +
// pointer-events-none) are baked into the TAPE fragment; positioning /
// rotation / opacity are the caller's, and the tape must be a SIBLING of the
// clip-path element — inside it, the torn edge would cut the overhang.

import { cn } from "@/lib/cn.ts";
import { TAPE } from "@/lib/styles.ts";

export function Tape({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn(TAPE, className)} />;
}
