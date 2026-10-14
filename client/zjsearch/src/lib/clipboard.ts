// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useT } from "@/lib/i18n.ts";
import { flashToast } from "@/lib/toast.ts";

/** Raw clipboard write shared by every copy path (buttons, wrappers,
    hotkeys).  Copy confirmation is rendered by `flashToast` in
    `lib/toast.ts` — one green 「已复制」 pill app-wide. */
function writeClipboard(value: string): Promise<boolean> {
  return navigator.clipboard
    .writeText(value)
    .then(() => true)
    .catch(() => false);
}

/** React flavour of the copy idiom: write + the shared green 「已复制」
    toast.  Every copy action goes through this (or writeClipboard directly
    when it confirms some other way) so the feedback never drifts. */
export function useCopyToast(): (value: string) => void {
  const t = useT();
  return (value: string) => {
    void writeClipboard(value).then((ok) => {
      if (ok) {
        flashToast(t("copied"), { tone: "ok" });
      }
    });
  };
}
