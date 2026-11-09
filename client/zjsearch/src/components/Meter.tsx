// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Proportion bar on a surface-2 track — result counts (stats page), engine
 * timings (meta-line engine strip, engine tables). The track's size and the
 * fill colour come from the caller so tables and tiles keep their rhythm;
 * a non-positive max renders nothing (no data to proportion against).
 */
export function Meter({
  value,
  max,
  trackClassName = "h-1.5 w-24",
  fillClassName = "bg-accent",
}: {
  value: number;
  max: number;
  /** Tailwind classes for the track: height + width (fixed or flex-1) */
  trackClassName?: string;
  fillClassName?: string;
}) {
  if (max <= 0) {
    return null;
  }
  return (
    <span className={`${trackClassName} overflow-hidden rounded-full bg-surface-2`}>
      <span
        className={`block h-full rounded-full ${fillClassName}`}
        style={{ width: `${Math.max(2, Math.min(100, (value / max) * 100))}%` }}
      />
    </span>
  );
}
