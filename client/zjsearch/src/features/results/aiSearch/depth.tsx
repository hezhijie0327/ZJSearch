// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Gauge, Telescope, Zap } from "lucide-react";
import { Dropdown } from "@/components/Dropdown.tsx";
import type { AiSearchMode } from "@/features/results/aiSearch/useAiSearch.ts";
import type { Translate } from "@/lib/i18n.ts";
import { useT } from "@/lib/i18n.ts";

/** The valid research depths, in wire order -- the single source of
    truth for parsing the `mode` URL param.  THREE user-facing tiers
    (极速/均衡/深度调研): the deep tier's output FORMAT (报告=outline
    document / 演示文稿=slide deck) is decided INSIDE the run at the
    rail's 输出结构 picker, not in the composer.  The wire forms are
    `mode: "deep"` + `report: true` / `deck: true` (see useAiSearch's
    body); legacy `?mode=deck` URLs keep parsing.  Server-side mirror:
    SEARCH_MODES in runs/profile.py (the three research depths; the
    report/deck flags are the output shapes on top). */
const DEPTH_MODES: readonly AiSearchMode[] = ["speed", "balanced", "report", "deck"];

/** Parse a raw `mode` param: anything unknown falls back to balanced.
    Legacy `?mode=deck` URLs keep landing on deep + the deck format. */
export function parseDepthMode(raw: string | null | undefined): AiSearchMode {
  return DEPTH_MODES.includes(raw as AiSearchMode) ? (raw as AiSearchMode) : "balanced";
}

/** True when the mode sits in the deep tier (either output shape). */
export function isDeepMode(mode: AiSearchMode): boolean {
  return mode === "report" || mode === "deck";
}

/**
 * The research-depth dropdown's three tiers: Zap = the quick pass,
 * Gauge = the middle setting, Telescope = DEEP RESEARCH (the
 * outline-driven machinery behind both the report and the deck
 * formats).  The labels carry the expectation -- a deep run is a
 * purchase.
 */
export function depthOptions(t: Translate) {
  return [
    { value: "speed", label: t("mode_speed"), icon: <Zap className="size-3.5 text-ink-3" /> },
    { value: "balanced", label: t("mode_balanced"), icon: <Gauge className="size-3.5 text-ink-3" /> },
    { value: "deep", label: t("mode_deep"), icon: <Telescope className="size-3.5 text-ink-3" /> },
  ];
}

/**
 * The research-depth dropdown shared by the homepage hero and the
 * follow-up composers: THREE tiers (极速/均衡/深度调研).  The output
 * FORMAT (报告|演示文稿) is NOT a composer concern anymore -- it is
 * decided inside the run at the rail's 输出结构 picker (智能报告 /
 * 智能PPT / deck templates flip the shape with a confirmed steer), so
 * the composer asks only HOW DEEP.  The wire mode union and the `mode`
 * URL param are unchanged -- legacy `?mode=deck` still lands on a deck
 * run. */
export function DepthControls({ mode, onChange }: { mode: AiSearchMode; onChange: (mode: AiSearchMode) => void }) {
  const t = useT();
  return (
    <Dropdown
      ariaLabel={t("research_mode")}
      onChange={(value) => {
        // the deep tier keeps the wire shape that was showing (a first
        // entry from speed/balanced lands on the report format)
        onChange(value === "speed" || value === "balanced" ? value : isDeepMode(mode) ? mode : "report");
      }}
      options={depthOptions(t)}
      value={isDeepMode(mode) ? "deep" : mode}
    />
  );
}
