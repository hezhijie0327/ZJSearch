// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { SVGProps } from "react";

/** Hand-drawn onion (Tor's mascot) — lucide ships no onion, so this follows
    the lucide stroke language instead: 24px grid, 2px round strokes,
    currentColor (same exception as the hand-drawn BrandMark). */
export function OnionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      {...props}
    >
      <path d="M12 7c3.6 2.4 5.5 5.1 5.5 8a5.5 5.5 0 0 1-11 0C6.5 12.1 8.4 9.4 12 7Z" />
      <path d="M12 7V4.5" />
      <path d="M12 4.5C11.3 2.9 10 2 8.3 2c.2 1.7 1.6 2.8 3.7 3" />
      <path d="M12 4.5c.7-1.6 2-2.5 3.7-2.5-.2 1.7-1.6 2.8-3.7 3" />
      <path d="M9.2 13.5c0 2 1.2 3.6 2.8 4.2" />
      <path d="M14.8 13.5c0 2-1.2 3.6-2.8 4.2" />
    </svg>
  );
}
