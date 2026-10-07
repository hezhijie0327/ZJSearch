// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import { TOOL_VIEWS } from "@/features/results/aiSearch/calls/registry.ts";
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

/**
 * The ONE tool-call row kernel: state machine (chevron fold + debug
 * fold), the shared row shell, and the collapse wiring -- identical for
 * every tool kind.  The per-tool vocabulary comes from the settlement
 * view (`registry.ts`); adding a tool is one view file + one registry
 * entry, and an unknown tool falls back to the search view's shape.
 */

export function ToolRow({ call, results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [debug, setDebug] = useState(false);
  const view = TOOL_VIEWS[call.tool] ?? TOOL_VIEWS.web_search;
  const props = { call, results, t };
  const rawArgs = rawArgsOf(call);
  // DEBUG IS UNIVERSAL: every row exposes the raw arguments + the model's
  // receipt (a feed-bearing call of ANY kind renders its receipt -- the
  // old 7-vs-3 debug fork is gone)
  const debuggable = rawArgs !== null || Boolean(call.feed);
  const custom = view.Content?.(props) ?? null;
  const defaultBody = call.text ? (
    <CallContent call={call} />
  ) : results.length > 0 ? (
    <CallResults results={results} />
  ) : null;
  const body = custom ?? defaultBody;
  const expandable = view.expandable ? view.expandable(props) : body !== null;
  const always = view.alwaysContent?.(props) ?? null;
  // the settled tails (interrupted / duplicate / failed) are the kernel's
  // vocabulary; the view owns pending + ok
  const metric =
    call.status === "interrupted" || call.status === "duplicate" || call.status === "error"
      ? call.status === "error"
        ? settledCallText(call, t)
        : settledCallText(call, t)
      : view.metric(props);
  return (
    <div>
      <CallRowShell
        call={call}
        debuggable={debuggable}
        debugOpen={debug}
        expandable={expandable}
        icon={<view.Icon aria-hidden="true" className="size-3 shrink-0" />}
        label={view.label(props)}
        metric={metric ?? ""}
        onToggle={() => {
          setOpen(!open);
        }}
        onToggleDebug={() => {
          setDebug(!debug);
        }}
        open={open}
      />
      <Collapse className={debug ? "mt-1" : ""} open={debug && debuggable}>
        <DebugPanes call={call} rawArgs={rawArgs} />
      </Collapse>
      <Collapse className={open ? "mt-1" : ""} open={open && expandable}>
        {body}
      </Collapse>
      {always}
    </div>
  );
}

/** Re-exported for the registry's default-body parity check. */
export type { AiSearchCall, AiSearchSource };
