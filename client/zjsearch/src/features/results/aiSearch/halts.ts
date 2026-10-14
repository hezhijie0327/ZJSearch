// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
// Server settle-halt KEYS -> i18n. The server emits machine keys for its
// user-facing terminal states (loop.py's _STOP_HALT / _WRAP_HALT); the
// client owns the wording (the theme's i18n doctrine). Unknown values --
// transport error messages, legacy stored Chinese strings -- render
// verbatim, so old threads keep reading fine.
import type { StringKey, Translate } from "@/lib/i18n";

const HALT_KEYS = {
  stopped_by_user: "ai_halt_stopped_by_user",
  wrap_grace_ended: "ai_halt_wrap_grace_ended",
} as const satisfies Record<string, StringKey>;

export function haltText(halt: string, t: Translate): string {
  const key = HALT_KEYS[halt as keyof typeof HALT_KEYS];
  return key ? t(key) : halt;
}
