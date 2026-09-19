// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { AlertTriangle, ExternalLink, Sparkle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { DropdownOption } from "@/components/Dropdown.tsx";
import { Dropdown } from "@/components/Dropdown.tsx";
import { Link } from "@/components/Shell.tsx";
import { loadEngineDescriptions } from "@/lib/engineDescriptions.ts";
import { type StringKey, type Translate, useT } from "@/lib/i18n.ts";
import { CODE_CHIP } from "@/lib/styles.ts";
import type { EngineEntry } from "@/lib/types.ts";

export { CategoryTab } from "@/components/CategoryTab.tsx";

// ------------------------------------------------------------ layout blocks

function IconTile({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">{children}</span>
  );
}

/** One settings row: icon tile + title/description on the left, control on the right. */
export function SettingRow({
  icon,
  title,
  description,
  children,
  stacked,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="px-5 py-5 transition-colors hover:bg-surface-2/40 sm:px-6">
        <div className="flex items-center gap-4">
          <IconTile>{icon}</IconTile>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{title}</p>
            {description ? <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{description}</p> : null}
          </div>
        </div>
        {children ? <div className="mt-4 sm:pl-14">{children}</div> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 px-5 py-5 transition-colors hover:bg-surface-2/40 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:px-6">
      <div className="flex min-w-0 items-center gap-4">
        <IconTile>{icon}</IconTile>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{title}</p>
          {description ? <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{description}</p> : null}
        </div>
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface animate-fade-up">
      {children}
    </div>
  );
}

/** Section header inside a Card — Card's divide-y draws the separators, so a
    Fragment of header + rows works as one group. */
export function SectionLabel({ label }: { label: string }) {
  return <p className="bg-surface-2/60 px-5 py-2.5 text-xs font-medium text-ink-3 sm:px-6">{label}</p>;
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        // the knob must keep >=3:1 against its track in every palette: light
        // pairs the amber track with the dark accent-contrast knob, dark and
        // black invert it — dark amber track with the amber knob on top
        checked ? "bg-accent-strong dark:bg-accent-soft" : "bg-surface-2 ring-1 ring-line"
      }`}
      onClick={() => {
        onChange(!checked);
      }}
      role="switch"
      type="button"
    >
      <span
        className={`size-5 rounded-full shadow transition-transform ${
          // translate-x is physical: RTL tracks must move the knob the other way
          checked
            ? "translate-x-5 rtl:-translate-x-5 bg-accent-contrast dark:bg-accent-strong"
            : "translate-x-0 bg-ink-3"
        }`}
      />
    </button>
  );
}

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="w-full sm:w-60">
      <Dropdown align="end" ariaLabel={ariaLabel} onChange={onChange} options={options} value={value} variant="boxed" />
    </div>
  );
}

/** ZJSearch-side translations for the plugins our deployments ship (the
    upstream server catalogs only cover upstream plugins and searx/ stays
    untouched). Unknown plugin ids fall back to the server strings. */
const PLUGIN_I18N: Record<string, { description: StringKey; name: StringKey }> = {
  advanced_search_syntax: {
    description: "plugin_advanced_search_syntax_desc",
    name: "plugin_advanced_search_syntax",
  },
  ahmia_filter: { description: "plugin_ahmia_filter_desc", name: "plugin_ahmia_filter" },
  bm25_reranker: { description: "plugin_bm25_reranker_desc", name: "plugin_bm25_reranker" },
  calculator: { description: "plugin_calculator_desc", name: "plugin_calculator" },
  currency_convert: { description: "plugin_currency_convert_desc", name: "plugin_currency_convert" },
  hash_plugin: { description: "plugin_hash_plugin_desc", name: "plugin_hash_plugin" },
  hostnames: { description: "plugin_hostnames_desc", name: "plugin_hostnames" },
  infiniteScroll: { description: "plugin_infinite_scroll_desc", name: "plugin_infinite_scroll" },
  oa_doi_rewrite: { description: "plugin_oa_doi_rewrite_desc", name: "plugin_oa_doi_rewrite" },
  self_info: { description: "plugin_self_info_desc", name: "plugin_self_info" },
  stock_quote: { description: "plugin_stock_quote_desc", name: "plugin_stock_quote" },
  time_zone: { description: "plugin_time_zone_desc", name: "plugin_time_zone" },
  tor_check: { description: "plugin_tor_check_desc", name: "plugin_tor_check" },
  tracker_url_remover: {
    description: "plugin_tracker_url_remover_desc",
    name: "plugin_tracker_url_remover",
  },
  unit_converter: { description: "plugin_unit_converter_desc", name: "plugin_unit_converter" },
};

function pluginLabels(
  plugin: { id: string; name: string; description: string },
  t: Translate,
): { description: string; name: string } {
  const keys = PLUGIN_I18N[plugin.id];
  return keys
    ? { description: t(keys.description), name: t(keys.name) }
    : { description: plugin.description, name: plugin.name };
}

export function PluginRow({
  plugin,
  enabled,
  onChange,
  icon,
  keywords,
}: {
  plugin: { id: string; name: string; description: string };
  enabled: boolean;
  onChange: (checked: boolean) => void;
  icon?: ReactNode;
  keywords?: string[];
}) {
  const t = useT();
  const labels = pluginLabels(plugin, t);
  // query plugins carry their trigger keywords — show them as code chips so
  // the plugins tab keeps the documentation the old query table had
  const description: ReactNode =
    keywords && keywords.length > 0 ? (
      <>
        {labels.description}
        <span className="mt-1 flex flex-wrap gap-1">
          {keywords.map((keyword) => (
            <code className={CODE_CHIP} key={keyword}>
              {keyword}
            </code>
          ))}
        </span>
      </>
    ) : (
      labels.description
    );
  return (
    <SettingRow description={description} icon={icon ?? <Sparkle className="size-4.5" />} title={labels.name}>
      <Switch checked={enabled} label={labels.name} onChange={onChange} />
    </SettingRow>
  );
}

// ------------------------------------------------------------------ engines

export function EngineTooltip({ engine, pinned = false }: { engine: EngineEntry; pinned?: boolean }) {
  const t = useT();
  const [desc, setDesc] = useState<{ text: string; source: string } | null>(null);
  useEffect(() => {
    void loadEngineDescriptions().then((map) => {
      const entry = map[engine.name];
      if (entry) {
        setDesc({ text: entry[0], source: entry[1] });
      }
    });
  }, [engine.name]);

  return (
    <div
      className={`pointer-events-none absolute start-0 top-full z-30 mt-1 hidden w-80 rounded-xl border border-line bg-surface p-3 text-xs shadow-pop group-hover/engine:block group-focus-within/engine:block ${
        pinned ? "block" : ""
      }`}
    >
      {desc ? (
        <p className="text-ink-2">
          {desc.text}{" "}
          <i className="text-ink-3">
            ({t("source")}: {desc.source})
          </i>
        </p>
      ) : (
        <p className="text-ink-3">…</p>
      )}
      {engine.website ? (
        <p className="mt-1.5 truncate">
          <a
            className="inline-flex items-center gap-1 text-accent hover:underline"
            href={engine.website}
            rel="noreferrer"
            target="_blank"
          >
            {engine.website}
            <ExternalLink className="size-3" />
          </a>
        </p>
      ) : null}
      {engine.wikidata_id ? (
        <p className="mt-1.5 truncate">
          <a
            className="inline-flex items-center gap-1 text-accent hover:underline"
            dir="ltr"
            href={`https://www.wikidata.org/wiki/${engine.wikidata_id}`}
            rel="noreferrer"
            target="_blank"
          >
            wikidata.org/wiki/{engine.wikidata_id}
            <ExternalLink className="size-3" />
          </a>
        </p>
      ) : null}
      {engine.enable_http ? (
        <p className="mt-1.5 inline-flex items-center gap-1 text-warning">
          <AlertTriangle className="size-3.5" /> {t("no_https")}
        </p>
      ) : null}
      <p className="mt-1.5 flex flex-wrap gap-1">
        <span className="text-ink-3">!bang:</span>
        {[engine.name, engine.shortcut].map((bang) => (
          <code className={CODE_CHIP} key={bang}>
            !{bang.replaceAll(" ", "_")}
          </code>
        ))}
      </p>
      {engine.errors.length > 0 ? (
        <p className="mt-1.5">
          <Link className="text-accent hover:underline" href={`/stats?engine=${encodeURIComponent(engine.name)}`}>
            {t("view_error_logs")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
