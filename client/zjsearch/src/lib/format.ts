// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Client side formatting helpers (dates, durations, response times). */

const DAY_MS = 86_400_000;

// the formatters are locale-less (runtime default) — build them once instead
// of per result meta line (a full page renders ~100 meta lines)
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const absoluteFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Relative date for recent timestamps, locale date otherwise.
    Future timestamps (sloppy engine metadata) get the absolute date too. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const diff = Date.now() - date.getTime();
  if (diff < 0) {
    return absoluteFormat.format(date);
  }
  if (diff < DAY_MS) {
    return relativeFormat.format(-Math.round(diff / 3_600_000), "hour");
  }
  if (diff < 30 * DAY_MS) {
    return relativeFormat.format(-Math.round(diff / DAY_MS), "day");
  }
  if (diff < 365 * DAY_MS) {
    return relativeFormat.format(-Math.round(diff / (30 * DAY_MS)), "month");
  }
  return absoluteFormat.format(date);
}

/** h:mm:ss / m:ss player clock for in-tile audio positions; a non-finite
    or negative position (stream without duration metadata) reads "--:--". */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

/** Video/audio duration: passthrough display string or seconds -> h:mm:ss. */
export function formatLength(lengthDisplay: string | undefined, lengthSeconds: number | undefined): string | null {
  if (lengthDisplay) {
    return lengthDisplay;
  }
  if (lengthSeconds === undefined || lengthSeconds <= 0) {
    return null;
  }
  return formatClock(lengthSeconds);
}

/** Result relevance score, one decimal (e.g. "3.5"). */
export function formatScore(score: number): string {
  return round1(score).toFixed(1);
}

/** Round to one decimal — the display tier for response times and per-result
    scores across the meta line, stats page and engine tables. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Capitalise the first letter (option labels, condition names). */
export function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Accessible alt text for a result thumbnail: the engine-provided title
    when it is non-empty, else a decoded URL filename — image results often
    carry an empty title and an empty alt leaves the wrapping button/link
    without an accessible name (Lighthouse button-name / link-name). */
export function imageAlt(result: { title_text: string; url: string }): string {
  const title = result.title_text.trim();
  if (title) {
    return title;
  }
  try {
    const file = decodeURIComponent(new URL(result.url).pathname.split("/").pop() ?? "");
    if (file) {
      return file;
    }
  } catch {
    // malformed result URL — fall through to the URL itself
  }
  return result.url;
}
