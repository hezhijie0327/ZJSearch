// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ShieldAlert } from "lucide-react";
import { ClickToCopy } from "@/components/CopyButton.tsx";
import { OnionIcon } from "@/components/OnionIcon.tsx";
import { UnitConverterAnswer } from "@/features/results/answers/UnitConverter.tsx";
import { useT } from "@/lib/i18n.ts";
import { hostnameOf, newTabLinkProps } from "@/lib/link.ts";
import { useSettings } from "@/lib/settings.ts";
import { MONO_CHIP } from "@/lib/styles.ts";
import type { AnswerData } from "@/lib/types.ts";

/** Special-query answers (random, statistics, hash, self-info, time zone,
    unit conversion, tor check) carry a structured *data* payload emitted by
    their plugins; the layouts below render strictly from those fields — no
    parsing of the localized *answer* text — and unknown payloads fall back
    to plain text. */
export function LegacyAnswer({ answer }: { answer: Extract<AnswerData, { template: "answer/legacy.html" }> }) {
  const settings = useSettings();
  const t = useT();
  const text = answer.answer;
  const data = answer.data;
  const hostname = answer.url ? hostnameOf(answer.url) : "";
  if (data?.kind === "unit_conversion") {
    return <UnitConverterAnswer data={data} />;
  }
  if (data?.kind === "tor_check") {
    if (data.status === "error") {
      return (
        <p className="flex items-center gap-2 text-sm text-danger">
          <ShieldAlert className="size-4 shrink-0" />
          {t("tor_check_failed")}
        </p>
      );
    }
    const usingTor = data.status === "using_tor";
    return (
      <div>
        <p className={`flex items-center gap-2 text-sm font-medium ${usingTor ? "text-ok" : "text-ink"}`}>
          <OnionIcon className="size-4 shrink-0" />
          {usingTor ? t("tor_using") : t("tor_not_using")}
        </p>
        {data.ip ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-3">
            <span>{t("tor_external_ip")}:</span>
            <ClickToCopy value={data.ip}>
              <span className={MONO_CHIP} dir="ltr">
                {data.ip}
              </span>
            </ClickToCopy>
          </div>
        ) : null}
        {data.nodes ? (
          <p className="mt-1 text-xs text-ink-3">
            {t("tor_exit_nodes")}: {data.nodes}
          </p>
        ) : null}
      </div>
    );
  }
  if (data?.kind === "hash") {
    return (
      <div>
        <span className={MONO_CHIP} dir="ltr">
          {data.algo}
        </span>
        <ClickToCopy className="mt-2" value={data.digest}>
          <p className="break-all font-mono text-sm text-ink-2" dir="ltr">
            {data.digest}
          </p>
        </ClickToCopy>
      </div>
    );
  }
  if (data?.kind === "stats") {
    return (
      <div>
        <p className="truncate text-xs text-ink-3" dir="ltr">
          <span className="font-mono font-medium text-accent">{data.func}</span>({data.args})
        </p>
        <ClickToCopy className="mt-1" value={data.result}>
          <p className="break-all text-4xl font-semibold text-ink" dir="ltr">
            {data.result}
          </p>
        </ClickToCopy>
      </div>
    );
  }
  if (data?.kind === "time") {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {data.zone ? (
            <p className="truncate font-mono text-xs text-ink-3" dir="ltr">
              {data.zone}
            </p>
          ) : null}
          <p className="mt-1 text-xl font-medium text-ink" dir="auto">
            {data.time}
          </p>
        </div>
        {data.abbr ? <span className={`${MONO_CHIP} shrink-0`}>{data.abbr}</span> : null}
      </div>
    );
  }
  if (data?.kind === "self") {
    return (
      <div>
        <p className="text-xs text-ink-3">{data.label}</p>
        <ClickToCopy className="mt-1" value={data.value}>
          <p className="min-w-0 break-all font-mono text-sm text-ink" dir="ltr">
            {data.value}
          </p>
        </ClickToCopy>
      </div>
    );
  }
  if (data?.kind === "value") {
    return (
      <div className="flex items-center gap-3">
        {data.swatch === "true" ? (
          <span className="size-10 shrink-0 rounded-xl border border-line" style={{ backgroundColor: data.value }} />
        ) : null}
        <ClickToCopy className="min-w-0 flex-1" value={data.value}>
          <p className="break-all font-mono text-sm text-ink" dir="ltr">
            {data.value}
          </p>
        </ClickToCopy>
      </div>
    );
  }
  return (
    <p className="text-sm leading-relaxed text-ink" dir="auto">
      {text}
      {answer.url ? (
        <a
          href={answer.url}
          {...newTabLinkProps(settings.results_on_new_tab)}
          className="ml-2 whitespace-nowrap text-xs text-accent hover:underline"
        >
          {hostname}
        </a>
      ) : null}
    </p>
  );
}
