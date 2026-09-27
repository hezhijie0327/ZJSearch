// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Gauge, Telescope, Zap } from "lucide-react";
import type { DropdownOption } from "@/components/Dropdown.tsx";
import type { Translate } from "@/lib/i18n.ts";

/**
 * The research-depth dropdown options, shared by the homepage hero and the
 * follow-up pill: Zap = the quick pass, Gauge = the middle setting,
 * Telescope = the deep-digging long look.
 */
export function depthOptions(t: Translate): DropdownOption[] {
  return [
    { value: "speed", label: t("mode_speed"), icon: <Zap className="size-3.5 text-ink-3" /> },
    { value: "balanced", label: t("mode_balanced"), icon: <Gauge className="size-3.5 text-ink-3" /> },
    { value: "quality", label: t("mode_quality"), icon: <Telescope className="size-3.5 text-ink-3" /> },
  ];
}
