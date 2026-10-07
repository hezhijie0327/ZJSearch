// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Gauge, Telescope, Zap } from "lucide-react";
import type { DropdownOption } from "@/components/Dropdown.tsx";
import type { AiSearchMode } from "@/features/results/aiSearch/useAiSearch.ts";
import type { Translate } from "@/lib/i18n.ts";

/** The valid research depths, in dropdown order -- the single source of
    truth for parsing the `mode` URL param.  THREE user-facing tiers: the
    deep tier IS the report shape (outline-driven document) -- its wire
    form is `mode: "deep"` + `report: true` (see useAiSearch's body).
    Server-side mirror: SEARCH_MODES in runs/profile.py (the three
    research depths; the report flag is the output shape on top). */
const DEPTH_MODES: readonly AiSearchMode[] = ["speed", "balanced", "report"];

/** Parse a raw `mode` param: anything unknown falls back to balanced. */
export function parseDepthMode(raw: string | null | undefined): AiSearchMode {
  return DEPTH_MODES.includes(raw as AiSearchMode) ? (raw as AiSearchMode) : "balanced";
}

/**
 * The research-depth dropdown options, shared by the homepage hero and the
 * follow-up pill: Zap = the quick pass, Gauge = the middle setting,
 * Telescope = DEEP RESEARCH -- the report shape (outline-driven,
 * section-by-section document; the label carries the expectation -- a deep
 * run is a purchase).
 */
export function depthOptions(t: Translate): DropdownOption[] {
  return [
    { value: "speed", label: t("mode_speed"), icon: <Zap className="size-3.5 text-ink-3" /> },
    { value: "balanced", label: t("mode_balanced"), icon: <Gauge className="size-3.5 text-ink-3" /> },
    { value: "report", label: t("mode_report"), icon: <Telescope className="size-3.5 text-ink-3" /> },
  ];
}
