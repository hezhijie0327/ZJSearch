// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge page's sections: the thread rows (Vane's library list),
    the grouped search results, the memory surface (LobeHub's timeline +
    cards), the inspector reading pane (morphic), the admin drawer (the
    old preferences PgliteTab's duties) and the shared confirm dialog.
    Page-private to KnowledgePage -- nothing here exports beyond it
    EXCEPT the glyph identity map, which the drawer's views wear too. */

import type { LucideIcon } from "lucide-react";
import { ArrowDown, ArrowUp, Brain, Database, DatabaseZap, FileDown, FileUp, Gauge, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/SettingParts.tsx";
import { type EmbedUsageTotals, readEmbedUsage } from "@/lib/embed.ts";
import { formatFilesize } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import type { KnowledgeStats } from "@/lib/kb/stats.ts";
import { type RerankUsageTotals, readRerankUsage } from "@/lib/rerank.ts";

/** The ONE glyph identity per knowledge surface: the segment tab, the kind
    directory's empty note and each view's own empty state wear the same
    icon -- one map, so they cannot drift apart again (the Layers-era
    empties once disagreed with every tab they lived under). */

function AdminHeader({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon aria-hidden="true" className="size-4.5 text-ink-3" />
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
    </div>
  );
}

export function AdminView({
  onExport,
  onImport,
  onReset,
  stats,
}: {
  onExport: () => void;
  onImport: (file: File) => void;
  onReset: () => void;
  stats: KnowledgeStats | null;
}) {
  const t = useT();
  const [embedUsage, setEmbedUsage] = useState<EmbedUsageTotals | undefined>(undefined);
  const [rerankUsage, setRerankUsage] = useState<RerankUsageTotals | undefined>(undefined);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    void readEmbedUsage().then((totals) => {
      if (live) {
        setEmbedUsage(totals);
      }
    });
    void readRerankUsage().then((totals) => {
      if (live) {
        setRerankUsage(totals);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const rows: Array<{ label: string; value: string }> = stats
    ? [
        { label: t("knowledge_admin_threads"), value: String(stats.threads) },
        { label: t("knowledge_admin_runs"), value: String(stats.runs) },
        { label: t("knowledge_admin_answers"), value: String(stats.answers) },
        { label: t("knowledge_admin_sources"), value: String(stats.sources) },
        { label: t("knowledge_admin_documents"), value: String(stats.documents) },
        { label: t("knowledge_admin_memories"), value: String(stats.memories) },
        { label: t("knowledge_admin_events"), value: String(stats.events) },
        { label: t("knowledge_admin_size"), value: formatFilesize(stats.approxBytes) ?? "--" },
      ]
    : [];
  return (
    <div className="space-y-6 animate-fade-in">
      {(() => {
        const embed = embedUsage?.calls ? embedUsage : undefined;
        const llm = stats?.usage;
        if (!llm && !embed) {
          return null;
        }
        // think only reports on SDKs that break reasoning out (openai's
        // reasoning_tokens; the anthropic protocol folds it into output
        // and reports nothing) -- a misleading 0 hides itself
        const llmTiles = stats?.usage
          ? (
              [
                ["knowledge_usage_input", stats.usage.input, ArrowUp],
                ["knowledge_usage_output", stats.usage.output, ArrowDown],
                ["knowledge_usage_thoughts", stats.usage.thoughts, Brain],
                ["knowledge_usage_cached", stats.usage.cached, Database],
                ["knowledge_usage_cache_write", stats.usage.cache_write, DatabaseZap],
              ] as const
            ).filter(([, value]) => value !== 0)
          : [];
        return (
          <Card>
            <div className="px-5 py-5 sm:px-6">
              <AdminHeader icon={Gauge} title={t("knowledge_admin_usage_title")} />
              {llmTiles.length > 0 ? (
                <>
                  <p className="mt-4 text-xs font-medium text-ink-3">{t("knowledge_usage_group_llm")}</p>
                  <dl className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-2">
                    {llmTiles.map(([label, value, Icon]) => (
                      <div className="rounded-xl border border-line bg-surface px-3 py-2.5" key={label}>
                        <dt className="flex items-center gap-1 text-xs text-ink-3">
                          <Icon aria-hidden="true" className="size-3" />
                          {t(label)}
                        </dt>
                        <dd className="mt-0.5 font-mono text-sm font-medium text-ink">
                          {value.toLocaleString()}
                          <span className="ms-1 text-xs font-sans font-normal text-ink-3">
                            {t("knowledge_usage_tokens")}
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : null}
              {embed || stats?.usage?.rerank || rerankUsage?.calls || stats?.usage?.decision ? (
                // embed / rerank / decision: the LLM group's language -- one
                // group
                // title per model, ONE input tile inside (the score
                // endpoints are input-only); the three groups share ONE
                // row (they stack below sm).  The rerank tile sums BOTH
                // pools: the runs' cascade spend (run meta) AND the
                // browser recall's own calls (the usage:rerank row).
                <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-6 gap-y-4">
                  {embed ? (
                    <div>
                      <p className="text-xs font-medium text-ink-3">{t("knowledge_usage_embedding")}</p>
                      <div className="mt-2 rounded-xl border border-line bg-surface px-3 py-2.5">
                        <dt className="flex items-center gap-1 text-xs text-ink-3">
                          <ArrowUp aria-hidden="true" className="size-3" />
                          {t("knowledge_usage_input")}
                        </dt>
                        <dd className="mt-0.5 font-mono text-sm font-medium text-ink">
                          {embed.input.toLocaleString()}
                          <span className="ms-1 text-xs font-sans font-normal text-ink-3">
                            {t("knowledge_usage_tokens")}
                          </span>
                        </dd>
                      </div>
                    </div>
                  ) : null}
                  {stats?.usage?.rerank || rerankUsage?.calls
                    ? (() => {
                        const rerankInput = (stats?.usage?.rerank?.tokens ?? 0) + (rerankUsage?.input ?? 0);
                        return (
                          <div>
                            <p className="text-xs font-medium text-ink-3">{t("knowledge_usage_rerank")}</p>
                            <div className="mt-2 rounded-xl border border-line bg-surface px-3 py-2.5">
                              <dt className="flex items-center gap-1 text-xs text-ink-3">
                                <ArrowUp aria-hidden="true" className="size-3" />
                                {t("knowledge_usage_input")}
                              </dt>
                              <dd className="mt-0.5 font-mono text-sm font-medium text-ink">
                                {rerankInput.toLocaleString()}
                                <span className="ms-1 text-xs font-sans font-normal text-ink-3">
                                  {t("knowledge_usage_tokens")}
                                </span>
                              </dd>
                            </div>
                          </div>
                        );
                      })()
                    : null}
                  {stats?.usage?.decision ? (
                    <div>
                      <p className="text-xs font-medium text-ink-3">{t("knowledge_usage_decision")}</p>
                      <div className="mt-2 rounded-xl border border-line bg-surface px-3 py-2.5">
                        <dt className="flex items-center gap-1 text-xs text-ink-3">
                          <ArrowUp aria-hidden="true" className="size-3" />
                          {t("knowledge_usage_input")}
                        </dt>
                        <dd className="mt-0.5 font-mono text-sm font-medium text-ink">
                          {stats.usage.decision.tokens.toLocaleString()}
                          <span className="ms-1 text-xs font-sans font-normal text-ink-3">
                            {t("knowledge_usage_tokens")}
                          </span>
                        </dd>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {llmTiles.length === 0 && !embed && !stats?.usage?.rerank && !stats?.usage?.decision ? (
                <p className="mt-4 text-[13px] text-ink-3">{t("knowledge_usage_empty")}</p>
              ) : null}
            </div>
          </Card>
        );
      })()}
      <Card>
        <div className="px-5 py-5 sm:px-6">
          <AdminHeader icon={Database} title={t("knowledge_admin_title")} />
          <dl className="mt-4 grid grid-cols-2 gap-2">
            {rows.map((row) => (
              <div className="rounded-xl border border-line bg-surface px-3 py-2.5" key={row.label}>
                <dt className="text-xs text-ink-3">{row.label}</dt>
                <dd className="mt-0.5 truncate text-sm font-medium text-ink">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="space-y-3 px-5 py-5 sm:px-6">
          {/* the snapshot pair: export downloads on the spot, import
              rides the file picker and the parent's confirm dialog */}
          <button
            className="flex w-full items-center justify-between rounded-xl border border-line px-4 py-3 text-start text-[13px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => {
              setBusy("export");
              void Promise.resolve(onExport()).finally(() => setBusy(null));
            }}
            type="button"
          >
            {t("knowledge_admin_export")}
            <FileDown aria-hidden="true" className="size-3.5" />
          </button>
          <p className="text-xs leading-relaxed text-ink-3">{t("knowledge_admin_export_desc")}</p>
          <button
            className="flex w-full items-center justify-between rounded-xl border border-line px-4 py-3 text-start text-[13px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => fileRef.current?.click()}
            type="button"
          >
            {t("knowledge_admin_import")}
            <FileUp aria-hidden="true" className="size-3.5" />
          </button>
          <p className="text-xs leading-relaxed text-ink-3">{t("knowledge_admin_import_desc")}</p>
          <input
            accept=".json,application/json"
            aria-hidden="true"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) {
                setBusy("import");
                void Promise.resolve(onImport(file)).finally(() => setBusy(null));
              }
            }}
            ref={fileRef}
            tabIndex={-1}
            type="file"
          />
          <button
            className="flex w-full items-center justify-between rounded-xl border border-danger/40 px-4 py-3 text-start text-[13px] text-danger transition-colors hover:bg-danger/5"
            onClick={onReset}
            type="button"
          >
            {t("knowledge_admin_reset")}
            <Trash2 aria-hidden="true" className="size-3.5" />
          </button>
          <p className="text-xs leading-relaxed text-ink-3">{t("knowledge_admin_reset_desc")}</p>
        </div>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ shared

/** The one confirm dialog every destructive action funnels through (the
    knowledge drawer's old pattern).  ALWAYS-MOUNTED with an `open` flag:
    the dismissal plays its exit animation (useExitPresence) instead of
    snapping out of the DOM -- the one dialog in the panel that still
    unmounted instantly. */
