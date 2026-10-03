// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { BookOpen } from "lucide-react";
import { useState } from "react";
import {
  CallContent,
  CallResults,
  CallRowShell,
  DebugPanes,
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

/** The web_reader row: the read url and its character count, ONE LINE
    folded like a search row -- the reading pane (what was read, capped
    scroll) opens on click, beside the debug panes (raw arguments + the
    model's receipt) and any colliding result sources.  A long read must
    not push the timeline around uninvited. */
export function PageRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rawArgs = rawArgsOf(call);
  // web_reader rows never expand for call text (the shared hasText rule
  // excludes them) -- the fold triggers are the reading pane, the raw
  // arguments, the model receipt and colliding result sources
  const expandable = Boolean(call.text) || results.length > 0 || rawArgs !== null || Boolean(call.feed);
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
      {open && expandable ? (
        <>
          {/* the READING PANE first: what the model actually read (the
              row's point), then the debug contract */}
          {call.text ? <CallContent call={call} /> : null}
          <DebugPanes call={call} rawArgs={rawArgs} />
          <CallResults results={results} />
        </>
      ) : null}
    </div>
  );
}
