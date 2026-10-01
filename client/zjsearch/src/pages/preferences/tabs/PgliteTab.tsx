// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Bomb, Database, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n.ts";
import { clearAllThreads, resetAll, threadStats } from "@/lib/knowledgeStore.ts";
import { flashToast } from "@/lib/toast.ts";
import { Card, SectionLabel, SettingRow } from "@/pages/preferences/parts.tsx";

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** The PGlite surface (browser-local WASM Postgres), in the shared Card +
    SectionLabel language of the other tabs: one section per store -- today
    the AI research memory (threads, runs, the source corpus), more stores
    can join the list.  Purely client data -- the server keeps nothing. */
export function PgliteTab() {
  const t = useT();
  const [stats, setStats] = useState(() => threadStats());
  const [confirming, setConfirming] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const refresh = useCallback((): void => {
    setStats(threadStats());
  }, []);

  const clear = (): void => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    clearAllThreads();
    setStats(threadStats());
    setConfirming(false);
    flashToast(t("prefs_threads_cleared"), { tone: "ok", timeoutMs: 2000 });
  };

  // the nuclear option: drop every table (the schema itself is recreated
  // on the next boot) -- use it when the STORED DATA must go for sure,
  // dimension changes and future schema shapes included
  const reset = (): void => {
    if (!confirmingReset) {
      setConfirmingReset(true);
      return;
    }
    resetAll();
    setStats(threadStats());
    setConfirmingReset(false);
    flashToast(t("prefs_pglite_reset_done"), { tone: "ok", timeoutMs: 2000 });
  };

  // saves elsewhere (the AI pages) re-populate the store -- re-read when
  // the browser tab regains focus so the numbers stay honest
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  return (
    <Card>
      <SectionLabel label={t("prefs_pglite_group_threads")} />
      <SettingRow
        description={t("prefs_threads_note")}
        icon={<Database className="size-4.5" />}
        stacked
        title={t("prefs_threads_count")}
      >
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {(
            [
              [t("prefs_threads_count"), String(stats.threads)],
              [t("prefs_threads_runs"), String(stats.runs)],
              [t("prefs_threads_sources"), String(stats.sources)],
              [t("prefs_threads_memories"), String(stats.memories)],
              [t("prefs_threads_size"), formatBytes(stats.approxBytes)],
            ] as const
          ).map(([label, value]) => (
            <div className="rounded-xl border border-line bg-surface-2/50 p-3 text-center" key={label}>
              <p className="font-serif text-xl font-semibold text-ink">{value}</p>
              <p className="mt-1 text-xs text-ink-3">{label}</p>
            </div>
          ))}
        </div>
      </SettingRow>
      <SettingRow
        description={t("prefs_threads_clear_desc")}
        icon={<Trash2 className="size-4.5" />}
        stacked
        title={t("prefs_threads_clear")}
      >
        <button
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition-colors ${
            confirming
              ? "bg-danger text-white hover:bg-danger/90"
              : "border border-line bg-surface text-ink-2 hover:border-danger hover:text-danger"
          }`}
          onClick={clear}
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
          {confirming ? t("prefs_threads_clear_confirm") : t("prefs_threads_clear")}
        </button>
      </SettingRow>
      <SettingRow
        description={t("prefs_pglite_reset_desc")}
        icon={<Bomb className="size-4.5" />}
        stacked
        title={t("prefs_pglite_reset")}
      >
        <button
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition-colors ${
            confirmingReset
              ? "bg-danger text-white hover:bg-danger/90"
              : "border border-line bg-surface text-ink-2 hover:border-danger hover:text-danger"
          }`}
          onClick={reset}
          type="button"
        >
          <Bomb aria-hidden="true" className="size-3.5" />
          {confirmingReset ? t("prefs_pglite_reset_confirm") : t("prefs_pglite_reset")}
        </button>
      </SettingRow>
    </Card>
  );
}
