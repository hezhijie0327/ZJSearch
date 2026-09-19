// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { LucideIcon } from "lucide-react";
import {
  Bug,
  Code,
  ExternalLink,
  Heart,
  Info,
  Link2,
  LoaderCircle,
  Mail,
  Network,
  Scale,
  Search,
  Server,
  Shield,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Shell } from "@/components/Shell.tsx";
import { fetchJson, fetchText } from "@/lib/http.ts";
import { type StringKey, useT } from "@/lib/i18n.ts";
import { extractPageData } from "@/lib/pageData.ts";
import { SEGMENT, SEGMENT_ACTIVE, SEGMENT_IDLE } from "@/lib/styles.ts";
import { type GlobalData, type InfoPageData, isInfoPageData } from "@/lib/types.ts";

/** Minimal config shape the instance page reads from GET /config. */
interface InstanceConfig {
  version: string;
  categories: string[];
  engines: Array<{ enabled: boolean }>;
  plugins: Array<{ enabled: boolean }>;
}

function useInstanceConfig(): InstanceConfig | null {
  const [config, setConfig] = useState<InstanceConfig | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchJson<InstanceConfig>("/config", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(setConfig)
      .catch(() => {
        /* quiet: sections that need it simply stay hidden */
      });
    return () => {
      controller.abort();
    };
  }, []);
  return config;
}

/** Client-side pages (instance / license) — they render as React content but
    sit in the same tab row as the upstream markdown pages. */
type VirtualPage = "instance" | "license";

type NavEntry =
  | { kind: "server"; pagename: string; locale: string; title: string; icon: LucideIcon }
  | { kind: "virtual"; pagename: VirtualPage; title: string; icon: LucideIcon };

/** Theme-side titles for the upstream pages — the server only renders them
    in languages the info markdown ships for (about_url falls back to en). */
const SERVER_PAGE_TITLES: Partial<Record<string, StringKey>> = {
  "search-syntax": "page_search_syntax",
  about: "page_about_searxng",
};

const SERVER_PAGE_ICONS: Partial<Record<string, LucideIcon>> = {
  "search-syntax": Search,
  about: Info,
};

/** Tab order: About SearXNG before Search syntax (the server payload lists
    them the other way around); unknown pages keep their relative order. */
const SERVER_PAGE_ORDER = ["about", "search-syntax"];

function serverPageOrder(pagename: string): number {
  const index = SERVER_PAGE_ORDER.indexOf(pagename);
  return index === -1 ? SERVER_PAGE_ORDER.length : index;
}

/** Fetches a license document and renders it verbatim; quiet when missing. */
function LicenseText({ url }: { url: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetchText(url, { signal: controller.signal })
      .then(setText)
      .catch(() => {
        /* quiet: the label row still renders */
      });
    return () => {
      controller.abort();
    };
  }, [url]);
  if (!text) {
    return null;
  }
  return (
    <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-3 font-mono text-xs leading-relaxed text-ink-2">
      {text}
    </pre>
  );
}

/** The theme's and the engine's licenses, full text side by side. */
function LicensePage() {
  const t = useT();
  return (
    <article className="prose-basic animate-fade-up" dir="auto">
      <h1>{t("license")}</h1>
      <div className="space-y-4">
        <div>
          <p className="text-[13px] font-medium text-ink-2">
            ZJSearch <span className="font-normal text-ink-3">· Apache-2.0 with Commons Clause v1.0</span>
          </p>
          <LicenseText url="/static/themes/zjsearch/LICENSE.txt" />
        </div>
        <div>
          <p className="text-[13px] font-medium text-ink-2">
            SearXNG <span className="font-normal text-ink-3">· AGPL-3.0-or-later</span>
          </p>
          <LicenseText url="/static/themes/zjsearch/LICENSE-SearXNG.txt" />
        </div>
      </div>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-surface px-4 py-3.5 text-center">
      <div className="text-xl font-semibold tabular-nums text-ink">{value}</div>
      <div className="mt-0.5 text-xs text-ink-3">{label}</div>
    </div>
  );
}

/** Live instance page: version, engines / categories / plugins counts and
    the configurable instance URLs (privacy policy, contact, public
    instances, settings.yml custom links). */
