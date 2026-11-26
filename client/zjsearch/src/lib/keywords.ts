// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge base's keyword/text helpers: the CJK-aware keyword
    segmentation behind the recall's tsquery columns and the stable
    url hash that keys the dedup.  Pure functions -- no store.
    (Split out of lib/pg.ts: they are text policy, not the engine.) */

const SEGMENT_RE = /[a-z0-9_]+|[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f]/g;

/** NFD-decomposable accents strip with the combining marks; the map
    catches what NFD leaves alone (compatibility forms and letters
    without a canonical decomposition). */
const FOLD_MAP: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ł: "l",
  ð: "d",
  þ: "th",
};
const FOLD_MARKS = /[\u0300-\u036f]/g;

function foldAccents(text: string): string {
  return text
    .replace(/[ßæœøđłðþ]/g, (ch) => FOLD_MAP[ch] ?? ch)
    .normalize("NFD")
    .replace(FOLD_MARKS, "");
}

export function segmentKeywords(...parts: string[]): string {
  return (foldAccents(parts.filter(Boolean).join(" ").toLowerCase()).match(SEGMENT_RE) ?? []).join(" ");
}

/** URL identity: strip the fragment and the common tracking params,
    lowercase the host, drop a trailing slash -- then hash.  FNV-1a over
    two lanes (16 hex chars); the full url is stored alongside, so the
    collision surface stays theoretical at browser scale. */
export function urlHash(url: string): string {
  let normalized: string;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const drop = [...parsed.searchParams.keys()].filter((key) =>
      /^(utm_|ref|referrer|fbclid|gclid|spm|scm)/i.test(key),
    );
    for (const key of drop) {
      parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    normalized = parsed.toString().replace(/\?$/, "").replace(/\/$/, "");
  } catch {
    normalized = url.trim();
  }
  let laneA = 0x811c9dc5;
  let laneB = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    laneA = (laneA ^ code) * 0x01000193;
    laneB = (laneB ^ ((code << (i & 7)) & 0xffffffff)) * 0x01000193;
    laneA >>>= 0;
    laneB >>>= 0;
  }
  return laneA.toString(16).padStart(8, "0") + laneB.toString(16).padStart(8, "0");
}
