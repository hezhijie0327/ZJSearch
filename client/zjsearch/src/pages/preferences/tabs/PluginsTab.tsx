// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import {
  ArrowDownToLine,
  Banknote,
  Blocks,
  BookOpen,
  Calculator,
  ChartCandlestick,
  Clock,
  Code,
  Dices,
  Eraser,
  Filter,
  Globe,
  Hash,
  ListOrdered,
  Network,
  Ruler,
  ShieldCheck,
  Sigma,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { type StringKey, useT } from "@/lib/i18n.ts";
import { CODE_CHIP } from "@/lib/styles.ts";
import type { PreferencesPageData } from "@/lib/types.ts";
import { Card, PluginRow, SectionLabel, SettingRow } from "@/pages/preferences/parts.tsx";
import type { PreferencesForm } from "@/pages/preferences/usePreferencesForm.ts";

/** One dedicated icon per plugin — the old rows all shared Sparkle and read
    as a wall of identical switches. Third-party plugins we don't ship an
    icon for get the generic Blocks mark. */
const FALLBACK_PLUGIN_ICON = <Blocks className="size-4.5" />;

const PLUGIN_ICONS: Record<string, ReactNode> = {
  advanced_search_syntax: <Code className="size-4.5" />,
  ahmia_filter: <Filter className="size-4.5" />,
  bm25_reranker: <ListOrdered className="size-4.5" />,
  calculator: <Calculator className="size-4.5" />,
  currency_convert: <Banknote className="size-4.5" />,
  hash_plugin: <Hash className="size-4.5" />,
  hostnames: <Globe className="size-4.5" />,
  infiniteScroll: <ArrowDownToLine className="size-4.5" />,
  oa_doi_rewrite: <BookOpen className="size-4.5" />,
  self_info: <Network className="size-4.5" />,
  stock_quote: <ChartCandlestick className="size-4.5" />,
  time_zone: <Clock className="size-4.5" />,
  tor_check: <ShieldCheck className="size-4.5" />,
  tracker_url_remover: <Eraser className="size-4.5" />,
  unit_converter: <Ruler className="size-4.5" />,
};

/** Functional grouping for the plugins tab — every plugin used to sit at the
    tail of whichever settings tab its server-side preference_section named.
    Groups are the units users think in: what runs on the query, what rewrites
    results, what converts, what changes the UI. Anything unknown (third-party
    plugins) lands in the trailing catch-all group. */
const PLUGIN_GROUPS: Array<{ id: StringKey; plugins: string[] }> = [
  {
    id: "plugin_group_query",
    plugins: [
      "advanced_search_syntax",
      "calculator",
      "hash_plugin",
      "self_info",
      "stock_quote",
      "time_zone",
      "tor_check",
    ],
  },
  {
    id: "plugin_group_results",
    plugins: ["ahmia_filter", "bm25_reranker", "hostnames", "oa_doi_rewrite", "tracker_url_remover"],
  },
  { id: "plugin_group_convert", plugins: ["currency_convert", "unit_converter"] },
  { id: "plugin_group_ui", plugins: ["infiniteScroll"] },
];

/** ZJSearch-side labels for the built-in answerers (server strings stay
    untranslated — same rationale as PLUGIN_I18N in parts.tsx). */
const ANSWERER_I18N: Record<string, { description: StringKey; name: StringKey }> = {
  "Random value generator": { description: "answerer_random_desc", name: "answerer_random" },
  "Statistics functions": { description: "answerer_stats_desc", name: "answerer_stats" },
};

const ANSWERER_ICONS: Record<string, ReactNode> = {
  "Random value generator": <Dices className="size-4.5" />,
  "Statistics functions": <Sigma className="size-4.5" />,
};

export function PluginsTab({ data, form }: { data: PreferencesPageData; form: PreferencesForm }) {
  const t = useT();
  const byId = new Map(data.plugins.map((plugin) => [plugin.id, plugin]));
  const grouped = new Set(PLUGIN_GROUPS.flatMap((group) => group.plugins));
  const others = data.plugins.filter((plugin) => !grouped.has(plugin.id));
  const answererLabels = (name: string, description: string) => {
    const keys = ANSWERER_I18N[name];
    return keys ? { description: t(keys.description), name: t(keys.name) } : { description, name };
  };
  return (
    <Card>
      {PLUGIN_GROUPS.map((group) => {
        const plugins = group.plugins.flatMap((id) => {
          const plugin = byId.get(id);
          return plugin ? [plugin] : [];
        });
        if (plugins.length === 0) {
          return null;
        }
        return (
          <Fragment key={group.id}>
            <SectionLabel label={t(group.id)} />
            {plugins.map((plugin) => (
              <PluginRow
                enabled={form.plugins[plugin.id] ?? false}
                icon={PLUGIN_ICONS[plugin.id] ?? FALLBACK_PLUGIN_ICON}
                key={plugin.id}
                keywords={plugin.keywords}
                onChange={(checked) => {
                  form.setPluginEnabled(plugin.id, checked);
                }}
                plugin={plugin}
              />
            ))}
          </Fragment>
        );
      })}
      {others.length > 0 ? (
        <Fragment>
          <SectionLabel label={t("cat_other")} />
          {others.map((plugin) => (
            <PluginRow
              enabled={form.plugins[plugin.id] ?? false}
              icon={PLUGIN_ICONS[plugin.id] ?? FALLBACK_PLUGIN_ICON}
              key={plugin.id}
              keywords={plugin.keywords}
              onChange={(checked) => {
                form.setPluginEnabled(plugin.id, checked);
              }}
              plugin={plugin}
            />
          ))}
        </Fragment>
      ) : null}
      {data.answerers.length > 0 ? (
        <Fragment>
          <SectionLabel label={t("instant_answers")} />
          {data.answerers.map((answerer) => {
            const labels = answererLabels(answerer.name, answerer.description);
            return (
              <SettingRow
                description={
                  <>
                    {labels.description}
                    <span className="mt-1 flex flex-wrap gap-1">
                      {answerer.keywords.map((keyword) => (
                        <code className={CODE_CHIP} key={keyword}>
                          {keyword}
                        </code>
                      ))}
                    </span>
                  </>
                }
                icon={ANSWERER_ICONS[answerer.name] ?? FALLBACK_PLUGIN_ICON}
                key={answerer.name}
                title={labels.name}
              />
            );
          })}
        </Fragment>
      ) : null}
    </Card>
  );
}
