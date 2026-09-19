// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Keyboard shortcuts help dialog (opened with "?"). */

import { X } from "lucide-react";
import { useEffect } from "react";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { type Translate, useT } from "@/lib/i18n.ts";
import { ICON_BTN } from "@/lib/styles.ts";

interface HelpColumn {
  title: string;
  rows: Array<[string, string]>;
}

function shortcutRows(layout: "default" | "vim", t: Translate): Array<[string, string]> {
  if (layout === "vim") {
    return [
      ["?", t("help_show_hide")],
      ["j", t("help_focus_next")],
      ["k", t("help_focus_prev")],
      ["n", t("help_page_next")],
      ["p", t("help_page_prev")],
      ["o ⏎", t("help_open")],
      ["v", t("help_open_new_tab")],
      ["y", t("help_yank")],
      ["i", t("help_focus_search")],
      ["Esc", t("help_esc")],
    ];
  }
  return [
    ["? / ?", t("help_show_hide")],
    ["↓", t("help_focus_next")],
    ["↑", t("help_focus_prev")],
    ["→", t("help_page_next")],
    ["←", t("help_page_prev")],
    ["o ⏎", t("help_open")],
    ["t", t("help_open_new_tab")],
    ["y", t("help_yank")],
    ["i /", t("help_focus_search")],
    ["Esc", t("help_esc")],
  ];
}

function operatorRows(t: Translate): Array<[string, string]> {
  return [
    ["site:", t("op_site")],
    ["filetype:", t("op_filetype")],
    ["before:/after:", t("op_dates")],
    ['"words"', t("op_exact")],
    ["+term", t("op_include")],
    ["-term", t("op_exclude")],
    ["intitle:", t("op_intitle")],
    ["inurl:", t("op_inurl")],
    ["intext:", t("op_intext")],
  ];
}

function bangRows(t: Translate): Array<[string, string]> {
  return [
    ["!bang", t("bang_all")],
    ["!wp", t("bang_engine")],
    [":fr", t("bang_lang")],
    ["!!bang", t("bang_external")],
    ["!!", t("bang_lucky")],
  ];
}

function widgetRows(t: Translate): Array<[string, string]> {
  return [
    ["uuid", t("widget_random")],
    ["avg 1 2 3", t("widget_stats")],
    ["1+2", t("widget_calc")],
    ["5m to cm", t("widget_unit")],
    ["5 usd to cny", t("widget_currency")],
    ["$AAPL", t("widget_stock")],
    ["time Berlin", t("widget_time")],
    ["ip", t("widget_ip")],
    ["user-agent", t("widget_ua")],
    ["md5 hello", t("widget_hash")],
    ["tor-check", t("widget_tor")],
  ];
}

export function HelpModal({ layout, onClose }: { layout: "default" | "vim"; onClose: () => void }) {
  const t = useT();
  const dialogRef = useDialogFocus<HTMLDivElement>();

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const columns: HelpColumn[] = [
    { title: t("help_shortcuts"), rows: shortcutRows(layout, t) },
    { title: t("help_operators"), rows: operatorRows(t) },
    { title: t("help_bangs"), rows: bangRows(t) },
    { title: t("help_widgets"), rows: widgetRows(t) },
  ];

  return (
    <div aria-modal="true" className="fixed inset-0 z-50 animate-fade-in" ref={dialogRef} role="dialog" tabIndex={-1}>
      <button
        aria-label={t("close")}
        className="absolute inset-0 cursor-default bg-black/60"
        onClick={onClose}
        type="button"
      />
      <div className="pointer-events-none absolute inset-0 grid place-items-center p-4">
        <div className="pointer-events-auto max-h-[86dvh] w-full max-w-5xl overflow-auto rounded-2xl border border-line bg-surface p-6 shadow-pop animate-fade-up lg:max-w-6xl">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">{t("hotkeys")}</h2>
            <button aria-label={t("close")} className={ICON_BTN} data-dialog-close="" onClick={onClose} type="button">
              <X className="size-4.5" />
            </button>
          </div>
          <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            {columns.map((column) => (
              <section key={column.title}>
                <h3 className="mb-2 border-b border-line pb-2 text-base font-semibold text-ink">{column.title}</h3>
                <dl className="space-y-2">
                  {column.rows.map(([keys, description]) => (
                    <div
                      className="grid grid-cols-[6rem_1fr] items-baseline gap-3 sm:grid-cols-[7.5rem_1fr]"
                      key={keys}
                    >
                      <dt className="text-right font-mono text-xs font-semibold text-accent">{keys}</dt>
                      <dd className="text-[13px] leading-relaxed text-ink-2">{description}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
