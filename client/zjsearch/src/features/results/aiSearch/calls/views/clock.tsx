// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Clock, Copy } from "lucide-react";
import type { ToolRowProps, ToolView } from "@/features/results/aiSearch/calls/types.ts";
import type { AiClockPayload } from "@/features/results/aiSearch/timeline.ts";
import { useCopyToast } from "@/lib/clipboard.ts";
import type { Translate } from "@/lib/i18n.ts";
import { CHIP_HOVER, MONO_CHIP } from "@/lib/styles.ts";
import { weekdayKey } from "@/lib/weekdays.ts";

/**
 * The clock view: the composite time/date answer renders as a value card
 * -- the instant (time hero + weekday/date + zone chips) or the calendar
 * lookup (target date hero + weekday + relation + offsets).  The server
 * speaks a fixed English weekday for the model; the row re-localizes the
 * WEEKDAY through the theme's own catalog (lib/weekdays.ts -- not Intl),
 * while the dates stay the bare ISO form (`2026-11-13` -- the
 * locale-neutral data shape, the owner's call).
 */

/** The catalog weekday name for one ISO date; a malformed date falls
    back to the payload's fixed English name. */
function weekdayLabel(iso: string, t: Translate): string {
  const key = weekdayKey(iso);
  return (key ? t(key) : "") || "";
}

function relationChip(payload: AiClockPayload, t: Translate): string {
  switch (payload.relation) {
    case "today":
      return t("ai_clock_rel_today");
    case "future":
      return t("ai_clock_rel_future");
    case "past":
      return t("ai_clock_rel_past");
    default:
      return "";
  }
}

function NowBody({ payload, t }: { payload: AiClockPayload; t: ToolRowProps["t"] }) {
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
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {payload.timezone ? (
          <span className={MONO_CHIP}>
            {payload.timezone}
            {payload.utc_offset ? ` ${payload.utc_offset.slice(3)}` : ""}
          </span>
        ) : (
          <span className={MONO_CHIP}>{t("ai_clock_server_local")}</span>
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
            {t("ai_clock_utc")} {payload.utc.replace("T", " ")}
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
            {t("ai_clock_unix")} {payload.unix}
            <Copy aria-hidden="true" className="size-3" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DateBody({ payload, t }: { payload: AiClockPayload; t: ToolRowProps["t"] }) {
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
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className={MONO_CHIP}>{days >= 0 ? `+${days}d` : `${days}d`}</span>
        {typeof payload.iso_week === "number" ? <span className={MONO_CHIP}>W{payload.iso_week}</span> : null}
        <span className={MONO_CHIP}>{t("ai_clock_today_label", { date: payload.today })}</span>
        {payload.timezone ? <span className={MONO_CHIP}>{payload.timezone}</span> : null}
      </div>
    </div>
  );
}

export const clockView: ToolView = {
  Icon: Clock,
  label: ({ call, t }) => call.q || t("ai_clock_row"),
  metric: ({ call, t }) => {
    if (call.status === "pending") {
      return t("ai_clock_running");
    }
    if (call.status !== "ok" || !call.clock) {
      return null;
    }
    return call.clock.mode === "now" ? (call.clock.time ?? null) : (call.clock.target ?? null);
  },
  Content: ({ call, t }) => {
    if (!call.clock) {
      // legacy/error replays: the feed head (the kernel's debug panes)
      // is the honest body
      return null;
    }
    return call.clock.mode === "date" ? (
      <DateBody payload={call.clock} t={t} />
    ) : (
      <NowBody payload={call.clock} t={t} />
    );
  },
  expandable: ({ call }) => Boolean(call.clock),
};
