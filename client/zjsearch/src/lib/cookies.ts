// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Single home for reading browser cookies (theme style, default
    categories, ...). Writing stays with the server / upstream forms. */
export function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; *)${name}=([^;]*)`));
  return match?.[1] ?? null;
}
