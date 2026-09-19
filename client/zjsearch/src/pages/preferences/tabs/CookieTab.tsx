// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Cookie, ExternalLink, Key, Link as LinkIcon, RefreshCw, Trash2 } from "lucide-react";
import { ClickToCopy } from "@/components/CopyButton.tsx";
import { Link } from "@/components/Shell.tsx";
import { useT } from "@/lib/i18n.ts";
import type { PreferencesPageData } from "@/lib/types.ts";
import { Card, SectionLabel, SettingRow } from "@/pages/preferences/parts.tsx";
import type { PreferencesForm } from "@/pages/preferences/usePreferencesForm.ts";

/** Cookie transparency: what this instance stores in the visitor's browser,
    plus the preference-share URLs and hash for restoring settings elsewhere —
    in the shared Card + SectionLabel language of the other tabs. */
export function CookieTab({ data, form }: { data: PreferencesPageData; form: PreferencesForm }) {
  const t = useT();
  const shareOrigin = window.location.origin;
  return (
    <Card>
      <SectionLabel label={t("cookie_group_stored")} />
      <SettingRow description={t("cookies_list_desc")} icon={<Cookie className="size-4.5" />} title={t("cookies")} />
      {data.cookies.length > 0 ? (
        <div className="w-full overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface-2 text-ink-3">
              <tr>
                <th className="px-4 py-2 font-medium sm:px-6">{t("cookie_name")}</th>
                <th className="px-4 py-2 font-medium">{t("value")}</th>
              </tr>
            </thead>
            <tbody>
              {data.cookies.map((cookie) => (
                <tr className="border-t border-line" key={cookie.name}>
                  <td className="px-4 py-1.5 font-mono sm:px-6">{cookie.name}</td>
                  <td className="px-4 py-1.5 break-all" title={cookie.value.length > 64 ? cookie.value : undefined}>
                    {cookie.value.length > 64 ? `${cookie.value.slice(0, 64)}…` : cookie.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="flex items-center gap-3 px-5 py-4 text-xs text-ink-3 sm:px-6">
          <Cookie className="size-4" />
          {t("no_cookies")}
        </p>
      )}

      <SectionLabel label={t("cookie_group_share")} />
      <SettingRow
        description={t("prefs_url_privacy_note")}
        icon={<LinkIcon className="size-4.5" />}
        stacked
        title={t("search_url_of_prefs")}
      >
        <ClickToCopy className="mt-2" value={`${shareOrigin}/?preferences=${data.preferences_url_params}&q=%s`}>
          <pre
            className="max-h-28 min-w-0 overflow-y-auto rounded-xl bg-surface-2 p-3 font-mono text-xs break-all whitespace-pre-wrap text-ink-2"
            dir="ltr"
          >
            {shareOrigin}/?preferences={data.preferences_url_params}&amp;q=%s
          </pre>
        </ClickToCopy>
      </SettingRow>
      <SettingRow
        description={t("url_restore_desc")}
        icon={<ExternalLink className="size-4.5" />}
        stacked
        title={t("url_to_restore")}
      >
        <ClickToCopy className="mt-2" value={`${shareOrigin}/preferences?preferences=${data.preferences_url_params}`}>
          <pre
            className="max-h-28 min-w-0 overflow-y-auto rounded-xl bg-surface-2 p-3 font-mono text-xs break-all whitespace-pre-wrap text-ink-2"
            dir="ltr"
          >
            {shareOrigin}/preferences?preferences={data.preferences_url_params}
          </pre>
        </ClickToCopy>
      </SettingRow>
      <SettingRow icon={<Key className="size-4.5" />} stacked title={t("copy_prefs_hash")}>
        <ClickToCopy value={data.preferences_url_params}>
          <pre
            className="max-h-28 min-w-0 overflow-y-auto rounded-xl bg-surface-2 p-3 font-mono text-xs break-all whitespace-pre-wrap text-ink-2"
            dir="ltr"
          >
            {data.preferences_url_params}
          </pre>
        </ClickToCopy>
      </SettingRow>
      <SettingRow icon={<RefreshCw className="size-4.5" />} stacked title={t("insert_prefs_hash")}>
        <input
          aria-label={t("insert_prefs_hash")}
          className="h-9 w-full rounded-xl border border-line bg-surface px-3 text-[13px] transition-colors hover:border-ink-3"
          onChange={(event) => {
            form.setPastedHash(event.target.value);
          }}
          placeholder={t("prefs_hash")}
          type="text"
          value={form.pastedHash}
        />
      </SettingRow>
      <SettingRow
        description={
          <>
            {t("settings_in_cookies")}
            <br />
            {t("cookies_convenience")}
          </>
        }
        icon={<Trash2 className="size-4.5" />}
        stacked
        title={t("reset_defaults")}
      >
        <Link
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-danger hover:text-danger"
          href="/clear_cookies"
        >
          <RefreshCw className="size-3.5" />
          {t("reset_defaults")}
        </Link>
      </SettingRow>
    </Card>
  );
}
