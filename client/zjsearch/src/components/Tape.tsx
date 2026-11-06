// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// Tape (DESIGN.md §7 family paper language): a translucent rectangle pressed
// over a torn-paper edge.  The decoration iron rules (aria-hidden +
// pointer-events-none) are baked into the TAPE fragment; the caller keeps
// width / opacity in className, and the tape must be a SIBLING of the
// clip-path element — inside it, the torn edge would cut the overhang.
// Composition tiers by paper width: full-width sheets take ONE top-center
// tape (`center`), medium notes take two tape corners, small slips take a
// single corner — and a corner already covered by another paper slip gets
// no tape at all (real walls rarely double-tape every note; a page of
// identical two-corner tapes reads stamped from one die).
// With a `seed` (a content string) the PLACEMENT varies deterministically
// per card — corner side, a few px of top/inset drift, a ±4..7° rotation —
// so a page of pinned cards never reads stamped from one die, while
// staying STABLE across re-renders (the physics contract: never random,
// never jittering).  The algorithm is DESIGN.md §7's canonical
// `tapePhysics` spec — the family's single authoritative definition;
// keep this implementation verbatim-identical to it.

import type { CSSProperties } from "react";

import { cn } from "@/lib/cn.ts";
import { TAPE } from "@/lib/styles.ts";

type TapeCorner = "start" | "end" | "center";

// DESIGN.md §7 tapePhysics — do not touch the constants; a spec change
// lands in DESIGN.md first, then both implementations together.
// Shifts must stay LOGICAL (`>>>`): about half of djb2 results are ≥ 2³¹,
// and the arithmetic shift `>>` sign-extends them through int32, producing
// negative offsets that drag inset / rotate out of the spec ranges
// (caught in the 2026-10 visual debugging pass — do not revert).
// `corner` picks the composition: `start`/`end` pin a corner (two-corner
// compositions assign left/right at the call site — the two tapes of one
// note seed differently so their drifts differ); `center` is the wide-sheet
// top-center build (translateX re-centers, then rotates; drift is only a
// ±12px hand-applied offset).
function tapePhysics(seed: string, corner?: TapeCorner): CSSProperties {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  const top = -(6 + (h % 4));
  const rotate = (h % 2 === 0 ? 1 : -1) * (4 + ((h >>> 4) % 4));
  if (corner === "center") {
    const drift = ((h >>> 6) % 5) * 6 - 12;
    return {
      left: `calc(50% + ${drift}px)`,
      top: `${top}px`,
      transform: `translateX(-50%) rotate(${rotate}deg)`,
    };
  }
  const inset = 24 + ((h >>> 2) % 5) * 4;
  const side = corner ?? (h % 2 === 0 ? "start" : "end");
  return side === "start"
    ? { insetInlineStart: `${inset}px`, top: `${top}px`, transform: `rotate(${rotate}deg)` }
    : { insetInlineEnd: `${inset}px`, top: `${top}px`, transform: `rotate(${rotate}deg)` };
}

export function Tape({
  className,
  seed,
  corner,
}: {
  className?: string;
  seed?: string;
  /** composition: `start`/`end` pin a corner (two-corner compositions assign
      left/right at the call site); `center` pins top-center; omitted, the
      corner side follows the seed */
  corner?: TapeCorner;
}) {
  return (
    <span aria-hidden="true" className={cn(TAPE, className)} style={seed ? tapePhysics(seed, corner) : undefined} />
  );
}
