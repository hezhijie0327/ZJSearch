// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { StringKey } from "@/lib/i18n.ts";

/** The weekday label table: the ONE home of the `getDay()` (0 = Sunday)
    -> `weekday_*` catalog key mapping, shared by every weekday label
    (the AI clock row, the weather strip).  The theme owns the language
    through its catalogs -- NOT Intl, whose output drifts with the raw
    browser locale (a zh-HK/zh-SG browser would get English weekdays
    while every catalog string around it speaks Chinese). */

const WEEKDAY_KEYS: ReadonlyArray<StringKey> = [
  "weekday_sun",
  "weekday_mon",
  "weekday_tue",
  "weekday_wed",
  "weekday_thu",
  "weekday_fri",
  "weekday_sat",
];

/** The `weekday_*` catalog key for one ISO date, or null when malformed.
    Parsed by COMPONENTS, not `new Date(iso)`: a date-only string reads
    as UTC midnight there and a negative-offset zone would show
    yesterday. */
export function weekdayKey(iso: string): StringKey | null {
  const [y = NaN, m = NaN, d = NaN] = iso.slice(0, 10).split("-").map(Number);
  if (![y, m, d].every(Number.isFinite)) {
    return null;
  }
  return WEEKDAY_KEYS[new Date(y, m - 1, d).getDay()] ?? null;
}