function InstancePage({ globals }: { globals: GlobalData }) {
  const t = useT();
  const config = useInstanceConfig();
  const links: Array<{ label: string; url: string; icon: LucideIcon }> = [];
  if (globals.donation_url) {
    links.push({ label: t("donate"), url: globals.donation_url, icon: Heart });
  }
  if (globals.git_url) {
    links.push({ label: t("source_code"), url: globals.git_url, icon: Code });
  }
  if (globals.issue_url) {
    links.push({ label: t("issue_tracker"), url: globals.issue_url, icon: Bug });
  }
  if (globals.privacypolicy_url) {
    links.push({ label: t("privacypolicy"), url: globals.privacypolicy_url, icon: Shield });
  }
  if (globals.contact_url) {
    links.push({ label: t("contact"), url: globals.contact_url, icon: Mail });
  }
  if (globals.public_instances_url) {
    links.push({ label: t("public_instances"), url: globals.public_instances_url, icon: Network });
  }
  for (const custom of globals.custom_links) {
    links.push({ label: custom.title, url: custom.url, icon: Link2 });
  }
  return (
    <article className="prose-basic animate-fade-up" dir="auto">
      <h1 className="flex items-center gap-2">
        <Server aria-hidden="true" className="size-5 shrink-0 text-accent" />
        {globals.instance_name}
      </h1>
      <p className="font-mono text-xs text-ink-3" dir="ltr">
        v{config?.version || globals.version}
      </p>
      {config ? (
        <div className="my-5 grid grid-cols-3 gap-px overflow-hidden rounded-2xl border border-line bg-line">
          <Stat label={t("engines")} value={config.engines.filter((engine) => engine.enabled).length} />
          <Stat label={t("categories")} value={config.categories.length} />
          <Stat label={t("plugins")} value={config.plugins.filter((plugin) => plugin.enabled).length} />
        </div>
      ) : null}
      {links.length > 0 ? (
        <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
          {links.map((link) => {
            const Icon = link.icon;
            return (
              <a
                className="flex items-center gap-3 px-4 py-3 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                href={link.url}
                key={link.url}
                rel="noreferrer"
                target="_blank"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-3">
                  <Icon className="size-4" />
                </span>
                <span className="font-medium">{link.label}</span>
                <ExternalLink className="ms-auto size-3.5 shrink-0 text-ink-3" />
              </a>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}

export function InfoPage({
  data,
  embedded = false,
  initialPagename,
}: {
  data: InfoPageData;
  embedded?: boolean;
  initialPagename?: string;
}) {
  const globals = data.globals;
  const t = useT();
  const [active, setActive] = useState<{ pagename: string; html: string | null }>(() => {
    // the drawer opens on the instance page unless the entry point asks for
    // a specific tab (hero "Powered by SearXNG" note → About SearXNG);
    // standalone URLs stay faithful to the address bar
    if (embedded && !initialPagename) {
      return { pagename: "instance", html: null };
    }
    return { pagename: data.active_pagename, html: data.active_html };
  });
  const [switching, setSwitching] = useState(false);
  const cacheRef = useRef(new Map<string, InfoPageData>());
  const seqRef = useRef(0);

  const nav: NavEntry[] = [
    { kind: "virtual", pagename: "instance", title: t("about_instance"), icon: Server },
    ...data.pages
      .map(
        (page): NavEntry => ({
          kind: "server",
          ...page,
          title: SERVER_PAGE_TITLES[page.pagename] ? t(SERVER_PAGE_TITLES[page.pagename] as StringKey) : page.title,
          icon: SERVER_PAGE_ICONS[page.pagename] ?? Info,
        }),
      )
      .sort(
        (a, b) =>
          serverPageOrder(a.kind === "server" ? a.pagename : "") -
          serverPageOrder(b.kind === "server" ? b.pagename : ""),
      ),
    { kind: "virtual", pagename: "license", title: t("license"), icon: Scale },
  ];

  /** Swap the tab panel in place: client-side pages are pure state, server
      pages are fetched once and cached.  Server pages update the URL via
      replaceState (no history spam, no scroll jump); a failed fetch falls
      back to a real navigation. */
  const openPage = (entry: NavEntry) => {
    if (entry.kind === "virtual") {
      setActive({ pagename: entry.pagename, html: null });
      return;
    }
    const href = `/info/${entry.locale}/${entry.pagename}`;
    if (active.pagename === entry.pagename && active.html !== null) {
      return;
    }
    const cached = cacheRef.current.get(entry.pagename);
    if (cached) {
      setActive({ pagename: entry.pagename, html: cached.active_html });
      if (!embedded) {
        window.history.replaceState(null, "", href);
      }
      return;
    }
    const seq = ++seqRef.current;
    setSwitching(true);
    void fetchText(href, { headers: { Accept: "text/html" } })
      .then((html) => {
        const pageData = extractPageData(html);
        if (!isInfoPageData(pageData)) {
          throw new Error("unexpected page data");
        }
        cacheRef.current.set(entry.pagename, pageData);
        if (seq !== seqRef.current) {
          return;
        }
        setSwitching(false);
        setActive({ pagename: entry.pagename, html: pageData.active_html });
        if (!embedded) {
          window.history.replaceState(null, "", href);
        }
      })
      .catch(() => {
        if (seq !== seqRef.current) {
          return;
        }
        window.location.assign(href);
      });
  };

  const panelId = useId();
  return (
    <Shell embedded={embedded} globals={globals}>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-16 sm:px-6">
        <nav
          aria-label={t("info_pages")}
          className="mb-6 mt-5 flex flex-wrap gap-1.5 rounded-2xl border border-line bg-surface p-2"
          role="tablist"
        >
          {nav.map((entry) => {
            const isActive = entry.pagename === active.pagename;
            const Icon = entry.icon;
            return (
              <button
                aria-controls={panelId}
                aria-selected={isActive}
                className={`${SEGMENT} flex-1 ${isActive ? SEGMENT_ACTIVE : SEGMENT_IDLE}`}
                id={`info-tab-${entry.pagename}`}
                key={entry.kind === "server" ? `${entry.locale}/${entry.pagename}` : entry.pagename}
                onClick={() => {
                  openPage(entry);
                }}
                role="tab"
                type="button"
              >
                <Icon className="size-3.5" />
                <span>{entry.title}</span>
              </button>
            );
          })}
        </nav>
        <div aria-labelledby={`info-tab-${active.pagename}`} id={panelId} role="tabpanel">
          {switching ? (
            <div className="flex justify-center py-20 text-ink-3">
              <LoaderCircle className="size-5 animate-spin-slow" />
            </div>
          ) : active.html !== null ? (
            <article
              className="prose-basic animate-fade-up"
              dangerouslySetInnerHTML={{ __html: active.html }}
              dir="auto"
            />
          ) : active.pagename === "license" ? (
            <LicensePage />
          ) : (
            <InstancePage globals={globals} />
          )}
        </div>
      </main>
    </Shell>
  );
}
