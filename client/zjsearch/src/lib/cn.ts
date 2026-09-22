// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { type ClassValue, clsx } from "clsx";

/** Family-shared class joiner (DESIGN.md §12): conditional and fragment
    class names in one call — `cn(FRAGMENT, cond && "extra", className)`. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(...inputs);
}
