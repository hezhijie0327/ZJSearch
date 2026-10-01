// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ChartColumn, History, Info, SlidersHorizontal } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import { BrandDot } from "@/components/Brand.tsx";
import { siteConfig } from "@/config/site.ts";
import { useOverlay } from "@/features/overlay/OverlayProvider.tsx";
import { useT } from "@/lib/i18n.ts";
import { isModifiedClick, newTabLinkProps } from "@/lib/link.ts";
import { useRouter } from "@/lib/router.tsx";
import { ICON_BTN, SCROLLBAR_NONE } from "@/lib/styles.ts";
import type { GlobalData } from "@/lib/types.ts";

/** Anchor that performs SPA navigation for internal URLs. */
export function Link({
  href,
  children,
  className,
  ariaLabel,
  title,
  external,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  title?: string;
  external?: boolean;
}) {
  const { navigate } = useRouter();
  const internal = href.startsWith("/") && !external;

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!internal || isModifiedClick(event)) {
      return;
    }
    event.preventDefault();
    navigate(href);
  };

  return (
    <a
      className={className}
      href={href}
      onClick={onClick}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...(title ? { title } : {})}
      {...newTabLinkProps(external)}
    >
      {children}
    </a>
  );
}

function ProgressBar({ active }: { active: boolean }) {
  if (!active) {
    return null;
  }
  // purely decorative: the search box spinner already announces loading
  return (
    <div aria-hidden="true" className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden">
      <div className="h-full w-full origin-left bg-accent-strong animate-progress" />
    </div>
  );
}

/** The AI history drawer, lazy-loaded (it lives in the results feature
    tree) and hosted here: the browser-local history is a GLOBAL affordance
    now that PGlite backs it -- not an AI-page strip button. */
const LazyAiHistoryDrawer = lazy(() =>
  import("@/features/results/aiSearch/AiHistoryDrawer.tsx").then((m) => ({ default: m.AiHistoryDrawer })),
);

function HistoryButton({ globals }: { globals: GlobalData }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // the thread on screen (its drawer row renders highlighted), derived
  // from the URL at render
  const currentId = /\/ai\/thread\/([\w-]+)/.exec(window.location.pathname)?.[1];
  if (!globals.ai_search && !globals.ai) {
    return null;
  }
  return (
    <>
      <button
        aria-label={t("ai_history")}
        className={ICON_BTN}
        onClick={() => {
          setOpen(true);
        }}
        title={t("ai_history")}
        type="button"
      >
        <History className="size-4.5" />
      </button>
      {open ? (
        <Suspense fallback={null}>
          <LazyAiHistoryDrawer
            currentId={currentId}
            initialMode={
              (globals.ai_search as { history_mode?: "hybrid" | "keyword" | "semantic" } | undefined)?.history_mode ??
              "keyword"
            }
            onClose={() => {
              setOpen(false);
            }}
            onNavigate={(url) => {
              window.history.pushState({}, "", url);
              window.dispatchEvent(new PopStateEvent("popstate"));
              setOpen(false);
            }}
            open
          />
        </Suspense>
      ) : null}
    </>
  );
}

/** Right-side icon group: History / About / Stats / Preferences open as
    slide-in panels (URL unchanged); theme style lives in the preferences
    panel. */
export function HeaderActions({ globals }: { globals: GlobalData }) {
  const t = useT();
  const { openOverlay } = useOverlay();
  return (
    <div className="zjs-print-hide flex items-center gap-0.5 sm:gap-1">
      <HistoryButton globals={globals} />
      {globals.about_url ? (
        <button
          aria-label={t("about")}
          className={ICON_BTN}
          onClick={() => {
            openOverlay(globals.about_url, t("about"));
          }}
          title={t("about")}
          type="button"
        >
          <Info className="size-4.5" />
        </button>
      ) : null}
      {globals.enable_metrics ? (
        <button
          aria-label={t("engine_stats")}
          className={ICON_BTN}
          onClick={() => {
            openOverlay("/stats", t("engine_stats"));
          }}
          title={t("engine_stats")}
          type="button"
        >
          <ChartColumn className="size-4.5" />
        </button>
      ) : null}
      <button
        aria-label={t("preferences")}
        className={ICON_BTN}
        onClick={() => {
          openOverlay("/preferences", t("preferences"));
        }}
        title={t("preferences")}
        type="button"
      >
        <SlidersHorizontal className="size-4.5" />
      </button>
    </div>
  );
}

/** Standalone top bar used by full pages (preferences/stats/info/404). */
function TopNav({ globals, hideBrand = false }: { globals: GlobalData; hideBrand?: boolean }) {
  return (
    <nav className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
      {hideBrand ? (
        <span aria-hidden="true" />
      ) : (
        <Link ariaLabel={globals.instance_name} className="shrink-0 select-none" href="/" title={globals.instance_name}>
          <span className="font-serif text-2xl font-semibold tracking-tight text-ink">
            {globals.instance_name}
            <BrandDot />
          </span>
        </Link>
      )}
      <HeaderActions globals={globals} />
    </nav>
  );
}

function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="mx-auto w-full max-w-5xl px-4 pb-8 text-center text-xs text-ink-3 sm:px-6">
      <p className="leading-5">
        © {year} {siteConfig.copyright}
      </p>
    </footer>
  );
}

export function Shell({
  globals,
  children,
  variant = "page",
  hideTopNav = false,
  embedded = false,
}: {
  globals: GlobalData;
  children: ReactNode;
  variant?: "page" | "hero";
  /** results page renders the actions inside its own header */
  hideTopNav?: boolean;
  /** panel mode: page content only, no top bar / footer */
  embedded?: boolean;
}) {
  const { loading } = useRouter();
  const hero = variant === "hero";
  // hero shell owns scrolling: the document itself never scrolls (no iOS
  // rubber-band pushing the layout around); overflow lives in the shell's
  // inner container
  useEffect(() => {
    if (!hero) {
      return;
    }
    document.documentElement.classList.add("zjs-hero-lock");
    return () => {
      document.documentElement.classList.remove("zjs-hero-lock");
    };
  }, [hero]);
  if (embedded) {
    return (
      <div className="relative">
        <ProgressBar active={loading} />
        {children}
      </div>
    );
  }
  if (hero) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden">
        <ProgressBar active={loading} />
        <TopNav globals={globals} hideBrand />
        {/* app-shell scroll area: hidden scrollbar, contained overscroll; the
            footer rides inside so it scrolls away with overflowing content */}
        <div className={`flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain ${SCROLLBAR_NONE}`}>
          <div className="flex flex-1 flex-col justify-start pt-[20vh] sm:pt-[30vh]">{children}</div>
          <Footer />
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-dvh flex-col">
      <ProgressBar active={loading} />
      {hideTopNav ? null : <TopNav globals={globals} hideBrand={false} />}
      <div className="flex flex-1 flex-col">{children}</div>
      <Footer />
    </div>
  );
}
