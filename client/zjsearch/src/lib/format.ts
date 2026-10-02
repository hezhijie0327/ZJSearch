// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Client side formatting helpers (dates, durations, response times). */

const DAY_MS = 86_400_000;

// the formatters rebuild once per LOCALE CHANGE (not per call — a full
// page renders ~100 meta lines); the i18n runtime pins the locale on
// boot, so the dates speak the UI's language instead of the browser's
let dateLocale: string | undefined;
let relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
let absoluteFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Called by the i18n runtime on boot + locale changes. */
export function setDateFormatLocale(locale: string): void {
  if (locale === dateLocale) {
    return;
  }
  dateLocale = locale;
  relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  absoluteFormat = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" });
}

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

/** Compact token-count tier for the AI run stats (980 → "980",
    12_300 → "12.3k", 1_250_000 → "1.3M"). */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${round1(count / 1_000_000)}M`;
  }
  if (count >= 1000) {
    return `${round1(count / 1000)}k`;
  }
  return String(count);
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

/** Filesize display: passthrough when the engine already humanized it,
    raw byte counts get IEC units (files/torrents come both ways). */
export function formatFilesize(size: string | number | undefined): string | null {
  if (size === undefined || size === "") {
    return null;
  }
  if (typeof size === "string") {
    return size;
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : round1(value)} ${units[unit]}`;
}
