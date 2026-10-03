// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Gauge, Telescope, Zap } from "lucide-react";
import type { DropdownOption } from "@/components/Dropdown.tsx";
import type { AiSearchMode } from "@/features/results/aiSearch/useAiSearch.ts";
import type { Translate } from "@/lib/i18n.ts";

/** The valid research depths, in dropdown order -- the single source of
    truth for parsing the `mode` URL param (server-side mirror:
    SEARCH_MODES in searx/zjsearch/ai/runtime/profile.py). */
const DEPTH_MODES: readonly AiSearchMode[] = ["speed", "balanced", "deep"];

/** Parse a raw `mode` param: anything unknown falls back to balanced. */
export function parseDepthMode(raw: string | null | undefined): AiSearchMode {
  return DEPTH_MODES.includes(raw as AiSearchMode) ? (raw as AiSearchMode) : "balanced";
}

/**
 * The research-depth dropdown options, shared by the homepage hero and the
 * follow-up pill: Zap = the quick pass, Gauge = the middle setting,
 * Telescope = the ~10-minute deep research (the label carries the
 * expectation -- a deep run is a purchase), Target = iterate until the
 * user's stated goal is demonstrably met.
 */
export function depthOptions(t: Translate): DropdownOption[] {
  return [
    { value: "speed", label: t("mode_speed"), icon: <Zap className="size-3.5 text-ink-3" /> },
    { value: "balanced", label: t("mode_balanced"), icon: <Gauge className="size-3.5 text-ink-3" /> },
    { value: "deep", label: t("mode_deep"), icon: <Telescope className="size-3.5 text-ink-3" /> },
  ];
}
