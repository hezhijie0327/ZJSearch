// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * The results meta line: 「found N results」 and 「took X s」 toggles, each
 * expanding its own strip in place (shared Collapse animation) — the result
 * strip carries the utility actions (copy the shareable URL, machine-
 * readable download formats), the engine strip the per-engine timings and
 * errors.
 */

import {
  AlertTriangle,
  ChevronDown,
  FileCode2,
  FileJson,
  FileSpreadsheet,
  Link2,
  List,
  type LucideIcon,
  Rss,
  Timer,
} from "lucide-react";
import { useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import { Meter } from "@/components/Meter.tsx";
import { useOverlay } from "@/features/overlay/OverlayProvider.tsx";
import { useCopyToast } from "@/lib/clipboard.ts";
import { downloadResults } from "@/lib/exporters.ts";
import { round1 } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { isModifiedClick } from "@/lib/link.ts";
import { flashToast } from "@/lib/toast.ts";
import type { ResultItem, SearchPageData } from "@/lib/types.ts";

/** per-format icons for the download strip; unknown configured formats fall
    back to the code-file icon */
const FORMAT_ICONS: Record<string, LucideIcon> = {
  csv: FileSpreadsheet,
  json: FileJson,
  rss: Rss,
  xml: FileCode2,
};

/** Display priority for the export chips (config order is arbitrary);
    unknown formats keep their config order at the end. */
const FORMAT_ORDER = ["rss", "json", "csv", "xml"];

function formatOrder(format: string): number {
  const index = FORMAT_ORDER.indexOf(format);
  return index === -1 ? FORMAT_ORDER.length : index;
}

const metaToggle = "inline-flex min-h-6 items-center gap-1 transition-colors hover:text-ink";
const stripChip =
  "inline-flex items-center gap-1 rounded-full bg-surface-2 px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink";

export function DebugPanels({
  data,
  results,
  searchUrl,
}: {
  data: SearchPageData;
  /** results currently on screen (payload + appended infinite-scroll pages):
      the download formats export this list client-side */
  results: ResultItem[];
  /** shareable search URL: enables the copy action and the download formats
      (its format= URLs stay the fallback for modified clicks / feed readers) */
  searchUrl?: string;
}) {
  const t = useT();
  const copyToast = useCopyToast();
  const { openOverlay } = useOverlay();
  const hasEnginesPanel = data.unresponsive_engines.length > 0 || data.timings.length > 0;
  // with zero results the engine messages matter most — start expanded
  const [openPanel, setOpenPanel] = useState<null | "engines" | "results">(() =>
    hasEnginesPanel && data.results.length === 0 ? "engines" : null,
  );
  const toggle = (panel: "engines" | "results") => {
    setOpenPanel((current) => (current === panel ? null : panel));
  };
  const roundedTime = data.max_response_time ? round1(data.max_response_time) : null;
  const maxTime = data.max_response_time ?? 0;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
        <button
          aria-expanded={openPanel === "results"}
          className={metaToggle}
          onClick={() => {
            toggle("results");
          }}
          type="button"
        >
          <List className="size-3 shrink-0" />
          {t("meta_found")} {results.length} {t("meta_results")}
          <ChevronDown className={`size-3.5 transition-transform ${openPanel === "results" ? "rotate-180" : ""}`} />
        </button>
        {hasEnginesPanel ? (
          <button
            aria-expanded={openPanel === "engines"}
            className={metaToggle}
            onClick={() => {
              toggle("engines");
            }}
            type="button"
          >
            <Timer className="size-3 shrink-0" />
            {roundedTime !== null ? `${t("took")} ${roundedTime} ${t("seconds")}` : t("engines_messages")}
            <ChevronDown className={`size-3.5 transition-transform ${openPanel === "engines" ? "rotate-180" : ""}`} />
          </button>
        ) : null}
      </div>

      <Collapse className={openPanel === "results" ? "mt-2" : ""} open={openPanel === "results"}>
        <div className="rounded-2xl border border-line bg-surface px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
              <Link2 className="size-4.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-ink">{t("copy_search_url")}</p>
              {searchUrl ? (
                <p className="mt-0.5 truncate font-mono text-xs text-ink-3" dir="ltr" title={searchUrl}>
                  {searchUrl}
                </p>
              ) : null}
            </div>
            {/* confirmation comes from the shared green flashToast */}
            <button
              className="shrink-0 rounded-full border border-line px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent"
              onClick={() => {
                if (searchUrl) {
                  copyToast(searchUrl);
                }
              }}
              type="button"
            >
              {t("copy_link")}
            </button>
          </div>
          {searchUrl && data.globals.search_formats.length > 0 ? (
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-xs font-medium text-ink-3">{t("export_formats")}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[...data.globals.search_formats]
                  .sort((a, b) => formatOrder(a) - formatOrder(b))
                  .map((format) => {
                    const Icon = FORMAT_ICONS[format] ?? FileCode2;
                    return (
                      <a
                        className={stripChip}
                        href={`${searchUrl}&format=${format}`}
                        key={format}
                        onClick={(event) => {
                          // a plain click exports what is on screen (the
                          // merged list lives only here, the server cannot
                          // rebuild it); modified clicks keep the server
                          // format= URL for feed readers / API consumers
                          if (isModifiedClick(event)) {
                            return;
                          }
                          event.preventDefault();
                          if (downloadResults(format, data, results, window.location.origin)) {
                            flashToast(`${t("exported")} ${results.length} ${t("meta_results")}`, { tone: "ok" });
                          }
                        }}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <Icon className="size-3.5 shrink-0 text-ink-3" />
                        {format.toUpperCase()}
                      </a>
                    );
                  })}
              </div>
            </div>
          ) : null}
        </div>
      </Collapse>

      <Collapse className={openPanel === "engines" ? "mt-2" : ""} open={openPanel === "engines"}>
        <div className="rounded-2xl border border-line bg-surface px-4 py-3">
          {/* one fixed-layout table for every engine: timings get seconds +
              bar, unresponsive engines their error label + an empty track on
              the same grid; table-fixed makes the w-24 truncation real */}
          <table className="w-full table-fixed text-xs">
            <tbody>
              {data.unresponsive_engines.map(([name, errorMessage]) => (
                <tr key={name}>
                  <td className="w-24 truncate py-0.5 pr-2">
                    <button
                      className="text-left font-medium text-ink-2 hover:text-accent"
                      onClick={() => {
                        openOverlay(`/stats?engine=${encodeURIComponent(name)}`, t("engine_stats"));
                      }}
                      type="button"
                    >
                      {name}
                    </button>
                  </td>
                  <td className="py-0.5">
                    <div className="flex items-center gap-2">
                      {/* right-aligned into the seconds column: the error's
                          right edge lines up with the digits / bar start */}
                      <span
                        className="inline-flex w-24 shrink-0 items-center justify-end gap-1 truncate text-danger"
                        dir="auto"
                        title={errorMessage}
                      >
                        <AlertTriangle aria-hidden="true" className="size-3 shrink-0" />
                        <span className="truncate">{errorMessage}</span>
                      </span>
                      <span className="h-1.5 flex-1 rounded-full bg-surface-2" />
                    </div>
                  </td>
                </tr>
              ))}
              {data.timings.map((timing) => (
                <tr key={timing.name}>
                  <td className="w-24 truncate py-0.5 pr-2">
                    <button
                      className="text-left text-ink-2 hover:text-accent"
                      onClick={() => {
                        openOverlay(`/stats?engine=${encodeURIComponent(timing.name)}`, t("engine_stats"));
                      }}
                      type="button"
                    >
                      {timing.name}
                    </button>
                  </td>
                  <td className="py-0.5">
                    <div className="flex items-center gap-2">
                      <span className="w-24 shrink-0 text-right text-ink-3">{round1(timing.time)}</span>
                      <Meter
                        fillClassName="bg-accent/70"
                        max={maxTime}
                        trackClassName="h-1.5 flex-1"
                        value={timing.time}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Collapse>
    </div>
  );
}
