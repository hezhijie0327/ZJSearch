// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type {
  AiCalendarAlmanac,
  AiCalendarLunar,
  AiCalendarPayload,
  AiSearchCall,
  AiToolMatch,
} from "@/features/results/aiSearch/runModel.ts";

const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  "search_web",
  "calculate",
  "clock",
  "calendar",
  "mcp",
  "memory",
  "recall_history",
  "list_engines",
  "update_plan",
  "record_findings",
  "evaluate",
  "ask_user",
  "build_table",
  "inspect_image",
  "browse",
  "delegate_research",
  "message_subtask",
  "set_deliverable",
]);

/** One lunar block, sanitized: the strings survive as strings, the
    verdict only as its three legal values, the lists as string arrays
    (a legacy/garbage field degrades to null -- the row simply hides
    the lunar line). */
/** The string-array sanitizer shared by the lunar/almanac/find folds:
    only non-empty strings survive, anything else degrades to []. */
export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

export function normalizeLunar(value: unknown): AiCalendarLunar | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const l = value as Record<string, unknown>;
  const g = (l.ganzhi ?? {}) as Record<string, unknown>;
  const nt = (l.next_term ?? {}) as Record<string, unknown>;
  const w = (l.workday ?? null) as Record<string, unknown> | null;
  return {
    year: String(l.year ?? ""),
    year_cn: String(l.year_cn ?? ""),
    zodiac: String(l.zodiac ?? ""),
    month: String(l.month ?? ""),
    day: String(l.day ?? ""),
    leap: l.leap === true,
    season: String(l.season ?? ""),
    ganzhi: { year: String(g.year ?? ""), month: String(g.month ?? ""), day: String(g.day ?? "") },
    term: typeof l.term === "string" ? l.term : "",
    next_term: { name: String(nt.name ?? ""), date: String(nt.date ?? "") },
    festivals: asStringArray(l.festivals),
    solar_holidays: asStringArray(l.solar_holidays),
    folk: asStringArray(l.folk),
    workday:
      w && typeof w.coverage_until === "string" && w.coverage_until
        ? {
            status: w.status === "off" || w.status === "workday" || w.status === "makeup" ? w.status : null,
            name: typeof w.name === "string" && w.name ? w.name : null,
            coverage_until: w.coverage_until,
          }
        : null,
    almanac: normalizeAlmanac(l.almanac),
  };
}

/** One settled clock payload, sanitized: the mode resolves to its two
    legal values, the strings survive only as strings, the numerics only
    as numbers (a legacy/garbage field degrades to undefined, never a
    runtime surprise in the row). */
export function normalizeCalendar(value: unknown): AiCalendarPayload {
  const c = (value ?? {}) as Record<string, unknown>;
  return {
    mode: c.mode === "date" ? "date" : c.mode === "find" ? "find" : c.mode === "terms" ? "terms" : "now",
    timezone: typeof c.timezone === "string" && c.timezone ? c.timezone : null,
    today: String(c.today ?? ""),
    weekday: String(c.weekday ?? ""),
    utc_offset: typeof c.utc_offset === "string" && c.utc_offset ? c.utc_offset : null,
    time: typeof c.time === "string" ? c.time : undefined,
    utc: typeof c.utc === "string" ? c.utc : null,
    unix: typeof c.unix === "number" ? c.unix : null,
    target: typeof c.target === "string" ? c.target : undefined,
    target_weekday: typeof c.target_weekday === "string" && c.target_weekday ? c.target_weekday : undefined,
    iso_week: typeof c.iso_week === "number" ? c.iso_week : undefined,
    days_from_today: typeof c.days_from_today === "number" ? c.days_from_today : undefined,
    relation:
      c.relation === "past" || c.relation === "future" ? c.relation : c.today === c.target ? "today" : undefined,
    lunar: "lunar" in c ? normalizeLunar(c.lunar) : undefined,
    activity: typeof c.activity === "string" ? c.activity : undefined,
    scanned_days: typeof c.scanned_days === "number" ? c.scanned_days : undefined,
    terms: asStringArray(c.terms),
    findings: Array.isArray(c.findings)
      ? (c.findings as Array<Record<string, unknown>>).map((f) => ({
          date: String(f.date ?? ""),
          days_from_today: typeof f.days_from_today === "number" ? f.days_from_today : 0,
          weekday: String(f.weekday ?? ""),
          suited: asStringArray(f.suited),
          festivals: asStringArray(f.festivals),
          term: typeof f.term === "string" ? f.term : "",
        }))
      : undefined,
  };
}

/** the almanac block, sanitized -- every field degrades to its empty
    value, the row renders what arrived. */
export function normalizeAlmanac(value: unknown): AiCalendarAlmanac {
  const a = (value ?? {}) as Record<string, unknown>;
  return {
    suited: asStringArray(a.suited),
    avoided: asStringArray(a.avoided),
    gods: asStringArray(a.gods),
    avoid_gods: asStringArray(a.avoid_gods),
    officer: typeof a.officer === "string" ? a.officer : "",
    ecliptic: typeof a.ecliptic === "string" ? a.ecliptic : "",
    duty_god: typeof a.duty_god === "string" ? a.duty_god : "",
    mansions: typeof a.mansions === "string" ? a.mansions : "",
    east_star: typeof a.east_star === "string" ? a.east_star : "",
    nayin: typeof a.nayin === "string" ? a.nayin : "",
    pengzu: typeof a.pengzu === "string" ? a.pengzu : "",
    directions: asStringArray(a.directions),
    fetus_god: typeof a.fetus_god === "string" ? a.fetus_god : "",
    moon: typeof a.moon === "string" ? a.moon : "",
  };
}

export function normalizeCall(item: Record<string, unknown>): AiSearchCall {
  const tool = String(item.tool ?? "");
  return {
    id: Number(item.id) || 0,
    tool: (KNOWN_TOOLS.has(tool) ? tool : "search_web") as AiSearchCall["tool"],
    name: typeof item.name === "string" ? item.name : undefined,
    label: typeof item.label === "string" ? item.label : undefined,
    tools: Array.isArray(item.tools) ? (item.tools as AiToolMatch[]).filter((m) => m?.name) : undefined,
    q: String(item.q ?? ""),
    url: item.url ? String(item.url) : undefined,
    category: String(item.category ?? ""),
    args: (item.args as Record<string, unknown>) ?? undefined,
    feed: typeof item.feed === "string" && item.feed ? item.feed : undefined,
    ms: typeof item.ms === "number" ? item.ms : undefined,
    status: "pending" as const,
  };
}

/** A fresh run row in the streaming state (the timeline's seed). */
