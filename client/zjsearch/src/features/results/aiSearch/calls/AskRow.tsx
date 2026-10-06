// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { Collapse } from "@/components/Collapse.tsx";
import { CallRowShell, DebugArgs, rawArgsOf, settledCallText } from "@/features/results/aiSearch/calls/rowBase.tsx";
import type { AiSearchCall, AiSearchSource } from "@/features/results/aiSearch/useAiSearch.ts";
import { useT } from "@/lib/i18n.ts";

/** The ask_user row: the rendered QUESTIONS (each with its options as a
    muted option line) fold open under the chevron -- the spec the user
    answered; the bug chip reveals the raw arguments.  The ANSWERED
    direction renders as the clarify archive segment and the rail's
    confirmed-direction card. */
export function AskRow({ call, results: _results }: { call: AiSearchCall; results: AiSearchSource[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [debug, setDebug] = useState(false);
  const rawArgs = rawArgsOf(call);
  const intro = typeof call.args?.intro === "string" ? call.args.intro : "";
  const questions = (Array.isArray(call.args?.questions) ? call.args.questions : []) as Array<{
    q?: unknown;
    options?: unknown;
  }>;
  const expandable = Boolean(intro) || questions.length > 0;
  const debuggable = rawArgs !== null;
  return (
    <div>
      <CallRowShell
        call={call}
        debuggable={debuggable}
        debugOpen={debug}
        expandable={expandable}
        icon={<MessageCircleQuestion aria-hidden="true" className="size-3 shrink-0" />}
        label={call.q || t("ai_ask_row")}
        metric={call.status === "pending" ? t("ai_ask_awaiting") : call.status === "ok" ? "" : settledCallText(call, t)}
        onToggle={() => {
          setOpen(!open);
        }}
        onToggleDebug={() => {
          setDebug(!debug);
        }}
        open={open}
      />
      <Collapse className={debug ? "mt-1" : ""} open={debug && debuggable}>
        {debuggable ? <DebugArgs rawArgs={rawArgs} /> : null}
      </Collapse>
      <Collapse className={open ? "mt-1" : ""} open={open && expandable}>
        <div className={`space-y-1.5 bg-surface-2/50 px-2.5 py-2`}>
          {intro ? (
            <p className="break-words text-[13px] leading-relaxed text-ink-2" dir="auto">
              {intro}
            </p>
          ) : null}
          {questions.map((question, index) => (
            <div key={index}>
              <p className="break-words text-[13px] text-ink" dir="auto">
                {String(question.q ?? "")}
              </p>
              <p className="break-words text-xs text-ink-3" dir="auto">
                {(Array.isArray(question.options) ? question.options : []).map(String).join("  ·  ")}
              </p>
            </div>
          ))}
        </div>
      </Collapse>
    </div>
  );
}
