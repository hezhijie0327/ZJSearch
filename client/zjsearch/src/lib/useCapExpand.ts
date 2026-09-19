// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useState } from "react";

/**
 * The app-wide cap-and-expand contract for chip rows (EnginesLine "+N",
 * paper/package tags, weather sources): show the first `cap` items until
 * toggled, then everything plus a 「show less」 affordance. Callers render
 * the chips themselves (CHIP/MONO_CHIP constants) so each row keeps its own
 * layout; this only owns the visibility state machine.
 */
export function useCapExpand(total: number, cap: number) {
  const [expanded, setExpanded] = useState(false);
  return {
    expanded,
    toggle: () => {
      setExpanded((value) => !value);
    },
    /** items to render before expanding */
    shown: expanded ? total : cap,
    hidden: Math.max(0, total - cap),
  };
}
