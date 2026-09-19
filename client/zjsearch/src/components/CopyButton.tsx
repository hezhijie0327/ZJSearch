// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { ReactNode } from "react";
import { useCopyToast } from "@/lib/clipboard.ts";
import { useT } from "@/lib/i18n.ts";

const ACTION_PILL =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors";
const ACTION_IDLE = "border-line text-ink-2 hover:border-accent hover:text-accent";

/** Copy-to-clipboard action pill (share card, map coordinates).  The
    confirmation comes from the shared green flashToast — one copy feedback
    language app-wide; the pill itself keeps no copied state. */
export function CopyButton({
  value,
  label,
  icon,
  className,
}: {
  value: string;
  label?: string;
  icon?: ReactNode;
  className?: string;
}) {
  const t = useT();
  const copyToast = useCopyToast();
  return (
    <button
      className={`${ACTION_PILL} ${ACTION_IDLE} ${className ?? ""}`}
      onClick={() => {
        copyToast(value);
      }}
      type="button"
    >
      {icon}
      {label ?? t("copy")}
    </button>
  );
}

/** Click-to-copy wrapper: the content itself is the copy trigger — click
    (or Enter/Space) copies and the green flashToast confirms.  Hover shows
    the copy hint as a cursor + tooltip so the affordance costs no layout. */
export function ClickToCopy({
  value,
  className = "",
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const t = useT();
  const copyToast = useCopyToast();
  return (
    <div
      aria-label={t("copy")}
      className={`cursor-pointer ${className}`}
      onClick={() => {
        copyToast(value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          copyToast(value);
        }
      }}
      role="button"
      tabIndex={0}
      title={t("copy")}
    >
      {children}
    </div>
  );
}
