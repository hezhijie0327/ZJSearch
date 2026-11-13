// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookOpenText, Clock, Copy, SearchCheck } from "lucide-react";
import type { ToolRowProps, ToolView } from "@/features/results/aiSearch/calls/types.ts";
import type { AiCalendarLunar, AiCalendarPayload } from "@/features/results/aiSearch/timeline.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import type { Translate } from "@/lib/i18n.ts";
import { CHIP_HOVER, MONO_CHIP } from "@/lib/styles.ts";
import { weekdayKey } from "@/lib/weekdays.ts";

/**
 * The calendar view: the composite time/date answer renders as a value
 * card -- the instant (time hero + weekday/date + zone chips), the
 * calendar lookup (target date hero + weekday + relation + offsets), or
 * the auspicious-day scan (one row per hit).  The lunar line + the
 * ALMANAC block (the suited/avoided lists, the gods, the 12-day officer with its ecliptic
 * mark, the mansions, nayin, Pengzu's taboos, the lucky directions)
 * ride on every shape.  The server speaks a fixed English weekday for
 * the model; the row re-localizes the WEEKDAY through the theme's own
 * catalog (lib/weekdays.ts -- not Intl), while the dates stay the bare
 * ISO form (`2026-11-13` -- the locale-neutral data shape, the owner's
 * call).  The almanac's Chinese terms are runtime proper nouns (the
 * payload's data), not literals.
 */

/** The catalog weekday name for one ISO date; a malformed date falls
    back to the payload's fixed English name. */
function weekdayLabel(iso: string, t: Translate): string {
  const key = weekdayKey(iso);
  return (key ? t(key) : "") || "";
}

function relationChip(payload: AiCalendarPayload, t: Translate): string {
  switch (payload.relation) {
    case "today":
      return t("ai_calendar_rel_today");
    case "future":
      return t("ai_calendar_rel_future");
    case "past":
      return t("ai_calendar_rel_past");
    default:
      return "";
  }
}

/** One labeled chip row of the almanac block (the label key localized,
    the terms verbatim). */
function AlmanacRow({ label, terms, tone }: { label: string; terms: string[]; tone: "ok" | "danger" | "muted" }) {
  if (!terms.length) {
    return null;
  }
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-start gap-x-1.5 gap-y-1 text-xs">
      <span className="mt-px w-8 shrink-0 text-ink-3">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {terms.map((term) => (
          <span
            className={`rounded px-1.5 py-0.5 text-xs leading-4 ${
              tone === "ok"
                ? "bg-ok/10 text-ok"
                : tone === "danger"
                  ? "bg-danger/10 text-danger"
                  : "bg-surface-2 text-ink-2"
            }`}
            key={term}
          >
            {term}
          </span>
        ))}
      </span>
    </div>
  );
}

/** The almanac block: the day's traditional judgement -- what it suits
    and avoids, the gods, the 12-day officer with its ecliptic mark, the
    mansions/nayin, Pengzu's taboos, the lucky directions.  Rendered as
    labeled chip rows on the card's hairline top (one visual unit under
    the lunar line); empty fields simply drop out. */
function AlmanacBlock({ lunar, t }: { lunar: AiCalendarLunar; t: ToolRowProps["t"] }) {
  const a = lunar.almanac;
  const officerBits = [a.officer, a.duty_god, a.ecliptic].filter(Boolean);
  const facts = [a.mansions, a.nayin, a.east_star].filter(Boolean);
  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="flex min-w-0 flex-wrap items-start gap-x-1.5 gap-y-1 text-xs">
        <span className="mt-px w-8 shrink-0 font-medium text-ok">{t("ai_calendar_yi")}</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {a.suited.map((term) => (
            <span className="rounded bg-ok/10 px-1.5 py-0.5 text-xs leading-4 text-ok" key={term}>
              {term}
            </span>
          ))}
        </span>
      </div>
      <AlmanacRow label={t("ai_calendar_ji")} terms={a.avoided} tone="danger" />
      {officerBits.length ? (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
          <span className="w-8 shrink-0 text-ink-3">{t("ai_calendar_officer")}</span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1" dir="auto">
            {officerBits.map((bit) => (
              <span className={MONO_CHIP} key={bit}>
                {bit}
              </span>
            ))}
            {facts.map((fact) => (
              <span className={MONO_CHIP} key={fact}>
                {fact}
              </span>
            ))}
          </span>
        </div>
      ) : null}
      <AlmanacRow label={t("ai_calendar_gods")} terms={a.gods} tone="muted" />
      <AlmanacRow label={t("ai_calendar_avoid_gods")} terms={a.avoid_gods} tone="muted" />
      <AlmanacRow label={t("ai_calendar_directions")} terms={a.directions} tone="muted" />
      <AlmanacRow
        label={t("ai_calendar_pengzu")}
        // Pengzu's taboos arrive as comma-joined clauses -- one chip per
        // clause reads as the same labeled row the other fields speak
        terms={a.pengzu
          .split(/[,，]/)
          .map((clause) => clause.trim())
          .filter(Boolean)}
        tone="muted"
      />
    </div>
  );
}

