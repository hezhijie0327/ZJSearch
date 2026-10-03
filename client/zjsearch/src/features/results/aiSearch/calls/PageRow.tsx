// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookOpen } from "lucide-react";
import { useState } from "react";
import {
  CallContent,
  CallResults,
  CallRowShell,
  DebugArgs,
  rawArgsOf,
  settledCallText,
} from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { AiSearchCall, AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";

/** Compact label for an web_reader row: host + trimmed path -- the url is
    what identifies the read (two pages on one site must look different);
    a malformed url shows as-is. */
function pageLabel(url: string | undefined): string {
  if (!url) {
    return "?";
  }
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname + parsed.search;
    return parsed.hostname + path;
  } catch {
    return url;
  }
}

/** The web_reader row: the read url and its character count.  The reading
    pane NEVER folds -- a settled read shows its content right under the
    row (scroll-capped inside CallContent); a second click to see what was
    read is friction.  A read can still grow a chevron when result sources
    collide with its call position (the shared expandable formula), and
    then folds open like any row. */
export function PageRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rawArgs = rawArgsOf(call);
  // web_reader rows never expand for call text (the shared hasText rule
  // excludes them) nor for raw arguments (!isPage) -- the only fold
  // trigger left is colliding result sources
  const expandable = results.length > 0;
  return (
    <div>
      <CallRowShell
        call={call}
        expandable={expandable}
        icon={<BookOpen aria-hidden="true" className="size-3 shrink-0" />}
        label={pageLabel(call.url)}
        metric={
          call.status === "pending"
            ? t("ai_page_reading")
            : call.status === "ok"
              ? t("ai_page_chars", { n: String(call.chars ?? 0) })
              : settledCallText(call, t)
        }
        onToggle={() => {
          setOpen(!open);
        }}
        open={open}
      />
      {/* the reading pane NEVER folds: a settled read shows its content
          right under the row (scroll-capped inside CallContent) */}
      {call.text ? <CallContent call={call} /> : null}
      {open && expandable ? (
        <>
          {rawArgs ? <DebugArgs rawArgs={rawArgs} /> : null}
          <CallResults results={results} />
        </>
      ) : null}
    </div>
  );
}
