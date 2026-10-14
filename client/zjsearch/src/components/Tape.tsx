// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// Tape (DESIGN.md §7 family paper language): a translucent rectangle pressed
// over a torn-paper edge.  The decoration iron rules (aria-hidden +
// pointer-events-none) are baked into the TAPE fragment; the caller keeps
// width / opacity in className, and the tape must be a SIBLING of the
// clip-path element — inside it, the torn edge would cut the overhang.
// With a `seed` (a content string) the PLACEMENT varies deterministically
// per card — corner side, a few px of top/inset drift, a ±4..7° rotation —
// so a page of pinned cards never reads stamped from one die, while
// staying STABLE across re-renders (the physics contract: never random,
// never jittering).

import type { CSSProperties } from "react";

import { cn } from "@/lib/cn.ts";
import { TAPE } from "@/lib/styles.ts";

function tapePhysics(seed: string): CSSProperties {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  const top = -(6 + (h % 4));
  const inset = 24 + ((h >> 2) % 5) * 4;
  const rotate = (h % 2 === 0 ? 1 : -1) * (4 + ((h >> 4) % 4));
  return h % 2 === 0
    ? { insetInlineStart: `${inset}px`, top: `${top}px`, transform: `rotate(${rotate}deg)` }
    : { insetInlineEnd: `${inset}px`, top: `${top}px`, transform: `rotate(${rotate}deg)` };
}

export function Tape({ className, seed }: { className?: string; seed?: string }) {
  return <span aria-hidden="true" className={cn(TAPE, className)} style={seed ? tapePhysics(seed) : undefined} />;
}