/** The lunar line: the composed catalog date (the glue lives in the
    catalog -- the zh value renders the ganzhi year, zodiac and lunar
    month/day verbatim) + the workday verdict, the day's solar term and
    the festival chips. */
function LunarLine({ lunar, t }: { lunar: AiCalendarLunar; t: ToolRowProps["t"] }) {
  const workday =
    lunar.workday === null || lunar.workday.status === null
      ? null
      : lunar.workday.status === "off"
        ? t("ai_calendar_workday_off")
        : lunar.workday.status === "makeup"
          ? t("ai_calendar_workday_makeup")
          : t("ai_calendar_workday_work");
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs" dir="auto">
      <span className="min-w-0 truncate text-ink-2">
        {t("ai_calendar_lunar_date", { year: lunar.year, zodiac: lunar.zodiac, month: lunar.month, day: lunar.day })}
      </span>
      {workday ? <span className={MONO_CHIP}>{workday}</span> : null}
      {lunar.term ? <span className={MONO_CHIP}>{lunar.term}</span> : null}
      {lunar.festivals.map((festival) => (
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent" key={festival}>
          {festival}
        </span>
      ))}
    </div>
  );
}

function NowBody({ payload, t }: { payload: AiCalendarPayload; t: ToolRowProps["t"] }) {
  const copyToast = useCopyToast();
  const weekday = weekdayLabel(payload.today, t) || payload.weekday;
  return (
    <div className="mt-1 rounded-xl bg-surface-2/50 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-xl font-semibold tabular-nums text-ink">{payload.time}</span>
        <span className="text-[13px] text-ink-2" dir="auto">
          {weekday} · {payload.today}
        </span>
      </div>
      {payload.lunar ? <LunarLine lunar={payload.lunar} t={t} /> : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {payload.timezone ? (
          <span className={MONO_CHIP}>
            {payload.timezone}
            {payload.utc_offset ? ` ${payload.utc_offset.slice(3)}` : ""}
          </span>
        ) : (
          <span className={MONO_CHIP}>{t("ai_calendar_server_local")}</span>
        )}
        {payload.utc ? (
          <button
            className={`${MONO_CHIP} cursor-pointer ${CHIP_HOVER}`}
            onClick={() => {
              copyToast(payload.utc ?? "");
            }}
            title={t("copy")}
            type="button"
          >
            {t("ai_calendar_utc")} {payload.utc.replace("T", " ")}
            <Copy aria-hidden="true" className="size-3" />
          </button>
        ) : null}
        {typeof payload.unix === "number" ? (
          <button
            className={`${MONO_CHIP} cursor-pointer ${CHIP_HOVER}`}
            onClick={() => {
              copyToast(String(payload.unix));
            }}
            title={t("copy")}
            type="button"
          >
            {t("ai_calendar_unix")} {payload.unix}
            <Copy aria-hidden="true" className="size-3" />
          </button>
        ) : null}
      </div>
      {payload.lunar ? <AlmanacBlock lunar={payload.lunar} t={t} /> : null}
    </div>
  );
}

function DateBody({ payload, t }: { payload: AiCalendarPayload; t: ToolRowProps["t"] }) {
  const target = payload.target ?? payload.today;
  const weekday = weekdayLabel(target, t) || payload.weekday;
  const days = payload.days_from_today ?? 0;
  const relation = relationChip(payload, t);
  return (
    <div className="mt-1 rounded-xl bg-surface-2/50 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-xl font-semibold tabular-nums text-ink">{target}</span>
        <span className="text-[13px] text-ink-2" dir="auto">
          {weekday}
        </span>
        {relation ? (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              payload.relation === "today"
                ? "bg-accent-soft text-accent"
                : payload.relation === "future"
                  ? "bg-ok/10 text-ok"
                  : "bg-surface-2 text-ink-3"
            }`}
          >
            {relation}
          </span>
        ) : null}
      </div>
      {payload.lunar ? <LunarLine lunar={payload.lunar} t={t} /> : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className={MONO_CHIP}>{days >= 0 ? `+${days}d` : `${days}d`}</span>
        {typeof payload.iso_week === "number" ? <span className={MONO_CHIP}>W{payload.iso_week}</span> : null}
        <span className={MONO_CHIP}>{t("ai_calendar_today_label", { date: payload.today })}</span>
        {payload.timezone ? <span className={MONO_CHIP}>{payload.timezone}</span> : null}
      </div>
      {payload.lunar ? <AlmanacBlock lunar={payload.lunar} t={t} /> : null}
    </div>
  );
}

/** The terms body: the almanac's full activity vocabulary as a chip
    cloud -- the discovery surface the model (and the reader) reads
    before a find_suited scan. */
function TermsBody({ payload, t }: { payload: AiCalendarPayload; t: ToolRowProps["t"] }) {
  const terms = payload.terms ?? [];
  return (
    <div className="mt-1 rounded-xl bg-surface-2/50 px-3 py-2.5">
      {/* the vocabulary as a DIRECTORY GRID (the list_engines
          inventory's cell vocabulary): 83 terms laid out multi-column
          -- a chip wall read as noise, one flat paragraph as
          unrendered text; the grid scans */}
      <p className="text-xs font-medium text-ink-2" dir="auto">
        {t("ai_calendar_terms_title", { n: String(terms.length) })}
      </p>
      <div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1">
        {terms.map((term) => (
          <span
            className="truncate rounded-md bg-surface px-2 py-1 text-center text-xs text-ink-2"
            dir="auto"
            key={term}
          >
            {term}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The find body: the auspicious-day scan's hits -- one row per day
    (localized weekday + the matched suited terms in ok chips + the day's
    festivals), newest-date first as the scan produced them. */
function FindBody({ payload, t }: { payload: AiCalendarPayload; t: ToolRowProps["t"] }) {
  const findings = payload.findings ?? [];
  if (!payload.activity || !findings.length) {
    return (
      <p className="mt-1 flex items-center gap-1.5 rounded-lg bg-surface-2/50 px-2 py-2 text-xs text-ink-3">
        <SearchCheck aria-hidden="true" className="size-3.5 shrink-0" />
        {t("ai_calendar_find_empty", { activity: payload.activity ?? "", n: String(payload.scanned_days ?? 0) })}
      </p>
    );
  }
  return (
    <div className="mt-1 rounded-xl bg-surface-2/50 px-3 py-2.5">
      <p className="text-xs font-medium text-ink-2" dir="auto">
        {t("ai_calendar_find_title", { activity: payload.activity, n: String(payload.scanned_days ?? 0) })}
      </p>
      <div className="mt-1.5 space-y-1">
        {findings.map((finding) => {
          const weekday = weekdayLabel(finding.date, t) || finding.weekday;
          // the matched terms that merely ECHO the scanned activity are
          // noise (the row exists because the day suits it) -- only the
          // ADDITIONAL terms deserve chips
          const extraSuited = finding.suited.filter((term) => term !== payload.activity);
          return (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs" key={finding.date}>
              <span className="font-mono tabular-nums text-ink">{finding.date}</span>
              <span className="text-ink-3">{weekday}</span>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {extraSuited.map((term) => (
                  <span className="rounded bg-ok/10 px-1.5 py-0.5 text-xs leading-4 text-ok" key={term}>
                    {term}
                  </span>
                ))}
                {finding.festivals.map((festival) => (
                  <span
                    className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent"
                    key={festival}
                  >
                    {festival}
                  </span>
                ))}
                {finding.term ? <span className={MONO_CHIP}>{finding.term}</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const calendarView: ToolView = {
  Icon: Clock,
  // the mode carries its own icon + label: the clock icon names the
  // instant/lookup shapes, the scan reads as a search and the
  // vocabulary as a reference list (a terms row wearing the clock
  // icon + the generic clock label read as a rendering bug)
  iconFor: ({ call }) => {
    const args = call.args as Record<string, unknown> | undefined;
    const mode = call.calendar?.mode ?? (args?.list_terms ? "terms" : args?.find_suited ? "find" : "");
    const Icon = mode === "find" ? SearchCheck : mode === "terms" ? BookOpenText : Clock;
    return <Icon aria-hidden="true" className="size-3 shrink-0" />;
  },
  label: ({ call, t }) => {
    const args = call.args as Record<string, unknown> | undefined;
    const mode = call.calendar?.mode ?? (args?.list_terms ? "terms" : "");
    if (mode === "terms") {
      return t("ai_calendar_terms_row");
    }
    if (mode === "find") {
      return call.calendar?.activity || call.q || t("ai_calendar_row");
    }
    return call.q || t("ai_calendar_row");
  },
  metric: ({ call, t }) => {
    if (call.status === "pending") {
      return t("ai_calendar_running");
    }
    if (call.status !== "ok" || !call.calendar) {
      return null;
    }
    if (call.calendar.mode === "find") {
      const hits = call.calendar.findings?.length ?? 0;
      return t("ai_calendar_find_metric", { n: String(hits) });
    }
    if (call.calendar.mode === "terms") {
      return t("ai_calendar_terms_metric", { n: String(call.calendar.terms?.length ?? 0) });
    }
    return call.calendar.mode === "now" ? (call.calendar.time ?? null) : (call.calendar.target ?? null);
  },
  Content: ({ call, t }) => {
    if (!call.calendar) {
      // legacy/error replays: the feed head (the kernel's debug panes)
      // is the honest body
      return null;
    }
    if (call.calendar.mode === "find") {
      return <FindBody payload={call.calendar} t={t} />;
    }
    if (call.calendar.mode === "terms") {
      return <TermsBody payload={call.calendar} t={t} />;
    }
    return call.calendar.mode === "date" ? (
      <DateBody payload={call.calendar} t={t} />
    ) : (
      <NowBody payload={call.calendar} t={t} />
    );
  },
  expandable: ({ call }) => Boolean(call.calendar),
};
